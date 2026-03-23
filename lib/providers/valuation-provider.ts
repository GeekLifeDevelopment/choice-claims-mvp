import { getProviderTimeoutMs, getValuationProviderConfig } from './config'
import { logProviderHealth } from './provider-health-log'
import type { ValuationResult } from './types'

type ValuationApiResponse = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function getOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    const parsed = Number(trimmed.replace(/[$,]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function readNested(value: unknown, path: string[]): unknown {
  let current: unknown = value

  for (const segment of path) {
    const record = asRecord(current)
    current = record[segment]
    if (current === undefined || current === null) {
      return undefined
    }
  }

  return current
}

function firstPresent(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const candidate = readNested(value, path)
    if (candidate !== undefined && candidate !== null) {
      return candidate
    }
  }

  return undefined
}

function normalizeValuation(payload: ValuationApiResponse): ValuationResult {
  const estimatedValue = getOptionalNumber(
    firstPresent(payload, [
      ['estimatedValue'],
      ['estimated_value'],
      ['value'],
      ['valuation', 'estimatedValue'],
      ['data', 'estimatedValue']
    ])
  )

  const retailValue = getOptionalNumber(
    firstPresent(payload, [
      ['retailValue'],
      ['retail_value'],
      ['retail'],
      ['valuation', 'retailValue'],
      ['data', 'retailValue']
    ])
  )

  const tradeInValue = getOptionalNumber(
    firstPresent(payload, [
      ['tradeInValue'],
      ['trade_in_value'],
      ['tradeIn'],
      ['tradein'],
      ['valuation', 'tradeInValue'],
      ['data', 'tradeInValue']
    ])
  )

  const confidence = getOptionalNumber(
    firstPresent(payload, [
      ['confidence'],
      ['confidenceScore'],
      ['confidence_score'],
      ['valuation', 'confidence'],
      ['data', 'confidence']
    ])
  )

  const currency =
    getOptionalString(firstPresent(payload, [['currency'], ['currencyCode'], ['currency_code'], ['valuation', 'currency']])) ||
    'USD'

  const message =
    getOptionalString(
      firstPresent(payload, [['message'], ['note'], ['warning'], ['error'], ['valuation', 'message'], ['data', 'message']])
    ) || null

  return {
    source: 'valuation',
    fetchedAt: new Date().toISOString(),
    estimatedValue,
    retailValue,
    tradeInValue,
    confidence,
    currency,
    message
  }
}

function buildStubResult(vin: string, message?: string): ValuationResult {
  return {
    source: 'valuation_stub',
    fetchedAt: new Date().toISOString(),
    estimatedValue: null,
    retailValue: null,
    tradeInValue: null,
    confidence: null,
    currency: 'USD',
    message: message || `Valuation provider is not configured for VIN ${vin}.`
  }
}

function buildUrl(baseUrl: string, pathOrUrl: string): URL {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return new URL(pathOrUrl)
  }

  return new URL(pathOrUrl, `${normalizedBase}/`)
}

function applyAuth(url: URL, apiKey: string | null, apiSecret: string | null): void {
  if (apiKey && !url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', apiKey)
  }

  if (apiSecret && !url.searchParams.has('api_secret')) {
    url.searchParams.set('api_secret', apiSecret)
  }
}

function buildGenericValuationUrl(baseUrl: string, vin: string, apiKey: string | null): string {
  const url = new URL(baseUrl)
  if (!url.searchParams.has('vin')) {
    url.searchParams.set('vin', vin)
  }

  if (apiKey && !url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', apiKey)
  }

  return url.toString()
}

function buildMarketCheckValuationUrl(
  baseUrl: string,
  path: string,
  vin: string,
  apiKey: string,
  apiSecret: string | null
): string {
  const hasVinToken = path.includes('{vin}')
  const resolvedPath = hasVinToken ? path.replace('{vin}', encodeURIComponent(vin)) : path
  const url = buildUrl(baseUrl, resolvedPath)

  if (!hasVinToken && !url.searchParams.has('vin')) {
    url.searchParams.set('vin', vin)
  }

  applyAuth(url, apiKey, apiSecret)
  return url.toString()
}

function buildHeaders(apiKey: string | null, apiSecret: string | null): HeadersInit {
  return {
    Accept: 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}),
    ...(apiSecret ? { 'x-api-secret': apiSecret } : {})
  }
}

async function parseJsonSafe(response: Response): Promise<ValuationApiResponse | null> {
  try {
    return (await response.json()) as ValuationApiResponse
  } catch {
    return null
  }
}

export class ValuationProvider {
  async lookupValuation(vin: string): Promise<ValuationResult> {
    const config = getValuationProviderConfig()

    const shouldUseExplicitEndpoint = Boolean(config.apiUrl)
    const shouldUseMarketCheckEndpoint = Boolean(config.marketCheckPath && config.marketCheckApiKey)

    if (!shouldUseExplicitEndpoint && !shouldUseMarketCheckEndpoint) {
      logProviderHealth({
        provider: 'valuation',
        capability: 'valuation',
        event: 'unconfigured',
        mode: 'unconfigured',
        vin,
        reason: 'missing_valuation_endpoint'
      })

      return buildStubResult(vin)
    }

    logProviderHealth({
      provider: shouldUseExplicitEndpoint ? 'valuation' : 'marketcheck',
      capability: 'valuation',
      event: 'configured',
      mode: 'live',
      vin,
      source: shouldUseExplicitEndpoint ? 'valuation' : 'valuation_marketcheck'
    })

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const requestUrl = shouldUseExplicitEndpoint
        ? buildGenericValuationUrl(config.apiUrl as string, vin, config.apiKey)
        : buildMarketCheckValuationUrl(
            config.marketCheckBaseUrl,
            config.marketCheckPath as string,
            vin,
            config.marketCheckApiKey as string,
            config.marketCheckApiSecret
          )

      const requestHeaders = shouldUseExplicitEndpoint
        ? buildHeaders(config.apiKey, null)
        : buildHeaders(config.marketCheckApiKey, config.marketCheckApiSecret)

      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal
      })

      const payload = await parseJsonSafe(response)

      if (!response.ok || !payload) {
        logProviderHealth({
          provider: shouldUseExplicitEndpoint ? 'valuation' : 'marketcheck',
          capability: 'valuation',
          event: 'live_failure',
          mode: 'failed',
          vin,
          status: response.status,
          reason: 'http_error'
        })

        return buildStubResult(vin, `Valuation lookup failed (${response.status}).`)
      }

      const normalized = normalizeValuation(payload)

      if (
        normalized.estimatedValue === null &&
        normalized.retailValue === null &&
        normalized.tradeInValue === null &&
        !normalized.message
      ) {
        logProviderHealth({
          provider: shouldUseExplicitEndpoint ? 'valuation' : 'marketcheck',
          capability: 'valuation',
          event: 'capability_unavailable',
          mode: 'unavailable',
          vin,
          reason: 'no_valuation_fields'
        })

        return buildStubResult(vin, `Valuation capability not available for VIN ${vin} with current provider/account.`)
      }

      logProviderHealth({
        provider: shouldUseExplicitEndpoint ? 'valuation' : 'marketcheck',
        capability: 'valuation',
        event: 'live_success',
        mode: 'live',
        vin,
        source: normalized.source
      })

      return normalized
    } catch {
      logProviderHealth({
        provider: shouldUseExplicitEndpoint ? 'valuation' : 'marketcheck',
        capability: 'valuation',
        event: 'live_failure',
        mode: 'failed',
        vin,
        reason: 'request_exception'
      })

      return buildStubResult(vin, 'Valuation lookup request failed.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

import { getProviderTimeoutMs } from './config'
import type { ServiceHistoryEvent, ServiceHistoryResult } from './types'

const DEFAULT_MARKETCHECK_BASE_URL = 'https://api.marketcheck.com'

type ServiceHistoryApiResponse = Record<string, unknown>

function getServiceHistoryApiUrl(): string | null {
  const configured = process.env.SERVICE_HISTORY_API_URL?.trim()
  return configured || null
}

function getServiceHistoryApiKey(): string | null {
  const configured = process.env.SERVICE_HISTORY_API_KEY?.trim()
  return configured || null
}

function getMarketCheckServiceHistoryPath(): string | null {
  const configured = process.env.MARKETCHECK_SERVICE_HISTORY_PATH?.trim()
  return configured || null
}

function getMarketCheckBaseUrl(): string {
  return process.env.MARKETCHECK_BASE_URL?.trim() || DEFAULT_MARKETCHECK_BASE_URL
}

function getMarketCheckApiKey(): string | null {
  const configured = process.env.MARKETCHECK_API_KEY?.trim()
  return configured || null
}

function getMarketCheckApiSecret(): string | null {
  const configured = process.env.MARKETCHECK_API_SECRET?.trim()
  return configured || null
}

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

    const parsed = Number(trimmed)
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

function getServiceEventsCandidate(value: unknown): unknown {
  return firstPresent(value, [
    ['events'],
    ['serviceHistory'],
    ['service_history'],
    ['maintenanceEvents'],
    ['maintenanceHistory'],
    ['maintenance_history'],
    ['data', 'events'],
    ['data', 'serviceHistory'],
    ['data', 'service_history'],
    ['result', 'events'],
    ['result', 'serviceHistory'],
    ['result', 'service_history']
  ])
}

function hasServiceHistoryShape(value: unknown): boolean {
  const serviceEventsCandidate = getServiceEventsCandidate(value)
  if (Array.isArray(serviceEventsCandidate)) {
    return true
  }

  const record = asRecord(serviceEventsCandidate)
  return Object.keys(record).length > 0
}

function hasServiceHint(text: string | null): boolean {
  if (!text) {
    return false
  }

  const normalized = text.toLowerCase()
  return /(service|maintenance|repair|oil|tire|brake|inspection|alignment|flush|filter|rotation|tune|replace)/.test(
    normalized
  )
}

function normalizeEvents(value: unknown): ServiceHistoryEvent[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry): ServiceHistoryEvent | null => {
      const record = asRecord(entry)

      const eventDate =
        getOptionalString(record.eventDate) ||
        getOptionalString(record.date) ||
        getOptionalString(record.serviceDate) ||
        getOptionalString(record.performedAt)
      const mileage =
        getOptionalNumber(record.mileage) ??
        getOptionalNumber(record.odometer) ??
        getOptionalNumber(record.miles)
      const serviceType =
        getOptionalString(record.serviceType) ||
        getOptionalString(record.maintenanceType) ||
        getOptionalString(record.repairType) ||
        getOptionalString(record.category) ||
        getOptionalString(record.type)
      const description =
        getOptionalString(record.description) ||
        getOptionalString(record.summary) ||
        getOptionalString(record.notes) ||
        getOptionalString(record.detail)
      const shop =
        getOptionalString(record.shop) ||
        getOptionalString(record.dealer) ||
        getOptionalString(record.location) ||
        getOptionalString(record.serviceCenter)

      const isServiceLike =
        hasServiceHint(serviceType) ||
        hasServiceHint(description) ||
        Boolean(record.serviceType !== undefined || record.maintenanceType !== undefined || record.repairType !== undefined)

      if (!isServiceLike) {
        return null
      }

      if (!eventDate && mileage === null && !serviceType && !description && !shop) {
        return null
      }

      return {
        eventDate,
        mileage,
        serviceType,
        description,
        shop
      }
    })
    .filter((entry): entry is ServiceHistoryEvent => entry !== null)
}

function normalizeEventsFromUnknown(value: unknown): ServiceHistoryEvent[] {
  if (Array.isArray(value)) {
    return normalizeEvents(value)
  }

  const record = asRecord(value)
  if (Object.keys(record).length === 0) {
    return []
  }

  return normalizeEvents([record])
}

function getLatestMileage(payload: unknown, events: ServiceHistoryEvent[]): number | null {
  const explicit = getOptionalNumber(
    firstPresent(payload, [['latestMileage'], ['latest_mileage'], ['data', 'latestMileage'], ['result', 'latestMileage']])
  )
  if (explicit !== null) {
    return explicit
  }

  let maxMileage: number | null = null
  for (const event of events) {
    if (typeof event.mileage === 'number' && Number.isFinite(event.mileage)) {
      maxMileage = maxMileage === null ? event.mileage : Math.max(maxMileage, event.mileage)
    }
  }

  return maxMileage
}

function firstMessage(payload: unknown): string | null {
  return (
    getOptionalString(firstPresent(payload, [['message'], ['note'], ['warning'], ['error'], ['result', 'message'], ['data', 'message']])) ||
    null
  )
}

function normalizeLivePayload(payload: ServiceHistoryApiResponse): ServiceHistoryResult {
  const events = normalizeEventsFromUnknown(getServiceEventsCandidate(payload))

  return {
    source: 'service_history',
    fetchedAt: new Date().toISOString(),
    eventCount: events.length,
    latestMileage: getLatestMileage(payload, events),
    events,
    message: firstMessage(payload)
  }
}

function buildStubResult(vin: string, message?: string): ServiceHistoryResult {
  return {
    source: 'service_history_stub',
    fetchedAt: new Date().toISOString(),
    eventCount: 0,
    latestMileage: null,
    events: [],
    message: message || `Service history provider is not configured for VIN ${vin}.`
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

function buildGenericServiceHistoryUrl(baseUrl: string, vin: string, apiKey: string | null): string {
  const url = new URL(baseUrl)
  if (!url.searchParams.has('vin')) {
    url.searchParams.set('vin', vin)
  }

  if (apiKey && !url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', apiKey)
  }

  return url.toString()
}

function buildMarketCheckServiceHistoryUrl(
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

async function parseJsonSafe(response: Response): Promise<ServiceHistoryApiResponse | null> {
  try {
    return (await response.json()) as ServiceHistoryApiResponse
  } catch {
    return null
  }
}

function toUnsupportedCapabilityMessage(vin: string): string {
  return {
    message: `Service-history capability not available for VIN ${vin} with current provider/account.`
  }.message
}

export class ServiceHistoryProvider {
  async lookupServiceHistory(vin: string): Promise<ServiceHistoryResult> {
    const explicitApiUrl = getServiceHistoryApiUrl()
    const explicitApiKey = getServiceHistoryApiKey()

    const marketCheckPath = getMarketCheckServiceHistoryPath()
    const marketCheckApiKey = getMarketCheckApiKey()
    const marketCheckApiSecret = getMarketCheckApiSecret()
    const marketCheckBaseUrl = getMarketCheckBaseUrl()

    const shouldUseExplicitEndpoint = Boolean(explicitApiUrl)
    const shouldUseMarketCheckEndpoint = Boolean(marketCheckPath && marketCheckApiKey)

    if (!shouldUseExplicitEndpoint && !shouldUseMarketCheckEndpoint) {
      return buildStubResult(vin)
    }

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const requestUrl = shouldUseExplicitEndpoint
        ? buildGenericServiceHistoryUrl(explicitApiUrl as string, vin, explicitApiKey)
        : buildMarketCheckServiceHistoryUrl(
            marketCheckBaseUrl,
            marketCheckPath as string,
            vin,
            marketCheckApiKey as string,
            marketCheckApiSecret
          )

      const requestHeaders = shouldUseExplicitEndpoint
        ? buildHeaders(explicitApiKey, null)
        : buildHeaders(marketCheckApiKey, marketCheckApiSecret)

      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal
      })

      const payload = await parseJsonSafe(response)

      if (!response.ok || !payload) {
        return buildStubResult(vin, `Service history lookup failed (${response.status}).`)
      }

      if (!hasServiceHistoryShape(payload)) {
        return buildStubResult(vin, toUnsupportedCapabilityMessage(vin))
      }

      const normalized = normalizeLivePayload(payload)
      if (normalized.eventCount === 0 && !normalized.message) {
        return buildStubResult(vin, toUnsupportedCapabilityMessage(vin))
      }

      return normalized
    } catch {
      return buildStubResult(vin, 'Service history lookup request failed.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

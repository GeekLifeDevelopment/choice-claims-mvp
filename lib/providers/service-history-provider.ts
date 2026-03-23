import { getProviderTimeoutMs, getServiceHistoryProviderConfig } from './config'
import { logProviderHealth } from './provider-health-log'
import { getServiceProviderPriority, type ServiceProviderPriorityName } from './provider-priority'
import type { ServiceHistoryEvent, ServiceHistoryResult } from './types'

type ServiceHistoryApiResponse = Record<string, unknown>

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
    const config = getServiceHistoryProviderConfig()
    const explicitApiUrl = config.apiUrl
    const explicitApiKey = config.apiKey

    const marketCheckPath = config.marketCheckPath
    const marketCheckApiKey = config.marketCheckApiKey
    const marketCheckApiSecret = config.marketCheckApiSecret
    const marketCheckBaseUrl = config.marketCheckBaseUrl

    const priorities = getServiceProviderPriority()

    const lookupByPriority = async (providerName: Exclude<ServiceProviderPriorityName, 'stub'>): Promise<ServiceHistoryResult | null> => {
      const isExplicit = providerName === 'service'

      if (isExplicit && !explicitApiUrl) {
        logProviderHealth({
          provider: 'service_history',
          capability: 'service_history',
          event: 'unconfigured',
          mode: 'unconfigured',
          vin,
          reason: 'missing_service_history_api_url'
        })
        return null
      }

      if (!isExplicit && (!marketCheckPath || !marketCheckApiKey)) {
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'service_history',
          event: 'unconfigured',
          mode: 'unconfigured',
          vin,
          reason: 'missing_marketcheck_service_history_config'
        })
        return null
      }

      logProviderHealth({
        provider: isExplicit ? 'service_history' : 'marketcheck',
        capability: 'service_history',
        event: 'configured',
        mode: 'live',
        vin,
        reason: 'selected_by_priority',
        source: isExplicit ? 'service_history' : 'service_history_marketcheck'
      })

      const timeoutMs = getProviderTimeoutMs()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const requestUrl = isExplicit
          ? buildGenericServiceHistoryUrl(explicitApiUrl as string, vin, explicitApiKey)
          : buildMarketCheckServiceHistoryUrl(
              marketCheckBaseUrl,
              marketCheckPath as string,
              vin,
              marketCheckApiKey as string,
              marketCheckApiSecret
            )

        const requestHeaders = isExplicit
          ? buildHeaders(explicitApiKey, null)
          : buildHeaders(marketCheckApiKey, marketCheckApiSecret)

        const response = await fetch(requestUrl, {
          method: 'GET',
          headers: requestHeaders,
          signal: controller.signal
        })

        const payload = await parseJsonSafe(response)

        if (!response.ok || !payload) {
          logProviderHealth({
            provider: isExplicit ? 'service_history' : 'marketcheck',
            capability: 'service_history',
            event: 'live_failure',
            mode: 'failed',
            vin,
            status: response.status,
            reason: 'http_error'
          })

          return null
        }

        if (!hasServiceHistoryShape(payload)) {
          logProviderHealth({
            provider: isExplicit ? 'service_history' : 'marketcheck',
            capability: 'service_history',
            event: 'capability_unavailable',
            mode: 'unavailable',
            vin,
            reason: 'unsupported_payload_shape'
          })

          return null
        }

        const normalized = normalizeLivePayload(payload)
        if (normalized.eventCount === 0 && !normalized.message) {
          logProviderHealth({
            provider: isExplicit ? 'service_history' : 'marketcheck',
            capability: 'service_history',
            event: 'capability_unavailable',
            mode: 'unavailable',
            vin,
            reason: 'no_service_events'
          })

          return null
        }

        logProviderHealth({
          provider: isExplicit ? 'service_history' : 'marketcheck',
          capability: 'service_history',
          event: 'live_success',
          mode: 'live',
          vin,
          source: normalized.source
        })

        return normalized
      } catch {
        logProviderHealth({
          provider: isExplicit ? 'service_history' : 'marketcheck',
          capability: 'service_history',
          event: 'live_failure',
          mode: 'failed',
          vin,
          reason: 'request_exception'
        })

        return null
      } finally {
        clearTimeout(timeout)
      }
    }

    for (const providerName of priorities) {
      if (providerName === 'stub') {
        logProviderHealth({
          provider: 'service_history',
          capability: 'service_history',
          event: 'stub_fallback',
          mode: 'stub',
          vin,
          reason: 'priority_stub',
          source: 'service_history_stub'
        })
        return buildStubResult(vin)
      }

      const result = await lookupByPriority(providerName)
      if (result) {
        return result
      }
    }

    logProviderHealth({
      provider: 'service_history',
      capability: 'service_history',
      event: 'stub_fallback',
      mode: 'stub',
      vin,
      reason: 'all_priority_providers_unavailable_or_failed',
      source: 'service_history_stub'
    })

    return buildStubResult(vin, toUnsupportedCapabilityMessage(vin))
  }
}

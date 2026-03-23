import { getProviderTimeoutMs, getTitleHistoryProviderConfig } from './config'
import { logProviderHealth } from './provider-health-log'
import { getTitleProviderPriority } from './provider-priority'
import type { TitleHistoryEvent, TitleHistoryResult } from './types'

type TitleHistoryApiResponse = Record<string, unknown>

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

function getOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') {
      return true
    }
    if (normalized === 'false' || normalized === 'no' || normalized === '0') {
      return false
    }
  }

  return null
}

function firstBoolean(values: unknown[]): boolean | null {
  for (const value of values) {
    const parsed = getOptionalBoolean(value)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const parsed = getOptionalString(value)
    if (parsed) {
      return parsed
    }
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => getOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function normalizeStringListFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringList(value)
  }

  const fromDelimited = getOptionalString(value)
  if (!fromDelimited) {
    return []
  }

  return fromDelimited
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function normalizeEvents(value: unknown): TitleHistoryEvent[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry): TitleHistoryEvent | null => {
      const record = asRecord(entry)
      const type =
        getOptionalString(record.type) ||
        getOptionalString(record.eventType) ||
        getOptionalString(record.category)
      const summary =
        getOptionalString(record.summary) ||
        getOptionalString(record.description) ||
        getOptionalString(record.details) ||
        getOptionalString(record.note)

      if (!type || !summary) {
        return null
      }

      return {
        type,
        summary,
        eventDate:
          getOptionalString(record.eventDate) ||
          getOptionalString(record.date) ||
          getOptionalString(record.reportedAt) ||
          undefined,
        state:
          getOptionalString(record.state) ||
          getOptionalString(record.jurisdiction) ||
          getOptionalString(record.region) ||
          undefined
      }
    })
    .filter((entry): entry is TitleHistoryEvent => entry !== null)
}

function normalizeEventsFromUnknown(value: unknown): TitleHistoryEvent[] {
  if (Array.isArray(value)) {
    return normalizeEvents(value)
  }

  const record = asRecord(value)
  if (Object.keys(record).length === 0) {
    return []
  }

  return normalizeEvents([record])
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

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = getOptionalNumber(value)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function extractReportId(payload: TitleHistoryApiResponse): string | null {
  const direct = firstString([
    firstPresent(payload, [['reportId']]),
    firstPresent(payload, [['report_id']]),
    firstPresent(payload, [['reportUuid']]),
    firstPresent(payload, [['id']]),
    firstPresent(payload, [['data', 'reportId']]),
    firstPresent(payload, [['data', 'report_id']]),
    firstPresent(payload, [['data', 'id']]),
    firstPresent(payload, [['result', 'reportId']]),
    firstPresent(payload, [['result', 'report_id']]),
    firstPresent(payload, [['result', 'id']])
  ])

  return direct || null
}

function hasReportLikePayload(payload: TitleHistoryApiResponse): boolean {
  const events = firstPresent(payload, [
    ['events'],
    ['titleEvents'],
    ['history'],
    ['report', 'events'],
    ['data', 'events']
  ])

  const titleStatus = firstPresent(payload, [
    ['titleStatus'],
    ['status'],
    ['report', 'titleStatus'],
    ['data', 'titleStatus']
  ])

  return events !== undefined || titleStatus !== undefined
}

function normalizeHttpErrorReason(status: number | undefined): string {
  if (status === 400) {
    return 'http_400_bad_request'
  }

  if (status === 401) {
    return 'http_401_unauthorized'
  }

  if (status === 403) {
    return 'http_403_forbidden'
  }

  if (status === 404) {
    return 'http_404_not_found'
  }

  if (status === 429) {
    return 'http_429_rate_limited'
  }

  if (typeof status === 'number' && status >= 500) {
    return 'http_5xx_server_error'
  }

  return 'http_error'
}

function normalizeLivePayload(payload: TitleHistoryApiResponse): TitleHistoryResult {
  const titleStatus = firstString([
    firstPresent(payload, [['titleStatus']]),
    firstPresent(payload, [['status']]),
    firstPresent(payload, [['title', 'status']]),
    firstPresent(payload, [['data', 'titleStatus']]),
    firstPresent(payload, [['data', 'status']]),
    firstPresent(payload, [['report', 'titleStatus']]),
    firstPresent(payload, [['result', 'titleStatus']])
  ])

  const brandFlags = normalizeStringListFromUnknown(
    firstPresent(payload, [
      ['brandFlags'],
      ['titleBrands'],
      ['brands'],
      ['data', 'brandFlags'],
      ['result', 'brandFlags'],
      ['title', 'brandFlags']
    ])
  )

  const odometerFlags = normalizeStringListFromUnknown(
    firstPresent(payload, [
      ['odometerFlags'],
      ['odometerIssues'],
      ['odometerBrands'],
      ['data', 'odometerFlags'],
      ['result', 'odometerFlags'],
      ['title', 'odometerFlags']
    ])
  )

  const events = normalizeEventsFromUnknown(
    firstPresent(payload, [
      ['events'],
      ['titleEvents'],
      ['history'],
      ['title', 'events'],
      ['data', 'events'],
      ['result', 'events'],
      ['report', 'events']
    ])
  )

  const salvageIndicator = firstBoolean([
    firstPresent(payload, [['salvageIndicator']]),
    firstPresent(payload, [['salvage']]),
    firstPresent(payload, [['data', 'salvageIndicator']]),
    firstPresent(payload, [['title', 'salvage']])
  ])

  const junkIndicator = firstBoolean([
    firstPresent(payload, [['junkIndicator']]),
    firstPresent(payload, [['junk']]),
    firstPresent(payload, [['data', 'junkIndicator']]),
    firstPresent(payload, [['title', 'junk']])
  ])

  const rebuiltIndicator = firstBoolean([
    firstPresent(payload, [['rebuiltIndicator']]),
    firstPresent(payload, [['rebuilt']]),
    firstPresent(payload, [['data', 'rebuiltIndicator']]),
    firstPresent(payload, [['title', 'rebuilt']])
  ])

  const theftIndicator = firstBoolean([
    firstPresent(payload, [['theftIndicator']]),
    firstPresent(payload, [['theft']]),
    firstPresent(payload, [['data', 'theftIndicator']]),
    firstPresent(payload, [['title', 'theft']])
  ])

  const totalLossIndicator = firstBoolean([
    firstPresent(payload, [['totalLossIndicator']]),
    firstPresent(payload, [['totalLoss']]),
    firstPresent(payload, [['total_loss']]),
    firstPresent(payload, [['data', 'totalLossIndicator']]),
    firstPresent(payload, [['title', 'totalLoss']])
  ])

  const message = firstString([
    firstPresent(payload, [['message']]),
    firstPresent(payload, [['note']]),
    firstPresent(payload, [['error']]),
    firstPresent(payload, [['result', 'message']]),
    firstPresent(payload, [['data', 'message']]),
    firstPresent(payload, [['report', 'message']])
  ])

  const salvageFromBrandFlags = brandFlags.some((flag) => /salvage/i.test(flag))
  const junkFromBrandFlags = brandFlags.some((flag) => /junk/i.test(flag))
  const rebuiltFromBrandFlags = brandFlags.some((flag) => /rebuilt/i.test(flag))
  const theftFromBrandFlags = brandFlags.some((flag) => /theft|stolen/i.test(flag))
  const totalLossFromBrandFlags = brandFlags.some((flag) => /total\s*loss/i.test(flag))

  return {
    source: 'nmvtis',
    fetchedAt: new Date().toISOString(),
    titleStatus,
    brandFlags,
    odometerFlags,
    salvageIndicator: salvageIndicator ?? (salvageFromBrandFlags ? true : null),
    junkIndicator: junkIndicator ?? (junkFromBrandFlags ? true : null),
    rebuiltIndicator: rebuiltIndicator ?? (rebuiltFromBrandFlags ? true : null),
    theftIndicator: theftIndicator ?? (theftFromBrandFlags ? true : null),
    totalLossIndicator: totalLossIndicator ?? (totalLossFromBrandFlags ? true : null),
    events,
    message
  }
}

function buildStubResult(vin: string): TitleHistoryResult {
  return {
    source: 'nmvtis_stub',
    fetchedAt: new Date().toISOString(),
    titleStatus: null,
    brandFlags: [],
    odometerFlags: [],
    salvageIndicator: null,
    junkIndicator: null,
    rebuiltIndicator: null,
    theftIndicator: null,
    totalLossIndicator: null,
    events: [],
    message: `MarketCheck title history provider is not configured for VIN ${vin}.`
  }
}

function buildUrl(baseUrl: string, pathOrUrl: string): URL {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return new URL(pathOrUrl)
  }

  return new URL(pathOrUrl, `${normalizedBase}/`)
}

function applyAuth(url: URL, apiKey: string, apiSecret: string | null): void {
  if (!url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', apiKey)
  }

  if (apiSecret && !url.searchParams.has('api_secret')) {
    url.searchParams.set('api_secret', apiSecret)
  }
}

function buildGenerateUrl(baseUrl: string, path: string, vin: string, apiKey: string, apiSecret: string | null): string {
  const url = buildUrl(baseUrl, path)
  applyAuth(url, apiKey, apiSecret)

  if (!url.searchParams.has('vin')) {
    url.searchParams.set('vin', vin)
  }

  return url.toString()
}

function buildAccessUrl(
  baseUrl: string,
  path: string,
  reportId: string,
  apiKey: string,
  apiSecret: string | null
): string {
  const hasToken = path.includes('{reportId}')
  const resolvedPath = hasToken ? path.replace('{reportId}', encodeURIComponent(reportId)) : path
  const url = buildUrl(baseUrl, resolvedPath)
  applyAuth(url, apiKey, apiSecret)

  if (!hasToken && !url.searchParams.has('report_id') && !url.searchParams.has('reportId')) {
    url.searchParams.set('report_id', reportId)
  }

  return url.toString()
}

function buildHeaders(apiKey: string, apiSecret: string | null): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    Authorization: `Bearer ${apiKey}`,
    ...(apiSecret ? { 'x-api-secret': apiSecret } : {})
  }
}

async function parseJsonSafe(response: Response): Promise<TitleHistoryApiResponse | null> {
  try {
    return (await response.json()) as TitleHistoryApiResponse
  } catch {
    return null
  }
}

export class TitleHistoryProvider {
  async lookupTitleHistory(vin: string): Promise<TitleHistoryResult> {
    const config = getTitleHistoryProviderConfig()
    const apiKey = config.apiKey
    const apiSecret = config.apiSecret

    const priorities = getTitleProviderPriority()

    for (const providerName of priorities) {
      if (providerName === 'stub') {
        logProviderHealth({
          provider: 'title_history',
          capability: 'title_history',
          event: 'stub_fallback',
          mode: 'stub',
          vin,
          reason: 'priority_stub',
          source: 'nmvtis_stub'
        })

        return buildStubResult(vin)
      }

      if (!apiKey) {
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'title_history',
          event: 'unconfigured',
          mode: 'unconfigured',
          vin,
          reason: 'missing_marketcheck_api_key'
        })
        continue
      }

      const baseUrl = config.baseUrl
      const generatePath = config.generatePath
      const accessPath = config.accessPath

      logProviderHealth({
        provider: 'marketcheck',
        capability: 'title_history',
        event: 'configured',
        mode: 'live',
        vin,
        reason: 'selected_by_priority',
        source: 'nmvtis'
      })

      const timeoutMs = getProviderTimeoutMs()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const generateResponse = await fetch(buildGenerateUrl(baseUrl, generatePath, vin, apiKey, apiSecret), {
          method: 'POST',
          headers: buildHeaders(apiKey, apiSecret),
          body: JSON.stringify({ vin }),
          signal: controller.signal
        })

        const generatePayload = await parseJsonSafe(generateResponse)

        if (!generateResponse.ok) {
          const reason = normalizeHttpErrorReason(generateResponse.status)
          logProviderHealth({
            provider: 'marketcheck',
            capability: 'title_history',
            event: 'live_failure',
            mode: 'failed',
            vin,
            status: generateResponse.status,
            reason
          })

          continue
        }

        if (generatePayload && hasReportLikePayload(generatePayload)) {
          const result = normalizeLivePayload(generatePayload)
          logProviderHealth({
            provider: 'marketcheck',
            capability: 'title_history',
            event: 'live_success',
            mode: 'live',
            vin,
            source: result.source
          })

          return result
        }

        const reportId = generatePayload ? extractReportId(generatePayload) : null

        if (!reportId) {
          logProviderHealth({
            provider: 'marketcheck',
            capability: 'title_history',
            event: 'capability_unavailable',
            mode: 'unavailable',
            vin,
            reason: 'missing_report_id'
          })

          continue
        }

        const accessResponse = await fetch(buildAccessUrl(baseUrl, accessPath, reportId, apiKey, apiSecret), {
          method: 'GET',
          headers: buildHeaders(apiKey, apiSecret),
          signal: controller.signal
        })

        const accessPayload = await parseJsonSafe(accessResponse)

        if (!accessResponse.ok || !accessPayload) {
          const reason = normalizeHttpErrorReason(accessResponse.status)
          logProviderHealth({
            provider: 'marketcheck',
            capability: 'title_history',
            event: 'live_failure',
            mode: 'failed',
            vin,
            status: accessResponse.status,
            reason
          })

          continue
        }

        const result = normalizeLivePayload(accessPayload)
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'title_history',
          event: 'live_success',
          mode: 'live',
          vin,
          source: result.source
        })

        return result
      } catch {
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'title_history',
          event: 'live_failure',
          mode: 'failed',
          vin,
          reason: 'request_exception'
        })
      } finally {
        clearTimeout(timeout)
      }
    }

    logProviderHealth({
      provider: 'title_history',
      capability: 'title_history',
      event: 'stub_fallback',
      mode: 'stub',
      vin,
      reason: 'all_priority_providers_unavailable_or_failed',
      source: 'nmvtis_stub'
    })

    return buildStubResult(vin)
  }
}

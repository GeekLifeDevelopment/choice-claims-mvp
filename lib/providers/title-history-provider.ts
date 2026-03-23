import { getProviderTimeoutMs } from './config'
import type { TitleHistoryEvent, TitleHistoryResult } from './types'

const DEFAULT_TITLE_HISTORY_BASE_URL = 'https://example.invalid/nmvtis'

type TitleHistoryApiResponse = {
  titleStatus?: string
  brandFlags?: unknown[]
  odometerFlags?: unknown[]
  salvageIndicator?: unknown
  junkIndicator?: unknown
  rebuiltIndicator?: unknown
  theftIndicator?: unknown
  totalLossIndicator?: unknown
  events?: unknown[]
  message?: string
}

function getTitleHistoryApiUrl(): string | null {
  const configured = process.env.NMVTIS_TITLE_HISTORY_API_URL?.trim()
  if (configured) {
    return configured
  }

  const defaultDisabled = process.env.NMVTIS_TITLE_HISTORY_USE_DEFAULT === 'true'
  return defaultDisabled ? DEFAULT_TITLE_HISTORY_BASE_URL : null
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => getOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function normalizeEvents(value: unknown): TitleHistoryEvent[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry): TitleHistoryEvent | null => {
      const record = asRecord(entry)
      const type = getOptionalString(record.type) || getOptionalString(record.eventType)
      const summary = getOptionalString(record.summary) || getOptionalString(record.description)

      if (!type || !summary) {
        return null
      }

      return {
        type,
        summary,
        eventDate: getOptionalString(record.eventDate) ?? undefined,
        state: getOptionalString(record.state) ?? undefined
      }
    })
    .filter((entry): entry is TitleHistoryEvent => entry !== null)
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
    message: `Title history provider is not configured for VIN ${vin}.`
  }
}

function normalizeLivePayload(payload: TitleHistoryApiResponse): TitleHistoryResult {
  return {
    source: 'nmvtis',
    fetchedAt: new Date().toISOString(),
    titleStatus: getOptionalString(payload.titleStatus),
    brandFlags: normalizeStringList(payload.brandFlags),
    odometerFlags: normalizeStringList(payload.odometerFlags),
    salvageIndicator: getOptionalBoolean(payload.salvageIndicator),
    junkIndicator: getOptionalBoolean(payload.junkIndicator),
    rebuiltIndicator: getOptionalBoolean(payload.rebuiltIndicator),
    theftIndicator: getOptionalBoolean(payload.theftIndicator),
    totalLossIndicator: getOptionalBoolean(payload.totalLossIndicator),
    events: normalizeEvents(payload.events),
    message: getOptionalString(payload.message)
  }
}

function buildLiveLookupUrl(baseUrl: string, vin: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  const url = new URL(normalized)
  url.searchParams.set('vin', vin)
  return url.toString()
}

export class TitleHistoryProvider {
  async lookupTitleHistory(vin: string): Promise<TitleHistoryResult> {
    const baseUrl = getTitleHistoryApiUrl()
    if (!baseUrl) {
      return buildStubResult(vin)
    }

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(buildLiveLookupUrl(baseUrl, vin), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      })

      if (!response.ok) {
        return {
          ...buildStubResult(vin),
          message: `Title history lookup failed (${response.status}).`
        }
      }

      const payload = (await response.json()) as TitleHistoryApiResponse
      return normalizeLivePayload(payload)
    } catch {
      return {
        ...buildStubResult(vin),
        message: 'Title history lookup request failed.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

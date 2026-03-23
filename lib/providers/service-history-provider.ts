import { getProviderTimeoutMs } from './config'
import type { ServiceHistoryEvent, ServiceHistoryResult } from './types'

const DEFAULT_SERVICE_HISTORY_BASE_URL = 'https://example.invalid/service-history'

type ServiceHistoryApiResponse = {
  events?: unknown[]
  latestMileage?: unknown
  message?: unknown
}

function getServiceHistoryApiUrl(): string | null {
  const configured = process.env.SERVICE_HISTORY_API_URL?.trim()
  if (configured) {
    return configured
  }

  const defaultDisabled = process.env.SERVICE_HISTORY_USE_DEFAULT === 'true'
  return defaultDisabled ? DEFAULT_SERVICE_HISTORY_BASE_URL : null
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

function normalizeEvents(value: unknown): ServiceHistoryEvent[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry): ServiceHistoryEvent | null => {
      const record = asRecord(entry)

      const eventDate =
        getOptionalString(record.eventDate) || getOptionalString(record.date) || getOptionalString(record.serviceDate)
      const mileage = getOptionalNumber(record.mileage) ?? getOptionalNumber(record.odometer)
      const serviceType =
        getOptionalString(record.serviceType) ||
        getOptionalString(record.category) ||
        getOptionalString(record.type)
      const description =
        getOptionalString(record.description) || getOptionalString(record.summary) || getOptionalString(record.notes)
      const shop =
        getOptionalString(record.shop) || getOptionalString(record.dealer) || getOptionalString(record.location)

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

function buildStubResult(vin: string): ServiceHistoryResult {
  return {
    source: 'service_history_stub',
    fetchedAt: new Date().toISOString(),
    eventCount: 0,
    latestMileage: null,
    events: [],
    message: `Service history provider is not configured for VIN ${vin}.`
  }
}

function normalizeLivePayload(payload: ServiceHistoryApiResponse): ServiceHistoryResult {
  const events = normalizeEvents(payload.events)

  return {
    source: 'service_history',
    fetchedAt: new Date().toISOString(),
    eventCount: events.length,
    latestMileage: getOptionalNumber(payload.latestMileage),
    events,
    message: getOptionalString(payload.message)
  }
}

function buildLiveLookupUrl(baseUrl: string, vin: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  const url = new URL(normalized)
  url.searchParams.set('vin', vin)
  return url.toString()
}

export class ServiceHistoryProvider {
  async lookupServiceHistory(vin: string): Promise<ServiceHistoryResult> {
    const baseUrl = getServiceHistoryApiUrl()
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
          message: `Service history lookup failed (${response.status}).`
        }
      }

      const payload = (await response.json()) as ServiceHistoryApiResponse
      return normalizeLivePayload(payload)
    } catch {
      return {
        ...buildStubResult(vin),
        message: 'Service history lookup request failed.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

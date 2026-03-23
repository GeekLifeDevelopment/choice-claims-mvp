import { getMarketCheckRuntimeConfig, getProviderTimeoutMs } from './config'
import { logProviderHealth } from './provider-health-log'
import { ProviderLookupError, type ProviderErrorCode } from './provider-error'
import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'

type MarketCheckApiResponse = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
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

function createMarketCheckError(input: {
  code: ProviderErrorCode
  message: string
  status?: number
  reason?: string
  details?: string
}): ProviderLookupError {
  return new ProviderLookupError({
    provider: 'marketcheck',
    endpoint: 'decode',
    code: input.code,
    message: input.message,
    status: input.status,
    reason: input.reason,
    details: input.details
  })
}

function buildRequestUrl(baseUrl: string, vin: string, apiKey: string, apiSecret?: string | null): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const url = new URL(`${normalizedBase}/${encodeURIComponent(vin)}/specs`)
  url.searchParams.set('api_key', apiKey)
  if (apiSecret) {
    url.searchParams.set('api_secret', apiSecret)
  }
  return url.toString()
}

function getFirstObjectFromArray(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {}
  }

  for (const entry of value) {
    const candidate = asRecord(entry)
    if (Object.keys(candidate).length > 0) {
      return candidate
    }
  }

  return {}
}

function readField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return undefined
}

function extractVehicleRecord(payload: MarketCheckApiResponse): Record<string, unknown> {
  const root = asRecord(payload)
  const data = asRecord(root.data)
  const specs = asRecord(root.specs)
  const build = asRecord(root.build)
  const engine = asRecord(root.engine)

  const merged: Record<string, unknown> = {
    ...root,
    ...data,
    ...specs,
    ...build,
    ...engine
  }

  const dataList = getFirstObjectFromArray(root.data)
  const specsList = getFirstObjectFromArray(root.specs)

  return {
    ...merged,
    ...dataList,
    ...specsList
  }
}

function toBodyStyle(record: Record<string, unknown>): string | null {
  return toNullableString(readField(record, ['body_type', 'body_style', 'body']))
}

function toTransmission(record: Record<string, unknown>): string | null {
  return toNullableString(readField(record, ['transmission', 'transmission_type', 'trans']))
}

function toDrivetrain(record: Record<string, unknown>): string | null {
  return toNullableString(readField(record, ['drive_type', 'drivetrain']))
}

function toFuelType(record: Record<string, unknown>): string | null {
  return toNullableString(readField(record, ['fuel_type', 'fuel']))
}

function toEngineSize(record: Record<string, unknown>): string | null {
  const liters = toNullableString(readField(record, ['engine_size', 'engine_displacement', 'displacement']))
  const cylinders = toNullableString(readField(record, ['engine_cylinders', 'cylinders']))

  if (liters && cylinders) {
    return `${liters}L ${cylinders}`
  }

  return liters || null
}

function toShortErrorBody(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 300) : undefined
}

export class MarketCheckProviderLive implements VinDataProvider {
  readonly name = 'marketcheck' as const

  async lookupVinData(vin: string): Promise<VinDataResult> {
    const normalizedVin = vin.trim()

    if (!normalizedVin) {
      throw createMarketCheckError({
        code: 'provider_invalid_response',
        reason: 'vin_required',
        message: 'VIN is required for MarketCheck lookup'
      })
    }

    const config = getMarketCheckRuntimeConfig()
    const apiKey = config.apiKey
    const apiSecret = config.apiSecret
    const baseUrl = config.decodeApiUrl

    if (!apiKey) {
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'unconfigured',
        mode: 'unconfigured',
        vin: normalizedVin,
        reason: 'missing_marketcheck_api_key'
      })

      throw createMarketCheckError({
        code: 'missing_provider_config',
        reason: 'missing_marketcheck_api_key',
        message: 'MarketCheck provider is missing MARKETCHECK_API_KEY'
      })
    }

    logProviderHealth({
      provider: this.name,
      capability: 'vin_decode',
      event: 'configured',
      mode: 'live',
      vin: normalizedVin,
      source: 'marketcheck'
    })

    const timeoutMs = getProviderTimeoutMs()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(buildRequestUrl(baseUrl, normalizedVin, apiKey, apiSecret), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiSecret ? { 'x-api-secret': apiSecret } : {})
        },
        signal: controller.signal
      })

      if (!response.ok) {
        const bodyPreview = toShortErrorBody(await response.text())

        logProviderHealth({
          provider: this.name,
          capability: 'vin_decode',
          event: 'live_failure',
          mode: 'failed',
          vin: normalizedVin,
          status: response.status,
          reason: normalizeHttpErrorReason(response.status),
          details: bodyPreview
        })

        throw createMarketCheckError({
          code: 'provider_http_error',
          status: response.status,
          reason: normalizeHttpErrorReason(response.status),
          details: bodyPreview,
          message: `MarketCheck decode request failed with status ${response.status}`
        })
      }

      let payload: MarketCheckApiResponse

      try {
        payload = (await response.json()) as MarketCheckApiResponse
      } catch {
        throw createMarketCheckError({
          code: 'provider_invalid_response',
          reason: 'provider_invalid_json',
          message: 'MarketCheck decode response was invalid JSON'
        })
      }

      const vehicle = extractVehicleRecord(payload)

      const year = toNullableNumber(readField(vehicle, ['year', 'model_year']))
      const make = toNullableString(readField(vehicle, ['make']))
      const model = toNullableString(readField(vehicle, ['model']))

      if (year === null && !make && !model) {
        throw createMarketCheckError({
          code: 'provider_no_vehicle_data',
          reason: 'no_decode_result',
          message: 'No vehicle data returned from MarketCheck decode'
        })
      }

      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'live_success',
        mode: 'live',
        vin: normalizedVin,
        source: 'marketcheck'
      })

      return {
        vin: toNullableString(readField(vehicle, ['vin'])) ?? normalizedVin,
        year,
        make,
        model,
        trim: toNullableString(readField(vehicle, ['trim'])),
        bodyStyle: toBodyStyle(vehicle),
        drivetrain: toDrivetrain(vehicle),
        transmissionType: toTransmission(vehicle),
        engineSize: toEngineSize(vehicle),
        cylinders: toNullableString(readField(vehicle, ['engine_cylinders', 'cylinders'])),
        fuelType: toFuelType(vehicle),
        manufacturer: toNullableString(readField(vehicle, ['manufacturer', 'manufacturer_name', 'oem'])),
        providerResultCode: toNullableNumber(readField(vehicle, ['result_code', 'code', 'status'])),
        providerResultMessage: toNullableString(readField(vehicle, ['result_message', 'message', 'status_text'])),
        provider: this.name,
        raw: payload
      }
    } catch (error) {
      if (error instanceof ProviderLookupError) {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_decode',
          event: 'live_failure',
          mode: 'failed',
          vin: normalizedVin,
          status: error.status,
          reason: error.reason || error.code
        })

        throw error
      }

      if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
        logProviderHealth({
          provider: this.name,
          capability: 'vin_decode',
          event: 'live_failure',
          mode: 'failed',
          vin: normalizedVin,
          reason: 'provider_timeout'
        })

        throw createMarketCheckError({
          code: 'provider_timeout',
          reason: 'provider_timeout',
          message: `MarketCheck decode request timed out after ${timeoutMs}ms`
        })
      }

      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'live_failure',
        mode: 'failed',
        vin: normalizedVin,
        reason: 'request_exception'
      })

      throw createMarketCheckError({
        code: 'gateway_request_failed',
        reason: 'request_exception',
        message: 'MarketCheck decode request failed before response'
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

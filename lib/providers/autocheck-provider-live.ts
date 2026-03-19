import { fetchWithOAuth } from './authenticated-fetch'
import { randomUUID } from 'node:crypto'
import { getExperianOAuthConfig, getProviderTimeoutMs } from './config'
import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'

type AutoCheckVinSpecificationsVehicle = {
  vin?: string
  year?: number | string | null
  make?: string | null
  model?: string | null
  class?: string | null
  trim?: string | null
  country?: string | null
  bodyStyle?: string | null
  doors?: string | null
  drivetrain?: string | null
  transmissionType?: string | null
  wheelSize?: string | null
  engineSize?: string | null
  cylinders?: string | null
  horsepower?: string | null
  eventCount?: number | null
  resultCode?: number | null
  resultMessage?: string | null
}

type AutoCheckVinSpecificationsResponse = {
  vehicleCount?: number | null
  vehicle?: AutoCheckVinSpecificationsVehicle[] | null
  vinSpecifications?: {
    vehicleCount?: number | null
    vehicle?: AutoCheckVinSpecificationsVehicle[] | null
  } | null
}

function normalizeBaseUrl(value: string | null): string | null {
  if (!value) {
    return null
  }

  return value.replace(/\/+$/, '')
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
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

function buildGatewayHeaders(clientId: string): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Correlation-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'X-Client-Id': clientId
  }
}

export class AutoCheckProviderLive implements VinDataProvider {
  readonly name = 'autocheck' as const

  async lookupVinData(vin: string): Promise<VinDataResult> {
    const normalizedVin = vin.trim()

    if (!normalizedVin) {
      throw new Error('VIN is required for AutoCheck live lookup')
    }

    const experian = getExperianOAuthConfig()
    const baseUrl = normalizeBaseUrl(experian.baseUrl)

    if (!baseUrl || !experian.username || !experian.password || !experian.clientId || !experian.clientSecret) {
      throw new Error('AutoCheck live provider is not fully configured')
    }

    const timeoutMs = getProviderTimeoutMs()
    const tokenUrl = `${baseUrl}/oauth2/v1/token`
    const targetUrl = `${baseUrl}/automotive/accuselect/v1/vinspecifications?vinlist=${encodeURIComponent(normalizedVin)}`
    const gatewayUrl = `${baseUrl}/eits/gdp/v1/request?targeturl=${encodeURIComponent(targetUrl)}`

    let response

    try {
      response = await fetchWithOAuth<AutoCheckVinSpecificationsResponse>(
        {
          tokenUrl,
          username: experian.username,
          password: experian.password,
          clientId: experian.clientId,
          clientSecret: experian.clientSecret,
          cacheKey: 'experian-autocheck-oauth'
        },
        gatewayUrl,
        {
          method: 'GET',
          headers: buildGatewayHeaders(experian.clientId),
          signal: AbortSignal.timeout(timeoutMs)
        }
      )
    } catch (error) {
      if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
        throw new Error(`AutoCheck live request timed out after ${timeoutMs}ms`)
      }

      throw new Error('AutoCheck live request failed before response')
    }

    if (!response.ok) {
      if (response.error === 'missing_oauth_config') {
        throw new Error('AutoCheck live OAuth config is missing')
      }

      if (response.error === 'token_unavailable') {
        throw new Error('AutoCheck live OAuth token request failed')
      }

      if (response.error === 'request_failed') {
        throw new Error(`AutoCheck vinspecifications request failed with status ${response.status ?? 'unknown'}`)
      }

      throw new Error('AutoCheck vinspecifications response was invalid JSON')
    }

    const payload = response.data
    const resolvedPayload = payload.vinSpecifications ?? payload

    const vehicleCount = toNullableNumber(resolvedPayload.vehicleCount)
    const vehicle = Array.isArray(resolvedPayload.vehicle) ? resolvedPayload.vehicle[0] : null

    if (!vehicle || vehicleCount === 0) {
      throw new Error('AutoCheck vinspecifications returned no vehicle data')
    }

    const year = toNullableNumber(vehicle.year)
    const make = toNullableString(vehicle.make)
    const model = toNullableString(vehicle.model)

    return {
      vin: toNullableString(vehicle.vin) ?? normalizedVin,
      year,
      make,
      model,
      provider: this.name,
      raw: {
        vehicleCount,
        vehicle,
        source: payload.vinSpecifications ? 'vinSpecifications' : 'root',
        normalized: {
          trim: toNullableString(vehicle.trim),
          vehicleClass: toNullableString(vehicle.class),
          country: toNullableString(vehicle.country),
          bodyStyle: toNullableString(vehicle.bodyStyle),
          doors: toNullableString(vehicle.doors),
          drivetrain: toNullableString(vehicle.drivetrain),
          transmissionType: toNullableString(vehicle.transmissionType),
          wheelSize: toNullableString(vehicle.wheelSize),
          engineSize: toNullableString(vehicle.engineSize),
          cylinders: toNullableString(vehicle.cylinders),
          horsepower: toNullableString(vehicle.horsepower),
          eventCount: toNullableNumber(vehicle.eventCount),
          providerResultCode: toNullableNumber(vehicle.resultCode),
          providerResultMessage: toNullableString(vehicle.resultMessage)
        }
      }
    }
  }
}

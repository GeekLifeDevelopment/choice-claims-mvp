import { fetchWithOAuth } from './authenticated-fetch'
import { randomUUID } from 'node:crypto'
import { getExperianOAuthConfig, getExperianVinSpecsConfig, getProviderTimeoutMs } from './config'
import { ProviderLookupError } from './provider-error'
import type { ProviderErrorCode } from './provider-error'
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

type AutoCheckParsedPayload = {
  vehicleCount: number | null
  vehicle: AutoCheckVinSpecificationsVehicle | null
  source: 'root' | 'vinSpecifications' | 'data' | 'data.vinSpecifications'
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

function isAutoCheckDebugEnabled(): boolean {
  return process.env.AUTOCHECK_PROVIDER_DEBUG === 'true'
}

function logAutoCheckDebug(message: string, details?: unknown): void {
  if (!isAutoCheckDebugEnabled()) {
    return
  }

  if (details !== undefined) {
    console.info(`[AUTOCHECK_PROVIDER] ${message}`, details)
    return
  }

  console.info(`[AUTOCHECK_PROVIDER] ${message}`)
}

function buildAutoCheckUrls(baseUrl: string, vin: string, targetPath: string, queryParamName: string): {
  tokenUrl: string
  targetUrl: string
  gatewayUrl: string
  targetQueryParam: string
} {
  return buildAutoCheckUrlsWithParam(baseUrl, vin, targetPath, queryParamName)
}

function buildAutoCheckUrlsWithParam(baseUrl: string, vin: string, targetPath: string, queryParamName: string): {
  tokenUrl: string
  targetUrl: string
  gatewayUrl: string
  targetQueryParam: string
} {
  const tokenUrl = new URL('/oauth2/v1/token', `${baseUrl}/`).toString()

  const targetUrl = new URL(targetPath, `${baseUrl}/`)
  targetUrl.searchParams.set(queryParamName, vin)

  const gatewayUrl = new URL('/eits/gdp/v1/request', `${baseUrl}/`)
  gatewayUrl.searchParams.set('targeturl', targetUrl.toString())

  return {
    tokenUrl,
    targetUrl: targetUrl.toString(),
    gatewayUrl: gatewayUrl.toString(),
    targetQueryParam: queryParamName
  }
}

function getDecodedTargetUrl(gatewayUrl: string): string | null {
  try {
    const parsed = new URL(gatewayUrl)
    return parsed.searchParams.get('targeturl')
  } catch {
    return null
  }
}

function inspectGatewayUrlConstruction(baseUrl: string, gatewayUrl: string, decodedTargetUrl: string | null) {
  let hasTargetUrlParam = false
  let encodedTargetUrlLooksCorrect = false

  try {
    const parsedGateway = new URL(gatewayUrl)
    hasTargetUrlParam = parsedGateway.searchParams.has('targeturl')
    encodedTargetUrlLooksCorrect = parsedGateway.search.includes('targeturl=https%3A%2F%2F')
  } catch {
    hasTargetUrlParam = false
    encodedTargetUrlLooksCorrect = false
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) ?? baseUrl
  const baseUrlOccurrenceCount = decodedTargetUrl
    ? decodedTargetUrl.split(normalizedBaseUrl).length - 1
    : 0

  return {
    baseUrlDuplicatedInTarget: baseUrlOccurrenceCount > 1,
    missingAccuselectPath: !(decodedTargetUrl?.includes('/automotive/accuselect/v1') ?? false),
    wrongQueryParamName: !hasTargetUrlParam,
    incorrectTargetUrlEncoding: !encodedTargetUrlLooksCorrect
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readVehicleContainer(value: unknown): { vehicleCount: unknown; vehicle: unknown } {
  const record = asRecord(value)

  return {
    vehicleCount: record.vehicleCount,
    vehicle: record.vehicle
  }
}

function parseVehiclePayload(payload: unknown): AutoCheckParsedPayload | null {
  const root = readVehicleContainer(payload)

  if (root.vehicleCount !== undefined || root.vehicle !== undefined) {
    return {
      vehicleCount: toNullableNumber(root.vehicleCount),
      vehicle: Array.isArray(root.vehicle) ? (root.vehicle[0] as AutoCheckVinSpecificationsVehicle | undefined) ?? null : null,
      source: 'root'
    }
  }

  const payloadRecord = asRecord(payload)
  const vinSpecs = readVehicleContainer(payloadRecord.vinSpecifications)

  if (vinSpecs.vehicleCount !== undefined || vinSpecs.vehicle !== undefined) {
    return {
      vehicleCount: toNullableNumber(vinSpecs.vehicleCount),
      vehicle: Array.isArray(vinSpecs.vehicle) ? (vinSpecs.vehicle[0] as AutoCheckVinSpecificationsVehicle | undefined) ?? null : null,
      source: 'vinSpecifications'
    }
  }

  const dataContainer = readVehicleContainer(payloadRecord.data)

  if (dataContainer.vehicleCount !== undefined || dataContainer.vehicle !== undefined) {
    return {
      vehicleCount: toNullableNumber(dataContainer.vehicleCount),
      vehicle: Array.isArray(dataContainer.vehicle)
        ? (dataContainer.vehicle[0] as AutoCheckVinSpecificationsVehicle | undefined) ?? null
        : null,
      source: 'data'
    }
  }

  const nestedDataRecord = asRecord(payloadRecord.data)
  const nestedVinSpecs = readVehicleContainer(nestedDataRecord.vinSpecifications)

  if (nestedVinSpecs.vehicleCount !== undefined || nestedVinSpecs.vehicle !== undefined) {
    return {
      vehicleCount: toNullableNumber(nestedVinSpecs.vehicleCount),
      vehicle: Array.isArray(nestedVinSpecs.vehicle)
        ? (nestedVinSpecs.vehicle[0] as AutoCheckVinSpecificationsVehicle | undefined) ?? null
        : null,
      source: 'data.vinSpecifications'
    }
  }

  return null
}

function toShortBodyPreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 200) : undefined
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

function createAutoCheckError(input: {
  code: ProviderErrorCode
  message: string
  status?: number
  reason?: string
  details?: string
}): ProviderLookupError {
  return new ProviderLookupError({
    provider: 'autocheck',
    endpoint: 'vinspecifications',
    code: input.code,
    message: input.message,
    status: input.status,
    reason: input.reason,
    details: input.details
  })
}

export class AutoCheckProviderLive implements VinDataProvider {
  readonly name = 'autocheck' as const

  async lookupVinData(vin: string): Promise<VinDataResult> {
    const normalizedVin = vin.trim()

    if (!normalizedVin) {
      throw createAutoCheckError({
        code: 'provider_invalid_response',
        reason: 'vin_required',
        message: 'VIN is required for AutoCheck live lookup'
      })
    }

    const experian = getExperianOAuthConfig()
    const vinSpecs = getExperianVinSpecsConfig()
    const baseUrl = normalizeBaseUrl(experian.baseUrl)

    if (!baseUrl || !experian.username || !experian.password || !experian.clientId || !experian.clientSecret) {
      throw createAutoCheckError({
        code: 'missing_provider_config',
        reason: 'missing_experian_config',
        message: 'AutoCheck live provider is missing required Experian configuration'
      })
    }

    const timeoutMs = getProviderTimeoutMs()
    const { tokenUrl, gatewayUrl, targetQueryParam } = buildAutoCheckUrls(
      baseUrl,
      normalizedVin,
      vinSpecs.targetPath,
      vinSpecs.vinQueryParam
    )
    const decodedTargetUrl = getDecodedTargetUrl(gatewayUrl)

    logAutoCheckDebug('lookup starting', {
      provider: this.name,
      endpoint: 'vinspecifications',
      vin: normalizedVin,
      timeoutMs
    })

    logAutoCheckDebug('gateway request URL built', {
      gatewayUrl,
      decodedTargetUrl,
      targetQueryParam,
      targetPath: vinSpecs.targetPath,
      inspection: inspectGatewayUrlConstruction(baseUrl, gatewayUrl, decodedTargetUrl)
    })

    let response

    try {
      response = await fetchWithOAuth<AutoCheckVinSpecificationsResponse>(
        {
          tokenUrl,
          username: experian.username,
          password: experian.password,
          clientId: experian.clientId,
          clientSecret: experian.clientSecret,
          cacheKey: 'experian-autocheck-oauth',
          requestTimeoutMs: timeoutMs
        },
        gatewayUrl,
        {
          method: 'GET',
          headers: buildGatewayHeaders(experian.clientId),
          signal: AbortSignal.timeout(timeoutMs)
        }
      )
    } catch (error) {
      const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message)

      throw createAutoCheckError({
        code: isTimeout ? 'provider_timeout' : 'gateway_request_failed',
        reason: isTimeout ? 'gateway_timeout' : 'gateway_request_exception',
        message: isTimeout
          ? `AutoCheck vinspecifications request timed out after ${timeoutMs}ms`
          : 'AutoCheck vinspecifications request failed before response'
      })
    }

    if (!response.ok) {
      const detailsPreview = toShortBodyPreview(response.details)

      logAutoCheckDebug('gateway response received', {
        status: response.status ?? null,
        outcome: response.error,
        targetQueryParam,
        details: detailsPreview
      })

      if (response.error === 'missing_oauth_config') {
        throw createAutoCheckError({
          code: 'missing_provider_config',
          reason: 'missing_oauth_config',
          message: 'AutoCheck live provider OAuth configuration is missing'
        })
      }

      if (response.error === 'oauth_request_failed') {
        throw createAutoCheckError({
          code: 'oauth_request_failed',
          status: response.status,
          reason: 'oauth_request_failed',
          details: detailsPreview,
          message: 'AutoCheck OAuth token request failed'
        })
      }

      if (response.error === 'oauth_invalid_response') {
        throw createAutoCheckError({
          code: 'oauth_invalid_response',
          status: response.status,
          reason: 'oauth_invalid_response',
          details: detailsPreview,
          message: 'AutoCheck OAuth token response was invalid'
        })
      }

      if (response.error === 'provider_timeout') {
        throw createAutoCheckError({
          code: 'provider_timeout',
          reason: 'provider_timeout',
          details: detailsPreview,
          message: `AutoCheck vinspecifications request timed out after ${timeoutMs}ms`
        })
      }

      if (response.error === 'request_failed') {
        throw createAutoCheckError({
          code: 'provider_http_error',
          status: response.status,
          reason: normalizeHttpErrorReason(response.status),
          details: detailsPreview,
          message: `AutoCheck vinspecifications request failed with status ${response.status ?? 'unknown'}`
        })
      }

      throw createAutoCheckError({
        code: 'provider_invalid_response',
        status: response.status,
        reason: 'provider_invalid_json',
        message: 'AutoCheck vinspecifications response was invalid JSON'
      })
    }

    logAutoCheckDebug('gateway response received', { status: response.status })

    const payload = response.data as unknown
    const parsedPayload = parseVehiclePayload(payload)

    if (!parsedPayload) {
      throw createAutoCheckError({
        code: 'provider_invalid_response',
        reason: 'unexpected_payload_shape',
        message: 'AutoCheck vinspecifications response shape was not recognized'
      })
    }

    const { vehicleCount, vehicle, source } = parsedPayload

    if (!vehicle || vehicleCount === 0) {
      throw createAutoCheckError({
        code: 'provider_no_vehicle_data',
        reason: 'vehicle_missing_or_empty',
        message: 'No vehicle data returned from AutoCheck vinspecifications'
      })
    }

    const year = toNullableNumber(vehicle.year)
    const make = toNullableString(vehicle.make)
    const model = toNullableString(vehicle.model)

    const resultCode = toNullableNumber(vehicle.resultCode)
    const resultMessage = toNullableString(vehicle.resultMessage)
    const hasCoreVehicleData = year !== null || make !== null || model !== null

    if (!hasCoreVehicleData && resultCode !== null && resultCode !== 0) {
      throw createAutoCheckError({
        code: 'provider_no_vehicle_data',
        reason: 'result_code_indicates_no_data',
        message: 'No vehicle data returned from AutoCheck vinspecifications',
        details: resultMessage ?? undefined
      })
    }

    logAutoCheckDebug('lookup succeeded', {
      provider: this.name,
      endpoint: 'vinspecifications',
      vin: toNullableString(vehicle.vin) ?? normalizedVin,
      year,
      make,
      model,
      source
    })

    return {
      vin: toNullableString(vehicle.vin) ?? normalizedVin,
      year,
      make,
      model,
      provider: this.name,
      raw: {
        vehicleCount,
        vehicle,
        source,
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
          providerResultCode: resultCode,
          providerResultMessage: resultMessage
        }
      }
    }
  }
}

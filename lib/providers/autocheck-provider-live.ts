import { fetchWithOAuth } from './authenticated-fetch'
import { randomUUID } from 'node:crypto'
import { getExperianOAuthConfig, getExperianVinSpecsConfig, getProviderTimeoutMs } from './config'
import { logProviderHealth } from './provider-health-log'
import { ProviderLookupError } from './provider-error'
import type { ProviderErrorCode } from './provider-error'
import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'

const AUTOCHECK_BASE_PATH = '/automotive/accuselect/v1'

const OPTIONAL_ENDPOINT_TARGETS = {
  quickcheck: `${AUTOCHECK_BASE_PATH}/quickcheck`,
  ownershiphistory: `${AUTOCHECK_BASE_PATH}/ownershiphistory`,
  accident: `${AUTOCHECK_BASE_PATH}/accident`,
  mileage: `${AUTOCHECK_BASE_PATH}/mileage`,
  recall: `${AUTOCHECK_BASE_PATH}/recall`,
  titleproblem: `${AUTOCHECK_BASE_PATH}/titleproblem`,
  titlebrand: `${AUTOCHECK_BASE_PATH}/titlebrand`
} as const

type OptionalAutoCheckEndpointName = keyof typeof OPTIONAL_ENDPOINT_TARGETS

const OPTIONAL_ENDPOINT_ORDER: ReadonlyArray<OptionalAutoCheckEndpointName> = [
  'quickcheck',
  'ownershiphistory',
  'accident',
  'mileage',
  'recall',
  'titleproblem',
  'titlebrand'
]

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

type AutoCheckEndpointFailure = {
  code: ProviderErrorCode | 'provider_endpoint_failed'
  message: string
  reason: string
  status?: number
  details?: string
}

type AutoCheckEndpointResult =
  | {
      ok: true
      endpoint: string
      payload: unknown
    }
  | {
      ok: false
      endpoint: string
      failure: AutoCheckEndpointFailure
    }

type PrimitiveEntry = {
  path: string
  value: string | number | boolean
}

type EndpointErrorRecord = {
  message: string
  status?: number
  reason?: string
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
  targetUrl: string
  gatewayUrl: string
  targetQueryParam: string
} {
  return buildAutoCheckUrlsWithParam(baseUrl, vin, targetPath, queryParamName)
}

function buildAutoCheckUrlsWithParam(baseUrl: string, vin: string, targetPath: string, queryParamName: string): {
  targetUrl: string
  gatewayUrl: string
  targetQueryParam: string
} {
  const targetUrl = new URL(targetPath, `${baseUrl}/`)
  targetUrl.searchParams.set(queryParamName, vin)

  const gatewayUrl = new URL('/eits/gdp/v1/request', `${baseUrl}/`)
  gatewayUrl.searchParams.set('targeturl', targetUrl.toString())

  return {
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

function toEnrichmentSummaryKey(endpoint: OptionalAutoCheckEndpointName): keyof Pick<
  VinDataResult,
  'quickCheck' | 'ownershipHistory' | 'accident' | 'mileage' | 'recall' | 'titleProblem' | 'titleBrand'
> {
  if (endpoint === 'quickcheck') {
    return 'quickCheck'
  }

  if (endpoint === 'ownershiphistory') {
    return 'ownershipHistory'
  }

  if (endpoint === 'titleproblem') {
    return 'titleProblem'
  }

  if (endpoint === 'titlebrand') {
    return 'titleBrand'
  }

  return endpoint
}

function collectPrimitiveEntries(value: unknown, path: string, depth: number, entries: PrimitiveEntry[]): void {
  if (depth > 3 || value === null || value === undefined) {
    return
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    entries.push({ path, value })
    return
  }

  if (Array.isArray(value)) {
    entries.push({ path: `${path}Count`, value: value.length })

    const firstRecord = value.find((item) => item && typeof item === 'object')
    if (firstRecord) {
      collectPrimitiveEntries(firstRecord, `${path}Item`, depth + 1, entries)
    }

    return
  }

  const record = asRecord(value)
  for (const [key, child] of Object.entries(record)) {
    const nextPath = path ? `${path}.${key}` : key
    collectPrimitiveEntries(child, nextPath, depth + 1, entries)
  }
}

function normalizedPath(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function findPrimitiveEntry(entries: PrimitiveEntry[], requiredTokens: string[]): PrimitiveEntry | null {
  const normalizedTokens = requiredTokens.map((token) => token.toLowerCase())

  for (const entry of entries) {
    const path = normalizedPath(entry.path)
    const matches = normalizedTokens.every((token) => path.includes(token))

    if (matches) {
      return entry
    }
  }

  return null
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) {
      return false
    }

    if (value === 1) {
      return true
    }
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === 'y') {
      return true
    }

    if (normalized === 'false' || normalized === 'no' || normalized === 'n') {
      return false
    }
  }

  return null
}

function getCompactSummaryFromPayload(payload: unknown, endpoint: string): Record<string, string | number | boolean | null> | null {
  if (payload === null || payload === undefined) {
    return null
  }

  const entries: PrimitiveEntry[] = []
  collectPrimitiveEntries(payload, endpoint, 0, entries)

  const summary: Record<string, string | number | boolean | null> = {}
  const resultCodeEntry = findPrimitiveEntry(entries, ['result', 'code'])
  const resultMessageEntry = findPrimitiveEntry(entries, ['result', 'message'])

  if (resultCodeEntry && typeof resultCodeEntry.value === 'number') {
    summary.resultCode = resultCodeEntry.value
  }

  if (resultMessageEntry && typeof resultMessageEntry.value === 'string') {
    summary.resultMessage = resultMessageEntry.value.slice(0, 200)
  }

  for (const entry of entries) {
    const key = entry.path.split('.').pop() ?? entry.path

    if (!/(count|total|accident|owner|mileage|recall|brand|problem|title)/i.test(key)) {
      continue
    }

    if (Object.keys(summary).length >= 8) {
      break
    }

    if (summary[key] === undefined) {
      summary[key] = entry.value
    }
  }

  if (endpoint === 'quickcheck') {
    const hasAccident = toBoolean(findPrimitiveEntry(entries, ['accident'])?.value)
    const hasTitleBrand = toBoolean(findPrimitiveEntry(entries, ['title', 'brand'])?.value)
    const oneOwnerCandidate = findPrimitiveEntry(entries, ['owner'])

    let oneOwner: boolean | null = null
    if (oneOwnerCandidate) {
      if (typeof oneOwnerCandidate.value === 'number') {
        oneOwner = oneOwnerCandidate.value === 1
      } else {
        oneOwner = toBoolean(oneOwnerCandidate.value)
      }
    }

    if (hasAccident !== null || hasTitleBrand !== null || oneOwner !== null) {
      summary.hasAccident = hasAccident
      summary.hasTitleBrand = hasTitleBrand
      summary.oneOwner = oneOwner
    }
  }

  return Object.keys(summary).length > 0 ? summary : { hasData: true }
}

function toOptionalEndpointErrorRecord(failure: AutoCheckEndpointFailure): EndpointErrorRecord {
  return {
    message: failure.message,
    status: failure.status,
    reason: failure.reason
  }
}

function getDefaultEndpointTargetPath(endpoint: OptionalAutoCheckEndpointName): string {
  return OPTIONAL_ENDPOINT_TARGETS[endpoint]
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

  private async fetchEndpointPayload(input: {
    endpoint: string
    baseUrl: string
    vin: string
    targetPath: string
    queryParamName: string
    timeoutMs: number
    oauth: {
      tokenUrl: string
      username: string
      password: string
      clientId: string
      clientSecret: string
    }
  }): Promise<AutoCheckEndpointResult> {
    const { endpoint, baseUrl, vin, targetPath, queryParamName, timeoutMs, oauth } = input
    const { gatewayUrl, targetQueryParam } = buildAutoCheckUrls(
      baseUrl,
      vin,
      targetPath,
      queryParamName
    )
    const decodedTargetUrl = getDecodedTargetUrl(gatewayUrl)

    logAutoCheckDebug('gateway request URL built', {
      endpoint,
      gatewayUrl,
      decodedTargetUrl,
      targetQueryParam,
      targetPath,
      inspection: inspectGatewayUrlConstruction(baseUrl, gatewayUrl, decodedTargetUrl)
    })

    let response

    try {
      response = await fetchWithOAuth<unknown>(
        {
          tokenUrl: oauth.tokenUrl,
          username: oauth.username,
          password: oauth.password,
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          cacheKey: 'experian-autocheck-oauth',
          requestTimeoutMs: timeoutMs
        },
        gatewayUrl,
        {
          method: 'GET',
          headers: buildGatewayHeaders(oauth.clientId),
          signal: AbortSignal.timeout(timeoutMs)
        }
      )
    } catch (error) {
      const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message)

      return {
        ok: false,
        endpoint,
        failure: {
          code: isTimeout ? 'provider_timeout' : 'gateway_request_failed',
          reason: isTimeout ? `${endpoint}_timeout` : `${endpoint}_request_exception`,
          message: isTimeout
            ? `AutoCheck ${endpoint} request timed out after ${timeoutMs}ms`
            : `AutoCheck ${endpoint} request failed before response`
        }
      }
    }

    if (!response.ok) {
      const detailsPreview = toShortBodyPreview(response.details)

      logAutoCheckDebug('gateway response received', {
        endpoint,
        status: response.status ?? null,
        outcome: response.error,
        details: detailsPreview
      })

      if (response.error === 'missing_oauth_config') {
        return {
          ok: false,
          endpoint,
          failure: {
            code: 'missing_provider_config',
            reason: 'missing_oauth_config',
            message: 'AutoCheck live provider OAuth configuration is missing'
          }
        }
      }

      if (response.error === 'oauth_request_failed') {
        return {
          ok: false,
          endpoint,
          failure: {
            code: 'oauth_request_failed',
            status: response.status,
            reason: 'oauth_request_failed',
            details: detailsPreview,
            message: `AutoCheck OAuth token request failed during ${endpoint}`
          }
        }
      }

      if (response.error === 'oauth_invalid_response') {
        return {
          ok: false,
          endpoint,
          failure: {
            code: 'oauth_invalid_response',
            status: response.status,
            reason: 'oauth_invalid_response',
            details: detailsPreview,
            message: `AutoCheck OAuth token response was invalid during ${endpoint}`
          }
        }
      }

      if (response.error === 'provider_timeout') {
        return {
          ok: false,
          endpoint,
          failure: {
            code: 'provider_timeout',
            reason: 'provider_timeout',
            details: detailsPreview,
            message: `AutoCheck ${endpoint} request timed out after ${timeoutMs}ms`
          }
        }
      }

      if (response.error === 'request_failed') {
        return {
          ok: false,
          endpoint,
          failure: {
            code: 'provider_http_error',
            status: response.status,
            reason: normalizeHttpErrorReason(response.status),
            details: detailsPreview,
            message: `AutoCheck ${endpoint} request failed with status ${response.status ?? 'unknown'}`
          }
        }
      }

      return {
        ok: false,
        endpoint,
        failure: {
          code: 'provider_invalid_response',
          status: response.status,
          reason: 'provider_invalid_json',
          message: `AutoCheck ${endpoint} response was invalid JSON`
        }
      }
    }

    logAutoCheckDebug('gateway response received', { endpoint, status: response.status })

    return {
      ok: true,
      endpoint,
      payload: response.data as unknown
    }
  }

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
    const tokenUrl = experian.tokenUrl

    if (!baseUrl || !tokenUrl || !experian.username || !experian.password || !experian.clientId || !experian.clientSecret) {
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'unconfigured',
        mode: 'unconfigured',
        vin: normalizedVin,
        reason: 'missing_experian_config'
      })

      throw createAutoCheckError({
        code: 'missing_provider_config',
        reason: 'missing_experian_config',
        message: 'AutoCheck live provider is missing required Experian configuration'
      })
    }

    const timeoutMs = getProviderTimeoutMs()

    const oauthConfig = {
      tokenUrl,
      username: experian.username,
      password: experian.password,
      clientId: experian.clientId,
      clientSecret: experian.clientSecret
    }

    logAutoCheckDebug('lookup starting', {
      provider: this.name,
      endpoint: 'vinspecifications+enrichment',
      vin: normalizedVin,
      timeoutMs
    })

    const vinSpecsResult = await this.fetchEndpointPayload({
      endpoint: 'vinspecifications',
      baseUrl,
      vin: normalizedVin,
      targetPath: vinSpecs.targetPath,
      queryParamName: vinSpecs.vinQueryParam,
      timeoutMs,
      oauth: oauthConfig
    })

    if (!vinSpecsResult.ok) {
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'live_failure',
        mode: 'failed',
        vin: normalizedVin,
        reason: vinSpecsResult.failure.reason,
        status: vinSpecsResult.failure.status
      })

      throw createAutoCheckError({
        code: vinSpecsResult.failure.code === 'provider_endpoint_failed'
          ? 'gateway_request_failed'
          : vinSpecsResult.failure.code,
        status: vinSpecsResult.failure.status,
        reason: vinSpecsResult.failure.reason,
        details: vinSpecsResult.failure.details,
        message: vinSpecsResult.failure.message
      })
    }

    const payload = vinSpecsResult.payload as AutoCheckVinSpecificationsResponse
    const parsedPayload = parseVehiclePayload(payload)

    if (!parsedPayload) {
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'live_failure',
        mode: 'failed',
        vin: normalizedVin,
        reason: 'unexpected_payload_shape'
      })

      throw createAutoCheckError({
        code: 'provider_invalid_response',
        reason: 'unexpected_payload_shape',
        message: 'AutoCheck vinspecifications response shape was not recognized'
      })
    }

    const { vehicleCount, vehicle, source } = parsedPayload

    if (!vehicle || vehicleCount === 0) {
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'capability_unavailable',
        mode: 'unavailable',
        vin: normalizedVin,
        reason: 'vehicle_missing_or_empty'
      })

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
      logProviderHealth({
        provider: this.name,
        capability: 'vin_decode',
        event: 'capability_unavailable',
        mode: 'unavailable',
        vin: normalizedVin,
        reason: 'result_code_indicates_no_data'
      })

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

    const rawByEndpoint: Record<string, unknown> = {
      vinspecifications: payload
    }
    const endpointErrors: Record<string, EndpointErrorRecord> = {}

    const enrichmentSummary: Pick<
      VinDataResult,
      'quickCheck' | 'ownershipHistory' | 'accident' | 'mileage' | 'recall' | 'titleProblem' | 'titleBrand'
    > = {}

    for (const endpoint of OPTIONAL_ENDPOINT_ORDER) {
      const endpointResult = await this.fetchEndpointPayload({
        endpoint,
        baseUrl,
        vin: normalizedVin,
        targetPath: getDefaultEndpointTargetPath(endpoint),
        queryParamName: vinSpecs.vinQueryParam,
        timeoutMs,
        oauth: oauthConfig
      })

      if (!endpointResult.ok) {
        endpointErrors[endpoint] = toOptionalEndpointErrorRecord(endpointResult.failure)
        logAutoCheckDebug('optional enrichment endpoint failed', {
          endpoint,
          reason: endpointResult.failure.reason,
          status: endpointResult.failure.status,
          message: endpointResult.failure.message
        })
        continue
      }

      rawByEndpoint[endpoint] = endpointResult.payload

      const summary = getCompactSummaryFromPayload(endpointResult.payload, endpoint)
      const summaryKey = toEnrichmentSummaryKey(endpoint)
      if (summary) {
        enrichmentSummary[summaryKey] = summary
      }
    }

    if (Object.keys(endpointErrors).length > 0) {
      rawByEndpoint.endpointErrors = endpointErrors
    }

    logProviderHealth({
      provider: this.name,
      capability: 'vin_decode',
      event: 'live_success',
      mode: 'live',
      vin: toNullableString(vehicle.vin) ?? normalizedVin,
      source: this.name
    })

    return {
      vin: toNullableString(vehicle.vin) ?? normalizedVin,
      year,
      make,
      model,
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
      providerResultMessage: resultMessage,
      ...enrichmentSummary,
      provider: this.name,
      raw: rawByEndpoint
    }
  }
}

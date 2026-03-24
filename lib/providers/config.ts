export const DEFAULT_VIN_PROVIDER_TIMEOUT_MS = 10_000
export const DEFAULT_OPENAI_TIMEOUT_MS = 15_000
export const DEFAULT_MARKETCHECK_BASE_URL = 'https://api.marketcheck.com'
export const DEFAULT_MARKETCHECK_DECODE_BASE_URL = 'https://api.marketcheck.com/v2/decode/car'
export const DEFAULT_MARKETCHECK_TITLE_HISTORY_GENERATE_PATH = '/v2/vindata/aamva/report/generate'
export const DEFAULT_MARKETCHECK_TITLE_HISTORY_ACCESS_PATH = '/v2/vindata/aamva/report/{reportId}'
export const DEFAULT_MARKETCHECK_VALUATION_PATH = '/v2/predict/car/price'
export const DEFAULT_NHTSA_RECALLS_BASE_URL = 'https://api.nhtsa.gov'
export const DEFAULT_VIN_SPEC_FALLBACK_BASE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles'

export type ProviderCredentialConfig = {
  apiKey: string | null
  apiUrl: string | null
}

export type ProviderConfigStatus = {
  carfaxConfigured: boolean
  autoCheckConfigured: boolean
  experianOAuthConfigured: boolean
  marketCheckConfigured: boolean
  titleHistoryConfigured: boolean
  serviceHistoryConfigured: boolean
  valuationConfigured: boolean
}

export type MarketCheckRuntimeConfig = {
  apiKey: string | null
  apiSecret: string | null
  baseUrl: string
  decodeApiUrl: string
}

export type TitleHistoryProviderConfig = {
  apiKey: string | null
  apiSecret: string | null
  baseUrl: string
  generatePath: string
  accessPath: string
}

export type ServiceHistoryProviderConfig = {
  apiUrl: string | null
  apiKey: string | null
  marketCheckPath: string | null
  marketCheckApiKey: string | null
  marketCheckApiSecret: string | null
  marketCheckBaseUrl: string
}

export type ValuationProviderConfig = {
  apiUrl: string | null
  apiKey: string | null
  marketCheckPath: string | null
  marketCheckApiKey: string | null
  marketCheckApiSecret: string | null
  marketCheckBaseUrl: string
}

export type ExperianOAuthConfig = {
  baseUrl: string | null
  tokenUrl: string | null
  username: string | null
  password: string | null
  clientId: string | null
  clientSecret: string | null
}

export type ExperianVinSpecsConfig = {
  targetPath: string
  vinQueryParam: string
}

const DEFAULT_EXPERIAN_VINSPECS_TARGET_PATH = '/automotive/accuselect/v1/vinspecifications'
const DEFAULT_EXPERIAN_VINSPECS_QUERY_PARAM = 'vinlist'
const DEFAULT_EXPERIAN_TOKEN_PATH = '/oauth2/v1/token'

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export function getOptionalEnv(name: string): string | null {
  return readOptionalEnv(name)
}

function parseTimeoutMs(rawValue: string | null, fallback: number): number {
  if (!rawValue) {
    return fallback
  }

  const parsed = Number(rawValue)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

function normalizeBaseUrl(value: string | null): string | null {
  if (!value) {
    return null
  }

  const normalized = value.replace(/\/+$/, '')
  return normalized || null
}

function getDerivedExperianTokenUrl(baseUrl: string | null): string | null {
  if (!baseUrl) {
    return null
  }

  try {
    return new URL(DEFAULT_EXPERIAN_TOKEN_PATH, `${baseUrl}/`).toString()
  } catch {
    return null
  }
}

function normalizeTargetPath(value: string | null): string {
  if (!value) {
    return DEFAULT_EXPERIAN_VINSPECS_TARGET_PATH
  }

  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '')
  return withoutTrailingSlash || DEFAULT_EXPERIAN_VINSPECS_TARGET_PATH
}

export function getCarfaxConfig(): ProviderCredentialConfig {
  return {
    apiKey: readOptionalEnv('CARFAX_API_KEY'),
    apiUrl: readOptionalEnv('CARFAX_API_URL')
  }
}

export function getAutoCheckConfig(): ProviderCredentialConfig {
  return {
    apiKey: readOptionalEnv('AUTOCHECK_API_KEY'),
    apiUrl: readOptionalEnv('AUTOCHECK_API_URL')
  }
}

export function getMarketCheckConfig(): ProviderCredentialConfig {
  return {
    apiKey: readOptionalEnv('MARKETCHECK_API_KEY'),
    apiUrl: readOptionalEnv('MARKETCHECK_API_URL')
  }
}

export function getMarketCheckRuntimeConfig(): MarketCheckRuntimeConfig {
  const marketCheck = getMarketCheckConfig()

  return {
    apiKey: marketCheck.apiKey,
    apiSecret: readOptionalEnv('MARKETCHECK_API_SECRET'),
    baseUrl: readOptionalEnv('MARKETCHECK_BASE_URL') || DEFAULT_MARKETCHECK_BASE_URL,
    decodeApiUrl: marketCheck.apiUrl || DEFAULT_MARKETCHECK_DECODE_BASE_URL
  }
}

export function getTitleHistoryProviderConfig(): TitleHistoryProviderConfig {
  const marketCheck = getMarketCheckRuntimeConfig()

  return {
    apiKey: marketCheck.apiKey,
    apiSecret: marketCheck.apiSecret,
    baseUrl: marketCheck.baseUrl,
    generatePath:
      readOptionalEnv('MARKETCHECK_TITLE_HISTORY_GENERATE_PATH') || DEFAULT_MARKETCHECK_TITLE_HISTORY_GENERATE_PATH,
    accessPath: readOptionalEnv('MARKETCHECK_TITLE_HISTORY_ACCESS_PATH') || DEFAULT_MARKETCHECK_TITLE_HISTORY_ACCESS_PATH
  }
}

export function getServiceHistoryProviderConfig(): ServiceHistoryProviderConfig {
  const marketCheck = getMarketCheckRuntimeConfig()

  return {
    apiUrl: readOptionalEnv('SERVICE_HISTORY_API_URL'),
    apiKey: readOptionalEnv('SERVICE_HISTORY_API_KEY'),
    marketCheckPath: readOptionalEnv('MARKETCHECK_SERVICE_HISTORY_PATH'),
    marketCheckApiKey: marketCheck.apiKey,
    marketCheckApiSecret: marketCheck.apiSecret,
    marketCheckBaseUrl: marketCheck.baseUrl
  }
}

export function getValuationProviderConfig(): ValuationProviderConfig {
  const marketCheck = getMarketCheckRuntimeConfig()

  return {
    apiUrl: readOptionalEnv('VALUATION_API_URL'),
    apiKey: readOptionalEnv('VALUATION_API_KEY'),
    marketCheckPath: readOptionalEnv('MARKETCHECK_VALUATION_PATH') || DEFAULT_MARKETCHECK_VALUATION_PATH,
    marketCheckApiKey: marketCheck.apiKey,
    marketCheckApiSecret: marketCheck.apiSecret,
    marketCheckBaseUrl: marketCheck.baseUrl
  }
}

export function getNhtsaRecallsBaseUrl(): string {
  return readOptionalEnv('NHTSA_RECALLS_API_URL') || DEFAULT_NHTSA_RECALLS_BASE_URL
}

export function getVinSpecFallbackBaseUrl(): string {
  return readOptionalEnv('VIN_SPEC_FALLBACK_API_URL') || DEFAULT_VIN_SPEC_FALLBACK_BASE_URL
}

export function getProviderTimeoutMs(): number {
  return parseTimeoutMs(readOptionalEnv('VIN_PROVIDER_TIMEOUT_MS'), DEFAULT_VIN_PROVIDER_TIMEOUT_MS)
}

export function getOpenAiTimeoutMs(): number {
  return parseTimeoutMs(readOptionalEnv('OPENAI_TIMEOUT_MS'), DEFAULT_OPENAI_TIMEOUT_MS)
}

export function getExperianOAuthConfig(): ExperianOAuthConfig {
  const baseUrl = normalizeBaseUrl(readOptionalEnv('EXPERIAN_BASE_URL'))
  const explicitTokenUrl = readOptionalEnv('EXPERIAN_TOKEN_URL')

  return {
    baseUrl,
    tokenUrl: explicitTokenUrl ?? getDerivedExperianTokenUrl(baseUrl),
    username: readOptionalEnv('EXPERIAN_USERNAME'),
    password: readOptionalEnv('EXPERIAN_PASSWORD'),
    clientId: readOptionalEnv('EXPERIAN_CLIENT_ID'),
    clientSecret: readOptionalEnv('EXPERIAN_CLIENT_SECRET')
  }
}

export function getExperianVinSpecsConfig(): ExperianVinSpecsConfig {
  return {
    targetPath: normalizeTargetPath(readOptionalEnv('EXPERIAN_VINSPECS_TARGET_PATH')),
    vinQueryParam: readOptionalEnv('EXPERIAN_VINSPECS_QUERY_PARAM') ?? DEFAULT_EXPERIAN_VINSPECS_QUERY_PARAM
  }
}

export function hasCarfaxProviderConfig(): boolean {
  const config = getCarfaxConfig()
  return Boolean(config.apiKey && config.apiUrl)
}

export function hasAutoCheckProviderConfig(): boolean {
  const config = getAutoCheckConfig()
  return Boolean(config.apiKey && config.apiUrl)
}

export function hasMarketCheckProviderConfig(): boolean {
  const config = getMarketCheckRuntimeConfig()
  return Boolean(config.apiKey)
}

export function hasExperianOAuthConfig(): boolean {
  const config = getExperianOAuthConfig()

  return Boolean(
    config.baseUrl &&
      config.tokenUrl &&
      config.username &&
      config.password &&
      config.clientId &&
      config.clientSecret
  )
}

export function hasTitleHistoryProviderConfig(): boolean {
  const config = getTitleHistoryProviderConfig()
  return Boolean(config.apiKey)
}

export function hasServiceHistoryProviderConfig(): boolean {
  const config = getServiceHistoryProviderConfig()
  return Boolean(config.apiUrl || (config.marketCheckPath && config.marketCheckApiKey))
}

export function hasValuationProviderConfig(): boolean {
  const config = getValuationProviderConfig()
  return Boolean(config.apiUrl || (config.marketCheckPath && config.marketCheckApiKey))
}

// Safe for logs: contains only booleans, never secret values.
export function getProviderConfigStatus(): ProviderConfigStatus {
  return {
    carfaxConfigured: hasCarfaxProviderConfig(),
    autoCheckConfigured: hasAutoCheckProviderConfig(),
    experianOAuthConfigured: hasExperianOAuthConfig(),
    marketCheckConfigured: hasMarketCheckProviderConfig(),
    titleHistoryConfigured: hasTitleHistoryProviderConfig(),
    serviceHistoryConfigured: hasServiceHistoryProviderConfig(),
    valuationConfigured: hasValuationProviderConfig()
  }
}

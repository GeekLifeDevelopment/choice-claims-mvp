export const DEFAULT_VIN_PROVIDER_TIMEOUT_MS = 10_000

export type ProviderCredentialConfig = {
  apiKey: string | null
  apiUrl: string | null
}

export type ProviderConfigStatus = {
  carfaxConfigured: boolean
  autoCheckConfigured: boolean
  experianOAuthConfigured: boolean
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

function parseProviderTimeoutMs(rawValue: string | null): number {
  if (!rawValue) {
    return DEFAULT_VIN_PROVIDER_TIMEOUT_MS
  }

  const parsed = Number(rawValue)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_VIN_PROVIDER_TIMEOUT_MS
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

export function getProviderTimeoutMs(): number {
  return parseProviderTimeoutMs(readOptionalEnv('VIN_PROVIDER_TIMEOUT_MS'))
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

// Safe for logs: contains only booleans, never secret values.
export function getProviderConfigStatus(): ProviderConfigStatus {
  return {
    carfaxConfigured: hasCarfaxProviderConfig(),
    autoCheckConfigured: hasAutoCheckProviderConfig(),
    experianOAuthConfigured: hasExperianOAuthConfig()
  }
}

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
  username: string | null
  password: string | null
  clientId: string | null
  clientSecret: string | null
}

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
  return {
    baseUrl: readOptionalEnv('EXPERIAN_BASE_URL'),
    username: readOptionalEnv('EXPERIAN_USERNAME'),
    password: readOptionalEnv('EXPERIAN_PASSWORD'),
    clientId: readOptionalEnv('EXPERIAN_CLIENT_ID'),
    clientSecret: readOptionalEnv('EXPERIAN_CLIENT_SECRET')
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

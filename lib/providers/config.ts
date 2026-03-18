export const DEFAULT_VIN_PROVIDER_TIMEOUT_MS = 10_000

export type ProviderCredentialConfig = {
  apiKey: string | null
  apiUrl: string | null
}

export type ProviderConfigStatus = {
  carfaxConfigured: boolean
  autoCheckConfigured: boolean
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

export function hasCarfaxProviderConfig(): boolean {
  const config = getCarfaxConfig()
  return Boolean(config.apiKey && config.apiUrl)
}

export function hasAutoCheckProviderConfig(): boolean {
  const config = getAutoCheckConfig()
  return Boolean(config.apiKey && config.apiUrl)
}

// Safe for logs: contains only booleans, never secret values.
export function getProviderConfigStatus(): ProviderConfigStatus {
  return {
    carfaxConfigured: hasCarfaxProviderConfig(),
    autoCheckConfigured: hasAutoCheckProviderConfig()
  }
}

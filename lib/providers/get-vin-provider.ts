import { AutoCheckProviderStub } from './autocheck-provider-stub'
import { AutoCheckProviderLive } from './autocheck-provider-live'
import { CarfaxProviderStub } from './carfax-provider-stub'
import { hasExperianOAuthConfig } from './config'
import type { VinDataProvider } from './provider-interface'
import type { VinProviderName } from './types'

const DEFAULT_PROVIDER: VinProviderName = 'carfax'

function normalizeProviderName(value: string | undefined): VinProviderName {
  const normalized = value?.trim().toLowerCase()

  if (normalized === 'autocheck') {
    return 'autocheck'
  }

  return DEFAULT_PROVIDER
}

export function getVinDataProvider(providerName?: string): VinDataProvider {
  const requestedProvider = normalizeProviderName(providerName ?? process.env.VIN_DATA_PROVIDER)

  if (requestedProvider === 'autocheck') {
    if (hasExperianOAuthConfig()) {
      return new AutoCheckProviderLive()
    }

    return new AutoCheckProviderStub()
  }

  return new CarfaxProviderStub()
}

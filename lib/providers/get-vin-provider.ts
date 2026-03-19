import { AutoCheckProviderStub } from './autocheck-provider-stub'
import { AutoCheckProviderLive } from './autocheck-provider-live'
import { CarfaxProviderStub } from './carfax-provider-stub'
import { hasExperianOAuthConfig } from './config'
import type { VinDataProvider } from './provider-interface'
import type { VinProviderName } from './types'

function normalizeProviderName(value: string | undefined): VinProviderName {
  if (value?.trim().toLowerCase() === 'autocheck') {
    return 'autocheck'
  }

  return 'carfax'
}

export function getVinDataProvider(providerName?: string): VinDataProvider {
  const selectedProvider = normalizeProviderName(providerName ?? process.env.VIN_DATA_PROVIDER)

  if (selectedProvider === 'autocheck') {
    if (hasExperianOAuthConfig()) {
      return new AutoCheckProviderLive()
    }

    return new AutoCheckProviderStub()
  }

  return new CarfaxProviderStub()
}

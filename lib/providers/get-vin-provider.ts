import { AutoCheckProviderStub } from './autocheck-provider-stub'
import { CarfaxProviderStub } from './carfax-provider-stub'
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
    return new AutoCheckProviderStub()
  }

  return new CarfaxProviderStub()
}

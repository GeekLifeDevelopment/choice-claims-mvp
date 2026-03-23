import { AutoCheckProviderStub } from './autocheck-provider-stub'
import { AutoCheckProviderLive } from './autocheck-provider-live'
import { CarfaxProviderStub } from './carfax-provider-stub'
import { hasExperianOAuthConfig } from './config'
import { MarketCheckProviderLive } from './marketcheck-provider-live'
import { logProviderHealth } from './provider-health-log'
import type { VinDataProvider } from './provider-interface'
import type { VinProviderName } from './types'

const DEFAULT_PROVIDER: VinProviderName = 'carfax'

function normalizeProviderName(value: string | undefined): VinProviderName {
  const normalized = value?.trim().toLowerCase()

  if (normalized === 'autocheck') {
    return 'autocheck'
  }

  if (normalized === 'marketcheck') {
    return 'marketcheck'
  }

  return DEFAULT_PROVIDER
}

export function getVinDataProvider(providerName?: string): VinDataProvider {
  const requestedProvider = normalizeProviderName(providerName ?? process.env.VIN_DATA_PROVIDER)

  if (requestedProvider === 'autocheck') {
    if (hasExperianOAuthConfig()) {
      logProviderHealth({
        provider: 'autocheck',
        capability: 'vin_decode',
        event: 'configured',
        mode: 'live',
        source: 'autocheck'
      })

      return new AutoCheckProviderLive()
    }

    logProviderHealth({
      provider: 'autocheck',
      capability: 'vin_decode',
      event: 'stub_fallback',
      mode: 'stub',
      reason: 'missing_experian_config',
      source: 'stub'
    })

    return new AutoCheckProviderStub()
  }

  if (requestedProvider === 'marketcheck') {
    logProviderHealth({
      provider: 'marketcheck',
      capability: 'vin_decode',
      event: 'configured',
      mode: 'live',
      source: 'marketcheck'
    })

    return new MarketCheckProviderLive()
  }

  logProviderHealth({
    provider: 'carfax',
    capability: 'vin_decode',
    event: 'stub_fallback',
    mode: 'stub',
    source: 'stub'
  })

  return new CarfaxProviderStub()
}

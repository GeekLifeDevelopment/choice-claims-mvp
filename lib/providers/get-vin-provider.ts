import { AutoCheckProviderStub } from './autocheck-provider-stub'
import { AutoCheckProviderLive } from './autocheck-provider-live'
import { CarfaxProviderStub } from './carfax-provider-stub'
import { isFeatureEnabled } from '../config/feature-flags'
import { hasCarfaxProviderConfig, hasExperianOAuthConfig, hasMarketCheckProviderConfig } from './config'
import { MarketCheckProviderLive } from './marketcheck-provider-live'
import { logProviderHealth } from './provider-health-log'
import { getVinProviderPriority, type VinProviderPriorityName } from './provider-priority'
import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'
import type { VinProviderName } from './types'

const DEFAULT_PROVIDER: VinProviderName = 'carfax'

function isProviderFeatureEnabled(providerName: VinProviderPriorityName): boolean {
  if (providerName === 'fallback') {
    return true
  }

  if (providerName === 'autocheck') {
    return isFeatureEnabled('provider_autocheck')
  }

  if (providerName === 'carfax') {
    return isFeatureEnabled('provider_carfax')
  }

  return isFeatureEnabled('provider_marketcheck')
}

class DisabledVinDataProvider implements VinDataProvider {
  readonly name: VinProviderName = 'carfax'

  async lookupVinData(vin: string): Promise<VinDataResult> {
    return {
      vin,
      provider: this.name,
      providerResultMessage: 'vin_enrichment_disabled'
    }
  }
}

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

function normalizePriorityName(value: string | undefined): VinProviderPriorityName | null {
  const normalized = value?.trim().toLowerCase()

  if (normalized === 'carfax' || normalized === 'autocheck' || normalized === 'marketcheck' || normalized === 'fallback') {
    return normalized
  }

  return null
}

function resolveVinProviderPriority(providerName?: string): VinProviderPriorityName[] {
  const fromEnv = getVinProviderPriority()
  const explicit = normalizePriorityName(providerName)

  if (!explicit) {
    return fromEnv
  }

  return [explicit, ...fromEnv.filter((entry) => entry !== explicit)]
}

class PriorityVinDataProvider implements VinDataProvider {
  private activeProviderName: VinProviderName = DEFAULT_PROVIDER

  constructor(private readonly priorities: VinProviderPriorityName[]) {}

  get name(): VinProviderName {
    return this.activeProviderName
  }

  async lookupVinData(vin: string): Promise<VinDataResult> {
    for (const providerName of this.priorities) {
      if (!isProviderFeatureEnabled(providerName)) {
        if (providerName === 'autocheck') {
          console.info('[feature] provider autocheck disabled')
        }

        if (providerName === 'carfax') {
          console.info('[feature] provider carfax disabled')
        }

        if (providerName === 'marketcheck') {
          console.info('[feature] provider marketcheck disabled')
        }

        continue
      }

      if (providerName === 'fallback') {
        const fallbackProvider = isFeatureEnabled('provider_carfax')
          ? new CarfaxProviderStub()
          : isFeatureEnabled('provider_autocheck')
            ? new AutoCheckProviderStub()
            : new DisabledVinDataProvider()
        this.activeProviderName = fallbackProvider.name

        logProviderHealth({
          provider: fallbackProvider.name,
          capability: 'vin_decode',
          event: 'stub_fallback',
          mode: 'stub',
          vin,
          reason: 'priority_fallback',
          source: 'stub'
        })

        return fallbackProvider.lookupVinData(vin)
      }

      if (providerName === 'carfax') {
        if (!hasCarfaxProviderConfig()) {
          logProviderHealth({
            provider: 'carfax',
            capability: 'vin_decode',
            event: 'unconfigured',
            mode: 'unconfigured',
            vin,
            reason: 'missing_carfax_config'
          })
          continue
        }

        const provider = new CarfaxProviderStub()
        this.activeProviderName = provider.name

        logProviderHealth({
          provider: 'carfax',
          capability: 'vin_decode',
          event: 'configured',
          mode: 'live',
          vin,
          reason: 'selected_by_priority',
          source: 'carfax'
        })

        try {
          return await provider.lookupVinData(vin)
        } catch {
          logProviderHealth({
            provider: 'carfax',
            capability: 'vin_decode',
            event: 'live_failure',
            mode: 'failed',
            vin,
            reason: 'priority_provider_failed'
          })
          continue
        }
      }

      if (providerName === 'autocheck') {
        if (!hasExperianOAuthConfig()) {
          logProviderHealth({
            provider: 'autocheck',
            capability: 'vin_decode',
            event: 'unconfigured',
            mode: 'unconfigured',
            vin,
            reason: 'missing_experian_config'
          })
          continue
        }

        const provider = new AutoCheckProviderLive()
        this.activeProviderName = provider.name

        logProviderHealth({
          provider: 'autocheck',
          capability: 'vin_decode',
          event: 'configured',
          mode: 'live',
          vin,
          reason: 'selected_by_priority',
          source: 'autocheck'
        })

        try {
          return await provider.lookupVinData(vin)
        } catch {
          logProviderHealth({
            provider: 'autocheck',
            capability: 'vin_decode',
            event: 'live_failure',
            mode: 'failed',
            vin,
            reason: 'priority_provider_failed'
          })
          continue
        }
      }

      if (!hasMarketCheckProviderConfig()) {
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'vin_decode',
          event: 'unconfigured',
          mode: 'unconfigured',
          vin,
          reason: 'missing_marketcheck_api_key'
        })
        continue
      }

      const provider = new MarketCheckProviderLive()
      this.activeProviderName = provider.name

      logProviderHealth({
        provider: 'marketcheck',
        capability: 'vin_decode',
        event: 'configured',
        mode: 'live',
        vin,
        reason: 'selected_by_priority',
        source: 'marketcheck'
      })

      try {
        return await provider.lookupVinData(vin)
      } catch {
        logProviderHealth({
          provider: 'marketcheck',
          capability: 'vin_decode',
          event: 'live_failure',
          mode: 'failed',
          vin,
          reason: 'priority_provider_failed'
        })
      }
    }

    const fallbackProvider = isFeatureEnabled('provider_autocheck')
      ? new AutoCheckProviderStub()
      : isFeatureEnabled('provider_carfax')
        ? new CarfaxProviderStub()
        : new DisabledVinDataProvider()
    this.activeProviderName = fallbackProvider.name

    logProviderHealth({
      provider: fallbackProvider.name,
      capability: 'vin_decode',
      event: 'stub_fallback',
      mode: 'stub',
      vin,
      reason: 'all_priority_providers_unavailable_or_failed',
      source: 'stub'
    })

    return fallbackProvider.lookupVinData(vin)
  }
}

export function getVinDataProvider(providerName?: string): VinDataProvider {
  const requestedProvider = normalizeProviderName(providerName ?? process.env.VIN_DATA_PROVIDER)
  const priorities = resolveVinProviderPriority(requestedProvider)
  return new PriorityVinDataProvider(priorities)
}

import { getOptionalEnv } from './config'

export type VinProviderPriorityName = 'carfax' | 'autocheck' | 'marketcheck' | 'fallback'
export type TitleProviderPriorityName = 'marketcheck' | 'stub'
export type ServiceProviderPriorityName = 'service' | 'marketcheck' | 'stub'
export type ValuationProviderPriorityName = 'valuation' | 'marketcheck' | 'stub'

const DEFAULT_VIN_PROVIDER_PRIORITY: VinProviderPriorityName[] = ['marketcheck', 'autocheck', 'carfax', 'fallback']
const DEFAULT_TITLE_PROVIDER_PRIORITY: TitleProviderPriorityName[] = ['marketcheck', 'stub']
const DEFAULT_SERVICE_PROVIDER_PRIORITY: ServiceProviderPriorityName[] = ['service', 'marketcheck', 'stub']
const DEFAULT_VALUATION_PROVIDER_PRIORITY: ValuationProviderPriorityName[] = ['valuation', 'marketcheck', 'stub']

function parsePriorityList<T extends string>(raw: string | null, allowed: readonly T[], defaults: T[]): T[] {
  if (!raw) {
    return [...defaults]
  }

  const allowedSet = new Set<string>(allowed)
  const output: T[] = []

  for (const token of raw.split(',')) {
    const normalized = token.trim().toLowerCase()
    if (!normalized || !allowedSet.has(normalized)) {
      continue
    }

    if (!output.includes(normalized as T)) {
      output.push(normalized as T)
    }
  }

  if (output.length === 0) {
    return [...defaults]
  }

  return output
}

export function getVinProviderPriority(): VinProviderPriorityName[] {
  return parsePriorityList(
    getOptionalEnv('VIN_PROVIDER_PRIORITY'),
    ['carfax', 'autocheck', 'marketcheck', 'fallback'],
    DEFAULT_VIN_PROVIDER_PRIORITY
  )
}

export function getTitleProviderPriority(): TitleProviderPriorityName[] {
  return parsePriorityList(
    getOptionalEnv('TITLE_PROVIDER_PRIORITY'),
    ['marketcheck', 'stub'],
    DEFAULT_TITLE_PROVIDER_PRIORITY
  )
}

export function getServiceProviderPriority(): ServiceProviderPriorityName[] {
  return parsePriorityList(
    getOptionalEnv('SERVICE_PROVIDER_PRIORITY'),
    ['service', 'marketcheck', 'stub'],
    DEFAULT_SERVICE_PROVIDER_PRIORITY
  )
}

export function getValuationProviderPriority(): ValuationProviderPriorityName[] {
  return parsePriorityList(
    getOptionalEnv('VALUATION_PROVIDER_PRIORITY'),
    ['valuation', 'marketcheck', 'stub'],
    DEFAULT_VALUATION_PROVIDER_PRIORITY
  )
}

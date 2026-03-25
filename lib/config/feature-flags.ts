export type FeatureFlagName =
  | 'openai'
  | 'summary_generation'
  | 'enrichment'
  | 'valuation'
  | 'title_history'
  | 'service_history'
  | 'recalls'
  | 'provider_marketcheck'
  | 'provider_autocheck'
  | 'provider_carfax'

const FEATURE_FLAG_ENV_KEYS: Record<FeatureFlagName, ReadonlyArray<string>> = {
  openai: ['FEATURE_ENABLE_OPENAI'],
  summary_generation: ['FEATURE_ENABLE_SUMMARY_GENERATION', 'FEATURE_ENABLE_SUMMARY'],
  enrichment: ['FEATURE_ENABLE_ENRICHMENT'],
  valuation: ['FEATURE_ENABLE_VALUATION'],
  title_history: ['FEATURE_ENABLE_TITLE_HISTORY'],
  service_history: ['FEATURE_ENABLE_SERVICE_HISTORY'],
  recalls: ['FEATURE_ENABLE_RECALLS'],
  provider_marketcheck: ['FEATURE_ENABLE_PROVIDER_MARKETCHECK'],
  provider_autocheck: ['FEATURE_ENABLE_PROVIDER_AUTOCHECK'],
  provider_carfax: ['FEATURE_ENABLE_PROVIDER_CARFAX']
}

function isExplicitlyDisabled(rawValue: string | undefined): boolean {
  return rawValue?.trim().toLowerCase() === 'false'
}

export function isFeatureEnabled(feature: FeatureFlagName): boolean {
  const keys = FEATURE_FLAG_ENV_KEYS[feature]

  for (const key of keys) {
    if (isExplicitlyDisabled(process.env[key])) {
      return false
    }
  }

  return true
}

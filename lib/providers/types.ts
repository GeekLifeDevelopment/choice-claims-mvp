export type VinProviderName = 'carfax' | 'autocheck' | 'nhtsa_vpic'

export type VinEnrichmentSummary = Record<string, string | number | boolean | null>

export type NhtsaRecallItem = {
  campaignId: string | null
  component: string | null
  summary: string | null
  remedy: string | null
  safetyRisk: string | null
  reportDate: string | null
}

export type NhtsaRecallsResult = {
  source: 'nhtsa'
  fetchedAt: string
  count: number
  message?: string | null
  items: NhtsaRecallItem[]
}

export type VinSpecFallbackResult = {
  source: 'nhtsa_vpic'
  fetchedAt: string
  year?: number | null
  make?: string | null
  model?: string | null
  trim?: string | null
  bodyStyle?: string | null
  drivetrain?: string | null
  transmissionType?: string | null
  engineSize?: string | null
  cylinders?: string | null
  fuelType?: string | null
  manufacturer?: string | null
}

export type TitleHistoryEvent = {
  type: string
  summary: string
  eventDate?: string | null
  state?: string | null
}

export type TitleHistoryResult = {
  source: 'nmvtis' | 'nmvtis_stub'
  fetchedAt: string
  titleStatus?: string | null
  brandFlags: string[]
  odometerFlags: string[]
  salvageIndicator?: boolean | null
  junkIndicator?: boolean | null
  rebuiltIndicator?: boolean | null
  theftIndicator?: boolean | null
  totalLossIndicator?: boolean | null
  events: TitleHistoryEvent[]
  message?: string | null
}

export type ServiceHistoryEvent = {
  eventDate?: string | null
  mileage?: number | null
  serviceType?: string | null
  description?: string | null
  shop?: string | null
}

export type ServiceHistoryResult = {
  source: 'service_history' | 'service_history_stub'
  fetchedAt: string
  eventCount: number
  latestMileage?: number | null
  events: ServiceHistoryEvent[]
  message?: string | null
}

export type VinDataResult = {
  vin: string
  year?: number | null
  make?: string | null
  model?: string | null
  trim?: string | null
  vehicleClass?: string | null
  country?: string | null
  bodyStyle?: string | null
  doors?: string | null
  drivetrain?: string | null
  transmissionType?: string | null
  wheelSize?: string | null
  engineSize?: string | null
  cylinders?: string | null
  fuelType?: string | null
  manufacturer?: string | null
  horsepower?: string | null
  eventCount?: number | null
  providerResultCode?: number | null
  providerResultMessage?: string | null
  quickCheck?: VinEnrichmentSummary
  ownershipHistory?: VinEnrichmentSummary
  accident?: VinEnrichmentSummary
  mileage?: VinEnrichmentSummary
  recall?: VinEnrichmentSummary
  nhtsaRecalls?: NhtsaRecallsResult | null
  vinSpecFallback?: VinSpecFallbackResult | null
  titleHistory?: TitleHistoryResult | null
  serviceHistory?: ServiceHistoryResult | null
  titleProblem?: VinEnrichmentSummary
  titleBrand?: VinEnrichmentSummary
  provider: VinProviderName
  raw?: unknown
}

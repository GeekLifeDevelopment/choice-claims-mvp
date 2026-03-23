export type VinProviderName = 'carfax' | 'autocheck'

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
  titleProblem?: VinEnrichmentSummary
  titleBrand?: VinEnrichmentSummary
  provider: VinProviderName
  raw?: unknown
}

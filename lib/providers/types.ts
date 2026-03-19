export type VinProviderName = 'carfax' | 'autocheck'

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
  provider: VinProviderName
  raw?: unknown
}

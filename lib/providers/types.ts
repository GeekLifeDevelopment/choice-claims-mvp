export type VinProviderName = 'carfax' | 'autocheck'

export type VinDataResult = {
  vin: string
  year: number | null
  make: string | null
  model: string | null
  provider: VinProviderName
  raw?: unknown
}

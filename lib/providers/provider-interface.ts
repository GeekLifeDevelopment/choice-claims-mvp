import type { VinDataResult, VinProviderName } from './types'

export interface VinDataProvider {
  readonly name: VinProviderName
  lookupVinData(vin: string): Promise<VinDataResult>
}

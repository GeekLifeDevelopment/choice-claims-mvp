import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'

export class CarfaxProviderStub implements VinDataProvider {
  readonly name = 'carfax' as const

  async lookupVinData(vin: string): Promise<VinDataResult> {
    return {
      vin,
      year: 2019,
      make: 'Honda',
      model: 'Accord',
      provider: this.name,
      raw: {
        source: 'stub',
        provider: this.name,
        note: 'No real CARFAX API call was made.'
      }
    }
  }
}

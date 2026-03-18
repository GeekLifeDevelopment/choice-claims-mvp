import type { VinDataProvider } from './provider-interface'
import type { VinDataResult } from './types'

export class AutoCheckProviderStub implements VinDataProvider {
  readonly name = 'autocheck' as const

  async lookupVinData(vin: string): Promise<VinDataResult> {
    if (vin.toUpperCase().includes('FAIL')) {
      throw new Error('Mocked VIN provider failure (autocheck)')
    }

    return {
      vin,
      year: 2020,
      make: 'Toyota',
      model: 'Camry',
      provider: this.name,
      raw: {
        source: 'stub',
        provider: this.name,
        note: 'No real AutoCheck API call was made.'
      }
    }
  }
}

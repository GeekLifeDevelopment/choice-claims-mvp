import type { VinLookupJobPayload } from './job-payloads'

export type BuildVinLookupJobInput = {
  claimId: string
  vin: string | null
  source: string
  requestedAt?: string
  dedupeKey?: string
  claimNumber?: string
}

export function buildVinLookupJobPayload(input: BuildVinLookupJobInput): VinLookupJobPayload {
  return {
    claimId: input.claimId,
    vin: input.vin,
    source: input.source,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    dedupeKey: input.dedupeKey,
    claimNumber: input.claimNumber
  }
}

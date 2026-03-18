import { JOB_NAMES, type JobName } from './job-names'

export type VinLookupJobPayload = {
  claimId: string
  vin: string | null
  source: string
  requestedAt: string
  dedupeKey?: string
  claimNumber?: string
}

export type QueueJobPayloadMap = {
  [JOB_NAMES.LOOKUP_VIN_DATA]: VinLookupJobPayload
}

export type JobPayloadByName<TJobName extends JobName> = QueueJobPayloadMap[TJobName]

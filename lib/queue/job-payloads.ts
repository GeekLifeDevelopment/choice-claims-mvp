import { JOB_NAMES, type JobName } from './job-names'

export type VinLookupJobPayload = {
  claimId: string
  vin: string | null
  source: string
  requestedAt: string
  dedupeKey?: string
  claimNumber?: string
}

export type ReviewSummaryJobSource = 'rules_ready' | 'manual' | 'backfill'

export type ReviewSummaryJobPayload = {
  claimId: string
  claimNumber?: string
  requestedAt: string
  source: ReviewSummaryJobSource
}

export type QueueJobPayloadMap = {
  [JOB_NAMES.LOOKUP_VIN_DATA]: VinLookupJobPayload
  [JOB_NAMES.GENERATE_REVIEW_SUMMARY]: ReviewSummaryJobPayload
}

export type JobPayloadByName<TJobName extends JobName> = QueueJobPayloadMap[TJobName]

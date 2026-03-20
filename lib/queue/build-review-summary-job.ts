import type { ReviewSummaryJobPayload, ReviewSummaryJobSource } from './job-payloads'

export type BuildReviewSummaryJobInput = {
  claimId: string
  claimNumber?: string
  requestedAt?: string
  source: ReviewSummaryJobSource
}

export function buildReviewSummaryJobPayload(input: BuildReviewSummaryJobInput): ReviewSummaryJobPayload {
  return {
    claimId: input.claimId,
    claimNumber: input.claimNumber,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    source: input.source
  }
}

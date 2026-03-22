import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditLog } from './write-audit-log'

type AuditLogClient = Pick<PrismaClient, 'auditLog'> | Pick<Prisma.TransactionClient, 'auditLog'>

type CommonAuditInput = {
  client?: AuditLogClient
}

type LogClaimCreatedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  source: string
  attachmentCount: number
  claimantEmail?: string
  vin?: string
  dedupeKey?: string
}

type LogDuplicateBlockedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  source: string
  dedupeKey: string
  dedupeSource?: string
  cognitoPayloadId?: string
  cognitoEntryNumber?: string
  claimantEmail?: string
  vin?: string
}

type LogIntakeValidationFailedInput = CommonAuditInput & {
  requestId: string
  source?: string
  issues: Array<{
    path: string
    code: string
    message: string
  }>
  topLevelKeys?: string[]
}

type LogVinLookupEnqueuedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  queueName: string
  jobName: string
  jobId?: string
  source: string
  vin?: string
}

type LogVinLookupRequeuedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  queueName: string
  jobName: string
  jobId?: string
  source: string
  vin?: string
  previousStatus: string
  newStatus: string
  reason: 'manual_retry'
  reviewerDecision?: string
}

type LogVinDataFetchedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  queueName: string
  jobName: string
  jobId?: string
  attemptsMade?: number
  attemptsAllowed?: number
  source?: string
  vin?: string
  provider: string
  year?: number | null
  make?: string | null
  model?: string | null
}

type LogVinDataFetchFailedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  queueName: string
  jobName: string
  jobId?: string
  attemptsMade?: number
  attemptsAllowed?: number
  source?: string
  vin?: string | null
  provider?: string
  reason: string
  errorMessage?: string
}

type LogReviewDecisionChangedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  fromDecision?: string | null
  toDecision: string
  notes?: string | null
  reviewer?: string | null
}

type LogReviewSummaryRegenerateQueuedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  queueName: string
  jobName: string
  jobId?: string
  source: 'manual'
  reason: 'manual_regenerate'
  previousSummaryStatus: string
  newSummaryStatus: string
  reviewerDecision?: string
}

export async function logClaimCreatedAudit(input: LogClaimCreatedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_created',
    claimId: input.claimId,
    metadata: {
      claimNumber: input.claimNumber,
      source: input.source,
      claimantEmail: input.claimantEmail,
      vin: input.vin,
      attachmentCount: input.attachmentCount,
      dedupeKey: input.dedupeKey
    }
  })
}

export async function logDuplicateBlockedAudit(input: LogDuplicateBlockedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'duplicate_blocked',
    claimId: input.claimId,
    metadata: {
      claimNumber: input.claimNumber,
      source: input.source,
      claimantEmail: input.claimantEmail,
      vin: input.vin,
      dedupeKey: input.dedupeKey,
      dedupeSource: input.dedupeSource,
      cognitoPayloadId: input.cognitoPayloadId,
      cognitoEntryNumber: input.cognitoEntryNumber
    }
  })
}

export async function logDuplicateReplayIgnoredAudit(input: LogDuplicateBlockedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'duplicate_replay_ignored',
    claimId: input.claimId,
    metadata: {
      claimNumber: input.claimNumber,
      source: input.source,
      claimantEmail: input.claimantEmail,
      vin: input.vin,
      dedupeKey: input.dedupeKey,
      dedupeSource: input.dedupeSource,
      cognitoPayloadId: input.cognitoPayloadId,
      cognitoEntryNumber: input.cognitoEntryNumber
    }
  })
}

export async function logIntakeValidationFailedAudit(input: LogIntakeValidationFailedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'intake_validation_failed',
    metadata: {
      requestId: input.requestId,
      source: input.source,
      issues: input.issues,
      topLevelKeys: input.topLevelKeys ?? []
    }
  })
}

export async function logVinLookupEnqueuedAudit(input: LogVinLookupEnqueuedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'vin_lookup_enqueued',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      source: input.source,
      vin: input.vin
    }
  })
}

export async function logVinLookupRequeuedAudit(input: LogVinLookupRequeuedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'vin_lookup_requeued',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      source: input.source,
      vin: input.vin,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      reason: input.reason,
      reviewerDecision: input.reviewerDecision
    }
  })
}

export async function logVinDataFetchedAudit(input: LogVinDataFetchedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'vin_data_fetched',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      attemptsMade: input.attemptsMade,
      attemptsAllowed: input.attemptsAllowed,
      source: input.source,
      vin: input.vin,
      provider: input.provider,
      year: input.year,
      make: input.make,
      model: input.model
    }
  })
}

export async function logVinDataFetchFailedAudit(input: LogVinDataFetchFailedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'vin_data_fetch_failed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      attemptsMade: input.attemptsMade,
      attemptsAllowed: input.attemptsAllowed,
      source: input.source,
      vin: input.vin,
      provider: input.provider,
      reason: input.reason,
      errorMessage: input.errorMessage
    }
  })
}

export async function logReviewDecisionChangedAudit(input: LogReviewDecisionChangedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'review_decision_changed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      fromDecision: input.fromDecision ?? null,
      toDecision: input.toDecision,
      notes: input.notes ?? null,
      reviewer: input.reviewer ?? null
    }
  })
}

export async function logReviewSummaryRegenerateQueuedAudit(input: LogReviewSummaryRegenerateQueuedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'review_summary_regenerate_queued',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      source: input.source,
      reason: input.reason,
      previousSummaryStatus: input.previousSummaryStatus,
      newSummaryStatus: input.newSummaryStatus,
      reviewerDecision: input.reviewerDecision
    }
  })
}

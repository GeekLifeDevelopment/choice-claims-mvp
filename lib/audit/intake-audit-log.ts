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
  overrideUsed?: boolean
  overrideReason?: string | null
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

type LogClaimDocumentUploadedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  mimeType: string
  fileSize: number
  uploadedBy?: string | null
  processingStatus: string
  documentType?: string | null
  matchStatus?: string | null
}

type LogClaimDocumentRemovedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  mimeType: string
  fileSize: number
  removedBy?: string | null
  uploadedBy?: string | null
  processingStatus?: string | null
  documentType?: string | null
  matchStatus?: string | null
  extractionStatus?: string | null
}

type LogClaimDocumentReprocessRequestedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  requestedBy?: string | null
  previousProcessingStatus?: string | null
  previousDocumentType?: string | null
  previousMatchStatus?: string | null
  previousExtractionStatus?: string | null
}

type LogClaimDocumentReprocessedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  processingStatus: string
  documentType?: string | null
  matchStatus?: string | null
  extractionStatus?: string | null
  applyStatus?: string | null
  extractedFieldCount?: number | null
  refreshQueued?: boolean
  refreshReason?: string | null
}

type LogClaimDocumentReprocessFailedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  errorMessage: string
}

type LogClaimDocumentClassifiedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  processingStatus: string
}

type LogClaimDocumentMatchEvaluatedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  matchStatus: string
  matchNotes?: string | null
  anchors?: Prisma.InputJsonValue
}

type LogClaimDocumentExtractionAttemptedInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
}

type LogClaimDocumentExtractionResultInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  extractionStatus: string
  extractedAt?: Date | string | null
  extractedData?: Prisma.InputJsonValue
  extractionWarnings?: Prisma.InputJsonValue
}

type LogClaimDocumentEvidenceApplyInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  applyStatus: string
  appliedAt?: Date | string | null
  appliedFields?: Prisma.InputJsonValue
  skippedFields?: Prisma.InputJsonValue
  conflictFields?: Prisma.InputJsonValue
}

type LogClaimDocumentEvidenceTriggeredRefreshInput = CommonAuditInput & {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  applyStatus: string
  queueEnqueued: boolean
  queueReason?: string | null
  queueName?: string | null
  jobName?: string | null
  jobId?: string | null
}

function getExtractedFieldCount(extractedData?: Prisma.InputJsonValue): number | null {
  if (!extractedData || typeof extractedData !== 'object' || Array.isArray(extractedData)) {
    return null
  }

  return Object.keys(extractedData as Record<string, unknown>).length
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
      reviewer: input.reviewer ?? null,
      overrideUsed: input.overrideUsed ?? false,
      overrideReason: input.overrideReason ?? null
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

export async function logClaimDocumentUploadedAudit(input: LogClaimDocumentUploadedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_uploaded',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      uploadedBy: input.uploadedBy ?? null,
      processingStatus: input.processingStatus,
      documentType: input.documentType ?? null,
      matchStatus: input.matchStatus ?? null,
      message: `Uploaded supporting document: ${input.fileName}`
    }
  })
}

export async function logClaimDocumentRemovedAudit(input: LogClaimDocumentRemovedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_removed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      removedBy: input.removedBy ?? null,
      uploadedBy: input.uploadedBy ?? null,
      processingStatus: input.processingStatus ?? null,
      documentType: input.documentType ?? null,
      matchStatus: input.matchStatus ?? null,
      extractionStatus: input.extractionStatus ?? null,
      removedAt: new Date().toISOString(),
      message: 'Document removed from claim for retest'
    }
  })
}

export async function logClaimDocumentReprocessRequestedAudit(input: LogClaimDocumentReprocessRequestedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_reprocess_requested',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      requestedBy: input.requestedBy ?? null,
      previousProcessingStatus: input.previousProcessingStatus ?? null,
      previousDocumentType: input.previousDocumentType ?? null,
      previousMatchStatus: input.previousMatchStatus ?? null,
      previousExtractionStatus: input.previousExtractionStatus ?? null,
      message: 'Document reprocess requested'
    }
  })
}

export async function logClaimDocumentReprocessedAudit(input: LogClaimDocumentReprocessedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_reprocessed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      processingStatus: input.processingStatus,
      documentType: input.documentType ?? null,
      matchStatus: input.matchStatus ?? null,
      extractionStatus: input.extractionStatus ?? null,
      applyStatus: input.applyStatus ?? null,
      extractedFieldCount: input.extractedFieldCount ?? null,
      refreshQueued: input.refreshQueued ?? false,
      refreshReason: input.refreshReason ?? null,
      message: 'Document reprocessed'
    }
  })
}

export async function logClaimDocumentReprocessFailedAudit(input: LogClaimDocumentReprocessFailedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_reprocess_failed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      errorMessage: input.errorMessage,
      message: 'Document reprocess failed'
    }
  })
}

export async function logClaimDocumentReuploadedAudit(input: LogClaimDocumentUploadedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_reuploaded',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      uploadedBy: input.uploadedBy ?? null,
      processingStatus: input.processingStatus,
      documentType: input.documentType ?? null,
      matchStatus: input.matchStatus ?? null,
      message: 'Document reuploaded after previous removal'
    }
  })
}

export async function logClaimDocumentClassifiedAudit(input: LogClaimDocumentClassifiedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_classified',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      processingStatus: input.processingStatus,
      message: `Document classified as ${input.documentType}`
    }
  })
}

export async function logClaimDocumentMatchEvaluatedAudit(input: LogClaimDocumentMatchEvaluatedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_match_evaluated',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      matchStatus: input.matchStatus,
      matchNotes: input.matchNotes ?? null,
      anchors: input.anchors ?? null,
      message: `Document match status: ${input.matchStatus}`
    }
  })
}

export async function logClaimDocumentExtractionAttemptedAudit(input: LogClaimDocumentExtractionAttemptedInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_extraction_attempted',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      message: `Extraction attempted for ${input.documentType} document`
    }
  })
}

export async function logClaimDocumentExtractionSucceededAudit(input: LogClaimDocumentExtractionResultInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_extraction_succeeded',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      extractionStatus: input.extractionStatus,
      extractedAt: input.extractedAt ?? null,
      extractedFieldCount: getExtractedFieldCount(input.extractedData),
      extractionWarnings: input.extractionWarnings ?? null,
      message: `Document extraction succeeded (${input.extractionStatus})`
    }
  })
}

export async function logClaimDocumentExtractionPartialAudit(input: LogClaimDocumentExtractionResultInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_extraction_partial',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      extractionStatus: input.extractionStatus,
      extractedAt: input.extractedAt ?? null,
      extractedFieldCount: getExtractedFieldCount(input.extractedData),
      extractionWarnings: input.extractionWarnings ?? null,
      message: `Document extraction partial (${input.extractionStatus})`
    }
  })
}

export async function logClaimDocumentExtractionFailedAudit(input: LogClaimDocumentExtractionResultInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_extraction_failed',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      extractionStatus: input.extractionStatus,
      extractedAt: input.extractedAt ?? null,
      extractionWarnings: input.extractionWarnings ?? null,
      message: `Document extraction failed (${input.extractionStatus})`
    }
  })
}

export async function logClaimDocumentExtractionSkippedAudit(input: LogClaimDocumentExtractionResultInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_extraction_skipped',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      extractionStatus: input.extractionStatus,
      extractedAt: input.extractedAt ?? null,
      extractionWarnings: input.extractionWarnings ?? null,
      message: `Document extraction skipped (${input.extractionStatus})`
    }
  })
}

export async function logClaimDocumentEvidenceAppliedAudit(input: LogClaimDocumentEvidenceApplyInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_evidence_applied',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      applyStatus: input.applyStatus,
      appliedAt: input.appliedAt ?? null,
      appliedFields: input.appliedFields ?? [],
      skippedFields: input.skippedFields ?? [],
      conflictFields: input.conflictFields ?? [],
      message: `Document evidence applied (${input.applyStatus})`
    }
  })
}

export async function logClaimDocumentEvidencePartiallyAppliedAudit(input: LogClaimDocumentEvidenceApplyInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_evidence_partially_applied',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      applyStatus: input.applyStatus,
      appliedAt: input.appliedAt ?? null,
      appliedFields: input.appliedFields ?? [],
      skippedFields: input.skippedFields ?? [],
      conflictFields: input.conflictFields ?? [],
      message: `Document evidence partially applied (${input.applyStatus})`
    }
  })
}

export async function logClaimDocumentEvidenceConflictDetectedAudit(input: LogClaimDocumentEvidenceApplyInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_evidence_conflict_detected',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      applyStatus: input.applyStatus,
      appliedAt: input.appliedAt ?? null,
      appliedFields: input.appliedFields ?? [],
      skippedFields: input.skippedFields ?? [],
      conflictFields: input.conflictFields ?? [],
      message: `Document evidence conflict detected (${input.applyStatus})`
    }
  })
}

export async function logClaimDocumentEvidenceSkippedAudit(input: LogClaimDocumentEvidenceApplyInput) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_evidence_skipped',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      applyStatus: input.applyStatus,
      appliedAt: input.appliedAt ?? null,
      appliedFields: input.appliedFields ?? [],
      skippedFields: input.skippedFields ?? [],
      conflictFields: input.conflictFields ?? [],
      message: `Document evidence skipped (${input.applyStatus})`
    }
  })
}

export async function logClaimDocumentEvidenceTriggeredRefreshAudit(
  input: LogClaimDocumentEvidenceTriggeredRefreshInput
) {
  return writeAuditLog({
    client: input.client,
    action: 'claim_document_evidence_triggered_refresh',
    claimId: input.claimId,
    metadata: {
      claimId: input.claimId,
      claimNumber: input.claimNumber,
      documentId: input.documentId,
      fileName: input.fileName,
      documentType: input.documentType,
      applyStatus: input.applyStatus,
      queueEnqueued: input.queueEnqueued,
      queueReason: input.queueReason ?? null,
      queueName: input.queueName ?? null,
      jobName: input.jobName ?? null,
      jobId: input.jobId ?? null,
      message: input.queueEnqueued
        ? 'Summary/adjudication refresh queued from document evidence update'
        : `Summary/adjudication refresh skipped (${input.queueReason ?? 'unknown'})`
    }
  })
}

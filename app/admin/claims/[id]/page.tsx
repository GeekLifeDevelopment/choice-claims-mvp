import '../../../../lib/config/ensure-database-url'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { HeicImagePreview } from '../../../../components/HeicImagePreview'
import { ClaimStatus } from '../../../../lib/domain/claims'
import { getProviderConfigStatus } from '../../../../lib/providers/config'
import {
  getProviderHealthStatus,
  type ProviderHealthStatus
} from '../../../../lib/providers/provider-health-log'
import { prisma } from '../../../../lib/prisma'
import type {
  AdjudicationQuestionStatus,
  AdjudicationResult
} from '../../../../lib/review/adjudication-result'
import {
  buildClaimDocumentEvidenceReadModel,
  formatDocumentEvidenceSlotState,
  type ClaimDocumentEvidenceSlotContribution
} from '../../../../lib/review/document-evidence-read-model'
import { isClaimLockedForProcessing } from '../../../../lib/review/claim-lock'
import { extractCognitoAttachments } from '../../../../lib/intake/extract-cognito-attachments'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

function formatIsoDate(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return '—'
  }

  return formatDate(parsed)
}

function formatFileSize(value?: number | null): string {
  if (!value || value <= 0) {
    return '—'
  }

  return `${Math.round((value / 1024) * 10) / 10} KB`
}

function normalizeLookupKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function findFirstPayloadString(rawPayload: unknown, candidateKeys: string[]): string | null {
  const targetKeys = new Set(candidateKeys.map((entry) => normalizeLookupKey(entry)))
  const queue: unknown[] = [rawPayload]
  const seen = new Set<unknown>()

  while (queue.length > 0 && seen.size < 1000) {
    const current = queue.shift()

    if (!current || seen.has(current)) {
      continue
    }

    seen.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    const record = asRecord(current)
    if (Object.keys(record).length === 0) {
      continue
    }

    for (const [key, value] of Object.entries(record)) {
      if (!targetKeys.has(normalizeLookupKey(key))) {
        continue
      }

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim()
      }
    }

    queue.push(...Object.values(record))
  }

  return null
}

function formatClaimSubmissionMileage(rawPayload: unknown): string {
  const rawMileage = findFirstPayloadString(rawPayload, ['MilesOnVehicle', 'milesOnVehicle', 'MileageAtSubmission'])
  if (!rawMileage) {
    return '—'
  }

  const parsed = Number(rawMileage.replace(/,/g, '').trim())
  if (!Number.isFinite(parsed)) {
    return rawMileage
  }

  return parsed.toLocaleString('en-US')
}

function parseClaimSubmissionMileage(rawPayload: unknown): number | null {
  const rawMileage = findFirstPayloadString(rawPayload, ['MilesOnVehicle', 'milesOnVehicle', 'MileageAtSubmission'])
  if (!rawMileage) {
    return null
  }

  const parsed = Number(rawMileage.replace(/[,$\s]/g, ''))
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return Math.round(parsed)
}

function withCognitoSubmissionMileageEvidence(input: {
  vinDataResult: Record<string, unknown>
  rawSubmissionPayload: unknown
  claimSource: unknown
}): Record<string, unknown> {
  const source = typeof input.claimSource === 'string' ? input.claimSource.toLowerCase() : ''
  if (!source.includes('cognito')) {
    return input.vinDataResult
  }

  const existingMileage = getValueAtPath(input.vinDataResult, 'serviceHistory.latestMileage')
  if (hasManualSlotValue(existingMileage)) {
    return input.vinDataResult
  }

  const submissionMileage = parseClaimSubmissionMileage(input.rawSubmissionPayload)
  if (submissionMileage === null) {
    return input.vinDataResult
  }

  const nowIso = new Date().toISOString()
  const nextVinDataResult = asRecord(input.vinDataResult)
  const nextServiceHistory = asRecord(nextVinDataResult.serviceHistory)
  nextServiceHistory.latestMileage = submissionMileage
  nextVinDataResult.serviceHistory = nextServiceHistory

  const nextDocumentEvidence = asRecord(nextVinDataResult.documentEvidence)
  const nextProvenance = asRecord(nextDocumentEvidence.provenance)
  const mileagePath = 'serviceHistory.latestMileage'
  const existingProvenance = asRecord(nextProvenance[mileagePath])

  nextProvenance[mileagePath] = {
    source: getOptionalString(existingProvenance.source) || 'cognito_form',
    sourceDocumentId: getOptionalString(existingProvenance.sourceDocumentId),
    sourceDocumentType: getOptionalString(existingProvenance.sourceDocumentType) || 'cognito_submission',
    appliedAt: getOptionalString(existingProvenance.appliedAt) || nowIso,
    slot: getOptionalString(existingProvenance.slot) || 'currentMileage'
  }

  nextDocumentEvidence.provenance = nextProvenance
  nextVinDataResult.documentEvidence = nextDocumentEvidence

  return nextVinDataResult
}

type CognitoAttachmentLabelCandidate = {
  filename: string
  mimeType?: string
  fileSize?: number
  sourceUrl?: string
  externalId?: string
  sourceFieldLabel: string
}

function buildCognitoAttachmentLabelCandidates(rawPayload: unknown): CognitoAttachmentLabelCandidate[] {
  return extractCognitoAttachments(rawPayload)
    .filter((entry): entry is CognitoAttachmentLabelCandidate => Boolean(entry.sourceFieldLabel))
    .map((entry) => ({
      filename: entry.filename,
      mimeType: entry.mimeType,
      fileSize: entry.fileSize,
      sourceUrl: entry.sourceUrl,
      externalId: entry.externalId,
      sourceFieldLabel: entry.sourceFieldLabel as string
    }))
}

function resolveCognitoAttachmentFieldLabel(
  input: {
    filename?: string | null
    mimeType?: string | null
    fileSize?: number | null
    sourceUrl?: string | null
    externalId?: string | null
  },
  candidates: CognitoAttachmentLabelCandidate[]
): string | null {
  if (candidates.length === 0) {
    return null
  }

  if (input.sourceUrl) {
    const bySourceUrl = candidates.find((entry) => entry.sourceUrl === input.sourceUrl)
    if (bySourceUrl) {
      return bySourceUrl.sourceFieldLabel
    }
  }

  if (input.externalId) {
    const byExternalId = candidates.find((entry) => entry.externalId === input.externalId)
    if (byExternalId) {
      return byExternalId.sourceFieldLabel
    }
  }

  const fileName = input.filename?.trim().toLowerCase()
  if (!fileName) {
    return null
  }

  const matchingFileName = candidates.filter((entry) => entry.filename.trim().toLowerCase() === fileName)
  if (matchingFileName.length === 0) {
    return null
  }

  if (typeof input.fileSize === 'number') {
    const byFileSize = matchingFileName.find((entry) => entry.fileSize === input.fileSize)
    if (byFileSize) {
      return byFileSize.sourceFieldLabel
    }
  }

  if (input.mimeType) {
    const normalizedMime = input.mimeType.toLowerCase()
    const byMimeType = matchingFileName.find((entry) => entry.mimeType?.toLowerCase() === normalizedMime)
    if (byMimeType) {
      return byMimeType.sourceFieldLabel
    }
  }

  const distinctLabels = new Set(matchingFileName.map((entry) => entry.sourceFieldLabel))
  if (distinctLabels.size === 1) {
    return matchingFileName[0]?.sourceFieldLabel || null
  }

  return null
}

function getFilenameExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.')
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
    return ''
  }

  return filename.slice(lastDotIndex + 1).toLowerCase()
}

function isImageAttachment(input: { filename: string; mimeType?: string | null }): boolean {
  const mimeType = (input.mimeType || '').toLowerCase()
  if (mimeType.startsWith('image/')) {
    return true
  }

  const extension = getFilenameExtension(input.filename)
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif', 'tiff'].includes(extension)
}

function isPdfAttachment(input: { filename: string; mimeType?: string | null }): boolean {
  const mimeType = (input.mimeType || '').toLowerCase()
  if (mimeType.includes('pdf')) {
    return true
  }

  return getFilenameExtension(input.filename) === 'pdf'
}

function isHeicAttachment(input: { filename: string; mimeType?: string | null }): boolean {
  const mimeType = (input.mimeType || '').toLowerCase()
  if (mimeType.includes('heic') || mimeType.includes('heif')) {
    return true
  }

  const extension = getFilenameExtension(input.filename)
  return extension === 'heic' || extension === 'heif'
}

function getAttachmentTypeLabel(input: { filename: string; mimeType?: string | null }): string {
  if (isImageAttachment(input)) {
    return 'Image'
  }

  if (isPdfAttachment(input)) {
    return 'PDF'
  }

  return 'File'
}

function isSafePreviewUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  return value.startsWith('https://') || value.startsWith('http://')
}

function formatMetadataPreview(value: unknown): string {
  if (value == null) {
    return '—'
  }

  const serialized = JSON.stringify(value)
  if (!serialized) {
    return '—'
  }

  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized
}

function formatReviewDecisionChangeMetadata(value: unknown): {
  fromDecision: string
  toDecision: string
  reviewer: string
  notes: string
  overrideUsed: boolean
  overrideReason: string
} | null {
  const metadata = asRecord(value)
  const toDecision = getOptionalString(metadata.toDecision)

  if (!toDecision) {
    return null
  }

  return {
    fromDecision: getOptionalString(metadata.fromDecision) || 'Unset',
    toDecision,
    reviewer: getOptionalString(metadata.reviewer) || '—',
    notes: getOptionalString(metadata.notes) || '—',
    overrideUsed: getOptionalBoolean(metadata.overrideUsed) || false,
    overrideReason: getOptionalString(metadata.overrideReason) || '—'
  }
}

function getAuditActor(metadata: Record<string, unknown>): string | null {
  return (
    getOptionalString(metadata.actor) ||
    getOptionalString(metadata.reviewer) ||
    getOptionalString(metadata.by) ||
    getOptionalString(metadata.user)
  )
}

function getAuditProvider(metadata: Record<string, unknown>): string | null {
  return getOptionalString(metadata.provider) || getOptionalString(metadata.providerName)
}

function getAuditMessage(action: string, metadata: unknown): string | null {
  if (action === 'review_decision_changed') {
    const change = formatReviewDecisionChangeMetadata(metadata)
    if (change) {
      if (change.fromDecision === change.toDecision) {
        return `Decision saved: ${change.toDecision}`
      }

      return `Decision changed: ${change.fromDecision} -> ${change.toDecision}`
    }
  }

  const record = asRecord(metadata)

  return (
    getOptionalString(record.message) ||
    getOptionalString(record.errorMessage) ||
    getOptionalString(record.reason) ||
    getOptionalString(record.notes)
  )
}

const AUDIT_TIMELINE_LIMIT = 100
const BADGE_BASE_CLASSNAME = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold'
const REVIEWER_LOW_CONFIDENCE_THRESHOLD = 0.4
const REVIEWER_LOW_COMPLETENESS_THRESHOLD = 0.4
const CRITICAL_MISSING_DATA_KEYWORDS = ['mileage', 'purchase date', 'valuation', 'warranty']
const SUPPORTED_CONFLICT_RESOLUTION_PATHS = new Set<string>([
  'documentEvidence.contract.vehiclePurchaseDate',
  'documentEvidence.contract.agreementPurchaseDate',
  'documentEvidence.contract.mileageAtSale',
  'serviceHistory.latestMileage',
  'documentEvidence.contract.agreementNumber',
  'documentEvidence.contract.deductible',
  'documentEvidence.contract.termMonths',
  'documentEvidence.contract.termMiles',
  'documentEvidence.contract.coverageLevel',
  'documentEvidence.contract.planName',
  'documentEvidence.contract.warrantyCoverageSummary',
  'valuation.contextNote',
  'documentEvidence.contract.obdCodes'
])

type ConflictResolutionViewModel = {
  conflictKey: string
  fieldPath: string
  fieldLabel: string
  slotLabel: string | null
  reason: string
  existingValue: unknown
  incomingValue: unknown
  currentValue: unknown
  sourceLabel: string
  sourceDocumentId: string | null
  sourceDocumentName: string | null
  sourceDocumentType: string | null
  detectedAt: string | null
}

type ResolvedConflictViewModel = {
  fieldPath: string
  fieldLabel: string
  winner: string
  winningSource: string | null
  losingSource: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  note: string | null
}

function formatEvidenceSourceLabel(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown source'
  }

  if (value === 'uploaded_document') {
    return 'Manual upload'
  }

  if (value === 'cognito_form') {
    return 'Cognito form'
  }

  if (value === 'manual_reviewer_entry') {
    return 'Manual reviewer entry'
  }

  if (value === 'existing_claim_value') {
    return 'Existing claim value'
  }

  return value
}

function formatConflictValuePreview(value: unknown): string {
  if (value === null || value === undefined) {
    return '—'
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : '—'
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry)))
      .filter((entry) => entry.length > 0)
    return normalized.length > 0 ? normalized.join(', ') : '—'
  }

  const serialized = JSON.stringify(value)
  return serialized && serialized.length > 0 ? serialized : '—'
}

function formatConflictFieldLabel(fieldPath: string): string {
  const segment = fieldPath.split('.').pop() || fieldPath
  return segment
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function getAuditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    claim_created: 'Claim created',
    claim_document_uploaded: 'Document uploaded',
    claim_document_removed: 'Document removed',
    claim_document_reprocess_requested: 'Document reprocess requested',
    claim_document_reprocessed: 'Document reprocessed',
    claim_document_reprocess_failed: 'Document reprocess failed',
    claim_document_reuploaded: 'Document reuploaded',
    claim_document_classified: 'Document classified',
    claim_document_match_evaluated: 'Document match evaluated',
    claim_document_extraction_attempted: 'Document extraction attempted',
    claim_document_extraction_succeeded: 'Document extraction succeeded',
    claim_document_extraction_partial: 'Document extraction partial',
    claim_document_extraction_failed: 'Document extraction failed',
    claim_document_extraction_skipped: 'Document extraction skipped',
    claim_document_choice_fallback_attempted: 'Choice OCR fallback attempted',
    claim_document_choice_fallback_succeeded: 'Choice OCR fallback succeeded',
    claim_document_choice_fallback_partial: 'Choice OCR fallback partial',
    claim_document_choice_fallback_failed: 'Choice OCR fallback failed',
    claim_document_evidence_applied: 'Document evidence applied',
    claim_document_evidence_partially_applied: 'Document evidence partially applied',
    claim_document_evidence_conflict_detected: 'Document evidence conflict detected',
    claim_document_evidence_skipped: 'Document evidence skipped',
    claim_document_evidence_triggered_refresh: 'Document evidence triggered refresh',
    manual_evidence_entered: 'Manual evidence entered',
    manual_evidence_triggered_refresh: 'Manual evidence triggered refresh',
    evidence_conflict_resolved: 'Evidence conflict resolved',
    evidence_conflict_resolution_triggered_refresh: 'Conflict resolution triggered refresh',
    evidence_conflict_resolution_blocked: 'Conflict resolution blocked',
    duplicate_blocked: 'Duplicate blocked',
    vin_lookup_enqueued: 'VIN lookup queued',
    vin_lookup_requeued: 'VIN retry requested',
    vin_data_fetched: 'VIN data fetched',
    vin_data_fetch_failed: 'VIN data fetch failed',
    review_summary_queued: 'Review summary queued',
    review_summary_generated: 'Review summary generated',
    review_summary_failed: 'Summary generation failed',
    review_summary_regenerate_queued: 'Summary regeneration queued',
    review_summary_regenerated: 'Summary regenerated',
    review_decision_changed: 'Decision saved',
    review_decision_saved: 'Decision saved',
    intake_validation_failed: 'Validation failed'
  }

  return labels[action] || action.replace(/_/g, ' ')
}

function getTimelineEventBadgeClassName(action: string): string {
  const base = BADGE_BASE_CLASSNAME

  if (
    action === 'claim_created' ||
    action === 'vin_data_fetched' ||
    action === 'review_summary_generated' ||
    action === 'review_summary_regenerated'
  ) {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (action === 'review_decision_changed' || action === 'review_decision_saved') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (
    action === 'claim_document_uploaded' ||
    action === 'claim_document_removed' ||
    action === 'claim_document_reprocess_requested' ||
    action === 'claim_document_reprocessed' ||
    action === 'claim_document_reprocess_failed' ||
    action === 'claim_document_reuploaded' ||
    action === 'claim_document_classified' ||
    action === 'claim_document_match_evaluated' ||
    action === 'claim_document_extraction_attempted' ||
    action === 'claim_document_extraction_succeeded' ||
    action === 'claim_document_extraction_partial' ||
    action === 'claim_document_extraction_skipped' ||
    action === 'claim_document_choice_fallback_attempted' ||
    action === 'claim_document_choice_fallback_succeeded' ||
    action === 'claim_document_choice_fallback_partial' ||
    action === 'claim_document_evidence_applied' ||
    action === 'claim_document_evidence_partially_applied' ||
    action === 'claim_document_evidence_skipped' ||
    action === 'claim_document_evidence_triggered_refresh' ||
    action === 'manual_evidence_entered' ||
    action === 'manual_evidence_triggered_refresh' ||
    action === 'evidence_conflict_resolved' ||
    action === 'evidence_conflict_resolution_triggered_refresh'
  ) {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (action === 'evidence_conflict_resolution_blocked') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (action === 'claim_document_classified' || action === 'claim_document_match_evaluated') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (action === 'claim_document_evidence_conflict_detected') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (action.includes('failed') || action.includes('error')) {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function getTimelineEventBadgeText(action: string): string {
  if (
    action === 'claim_created' ||
    action === 'vin_data_fetched' ||
    action === 'review_summary_generated' ||
    action === 'review_summary_regenerated'
  ) {
    return 'Key event'
  }

  if (action === 'review_decision_changed' || action === 'review_decision_saved') {
    return 'Decision'
  }

  if (action === 'claim_document_uploaded') {
    return 'Document'
  }

  if (
    action === 'claim_document_removed' ||
    action === 'claim_document_reuploaded' ||
    action === 'claim_document_reprocess_requested' ||
    action === 'claim_document_reprocessed' ||
    action === 'claim_document_reprocess_failed'
  ) {
    return 'Document'
  }

  if (action === 'claim_document_classified' || action === 'claim_document_match_evaluated') {
    return 'Document'
  }

  if (
    action === 'claim_document_extraction_attempted' ||
    action === 'claim_document_extraction_succeeded' ||
    action === 'claim_document_extraction_partial' ||
    action === 'claim_document_extraction_skipped' ||
    action === 'claim_document_extraction_failed' ||
    action === 'claim_document_choice_fallback_attempted' ||
    action === 'claim_document_choice_fallback_succeeded' ||
    action === 'claim_document_choice_fallback_partial' ||
    action === 'claim_document_choice_fallback_failed' ||
    action === 'claim_document_evidence_applied' ||
    action === 'claim_document_evidence_partially_applied' ||
    action === 'claim_document_evidence_conflict_detected' ||
    action === 'claim_document_evidence_skipped' ||
    action === 'manual_evidence_entered' ||
    action === 'evidence_conflict_resolved'
  ) {
    return 'Extraction'
  }

  if (
    action === 'claim_document_evidence_triggered_refresh' ||
    action === 'manual_evidence_triggered_refresh' ||
    action === 'evidence_conflict_resolution_triggered_refresh'
  ) {
    return 'Refresh'
  }

  if (action === 'evidence_conflict_resolution_blocked') {
    return 'Resolution'
  }

  if (action.includes('failed') || action.includes('error')) {
    return 'Attention'
  }

  return 'Activity'
}

function formatDateParts(value: Date): { date: string; time: string } {
  const formatted = formatDate(value)
  const [date, time] = formatted.split(' ')

  return {
    date: date || '—',
    time: time || '—'
  }
}

function getTimelineMetadataRows(action: string, metadata: unknown): Array<{ label: string; value: string }> {
  const record = asRecord(metadata)
  const source = getOptionalString(record.source)
  const reason = getOptionalString(record.reason)
  const reviewer = getOptionalString(record.reviewer)
  const provider = getOptionalString(record.provider)
  const queueName = getOptionalString(record.queueName)
  const jobName = getOptionalString(record.jobName)
  const jobId = getOptionalString(record.jobId)
  const toDecision = getOptionalString(record.toDecision)
  const fromDecision = getOptionalString(record.fromDecision)
  const fileName = getOptionalString(record.fileName)
  const mimeType = getOptionalString(record.mimeType)
  const documentId = getOptionalString(record.documentId)
  const uploadedBy = getOptionalString(record.uploadedBy)
  const removedBy = getOptionalString(record.removedBy)
  const requestedBy = getOptionalString(record.requestedBy)
  const removedAt = getOptionalString(record.removedAt)
  const processingStatus = getOptionalString(record.processingStatus)
  const documentType = getOptionalString(record.documentType)
  const matchStatus = getOptionalString(record.matchStatus)
  const matchNotes = getOptionalString(record.matchNotes)
  const extractionStatus = getOptionalString(record.extractionStatus)
  const extractedAt = getOptionalString(record.extractedAt)
  const extractedFieldCount = getOptionalNumber(record.extractedFieldCount)
  const extractionWarnings = getOptionalStringArray(record.extractionWarnings)
  const fallbackStatus = getOptionalString(record.fallbackStatus)
  const fallbackMethod = getOptionalString(record.method)
  const fallbackAttempted = getOptionalBoolean(record.attempted)
  const fallbackUsed = getOptionalBoolean(record.used)
  const fallbackTriggerReasons = getOptionalStringArray(record.triggerReasons)
  const fallbackFilledFields = getOptionalStringArray(record.filledFields)
  const fallbackFailureReason = getOptionalString(record.failureReason)
  const fallbackWarnings = getOptionalStringArray(record.warnings)
  const fallbackConfidence = getOptionalNumber(record.confidence)
  const applyStatus = getOptionalString(record.applyStatus)
  const appliedFields = getOptionalStringArray(record.appliedFields)
  const skippedFields = getOptionalStringArray(record.skippedFields)
  const conflictFields = getOptionalStringArray(record.conflictFields)
  const fileSize = getOptionalNumber(record.fileSize)
  const enteredBy = getOptionalString(record.enteredBy)
  const reviewerNote = getOptionalString(record.reviewerNote)
  const blockedFields = getOptionalStringArray(record.blockedFields)
  const field = getOptionalString(record.field)
  const winner = getOptionalString(record.winner)
  const winningSource = getOptionalString(record.winningSource)
  const losingSource = getOptionalString(record.losingSource)
  const resolvedBy = getOptionalString(record.resolvedBy)
  const valueChanged = getOptionalBoolean(record.valueChanged)

  const rows: Array<{ label: string; value: string }> = []

  if (provider) {
    rows.push({ label: 'Provider', value: provider })
  }

  if (queueName) {
    rows.push({ label: 'Queue', value: queueName })
  }

  if (source) {
    rows.push({ label: 'Source', value: source })
  }

  if (reviewer) {
    rows.push({ label: 'Reviewer', value: reviewer })
  }

  if (jobName) {
    rows.push({ label: 'Job', value: jobName })
  }

  if (jobId) {
    rows.push({ label: 'Job ID', value: jobId })
  }

  if (action === 'review_decision_changed') {
    if (toDecision) {
      rows.push({
        label: 'Decision',
        value: fromDecision ? `${fromDecision} -> ${toDecision}` : toDecision
      })
    }
  }

  if (
    action === 'claim_document_uploaded' ||
    action === 'claim_document_reprocess_requested' ||
    action === 'claim_document_reprocessed' ||
    action === 'claim_document_reprocess_failed' ||
    action === 'claim_document_extraction_attempted' ||
    action === 'claim_document_extraction_succeeded' ||
    action === 'claim_document_extraction_partial' ||
    action === 'claim_document_extraction_failed' ||
    action === 'claim_document_extraction_skipped' ||
    action === 'claim_document_choice_fallback_attempted' ||
    action === 'claim_document_choice_fallback_succeeded' ||
    action === 'claim_document_choice_fallback_partial' ||
    action === 'claim_document_choice_fallback_failed' ||
    action === 'claim_document_evidence_applied' ||
    action === 'claim_document_evidence_partially_applied' ||
    action === 'claim_document_evidence_conflict_detected' ||
    action === 'claim_document_evidence_skipped'
  ) {
    if (fileName) {
      rows.push({ label: 'File', value: fileName })
    }

    if (mimeType) {
      rows.push({ label: 'MIME', value: mimeType })
    }

    if (fileSize !== null) {
      rows.push({ label: 'Size', value: formatFileSize(fileSize) })
    }

    if (uploadedBy) {
      rows.push({ label: 'Uploaded By', value: uploadedBy })
    }

    if (removedBy) {
      rows.push({ label: 'Removed By', value: removedBy })
    }

    if (requestedBy) {
      rows.push({ label: 'Requested By', value: requestedBy })
    }

    if (removedAt) {
      rows.push({ label: 'Removed At', value: removedAt })
    }

    if (processingStatus) {
      rows.push({ label: 'Processing', value: processingStatus })
    }

    if (documentType) {
      rows.push({ label: 'Document Type', value: documentType })
    }

    if (matchStatus) {
      rows.push({ label: 'Match Status', value: matchStatus })
    }

    if (matchNotes) {
      rows.push({ label: 'Match Notes', value: matchNotes })
    }

    if (documentId) {
      rows.push({ label: 'Document ID', value: documentId })
    }

    if (extractionStatus) {
      rows.push({ label: 'Extraction Status', value: extractionStatus })
    }

    if (extractedAt) {
      rows.push({ label: 'Extracted At', value: extractedAt })
    }

    if (extractedFieldCount !== null) {
      rows.push({ label: 'Extracted Fields', value: String(extractedFieldCount) })
    }

    if (extractionWarnings.length > 0) {
      rows.push({ label: 'Warnings', value: extractionWarnings.join(' | ') })
    }

    if (fallbackStatus) {
      rows.push({ label: 'Fallback Status', value: fallbackStatus })
    }

    if (fallbackMethod) {
      rows.push({ label: 'Fallback Method', value: fallbackMethod })
    }

    if (fallbackAttempted !== null) {
      rows.push({ label: 'Fallback Attempted', value: fallbackAttempted ? 'Yes' : 'No' })
    }

    if (fallbackUsed !== null) {
      rows.push({ label: 'Fallback Used', value: fallbackUsed ? 'Yes' : 'No' })
    }

    if (fallbackTriggerReasons.length > 0) {
      rows.push({ label: 'Fallback Triggers', value: fallbackTriggerReasons.join(' | ') })
    }

    if (fallbackFilledFields.length > 0) {
      rows.push({ label: 'Fallback Filled Fields', value: fallbackFilledFields.join(' | ') })
    }

    if (fallbackConfidence !== null) {
      rows.push({ label: 'Fallback Confidence', value: String(fallbackConfidence) })
    }

    if (fallbackWarnings.length > 0) {
      rows.push({ label: 'Fallback Warnings', value: fallbackWarnings.join(' | ') })
    }

    if (fallbackFailureReason) {
      rows.push({ label: 'Fallback Failure', value: fallbackFailureReason })
    }

    if (applyStatus) {
      rows.push({ label: 'Apply Status', value: applyStatus })
    }

    if (appliedFields.length > 0) {
      rows.push({ label: 'Applied Fields', value: appliedFields.join(' | ') })
    }

    if (skippedFields.length > 0) {
      rows.push({ label: 'Skipped Fields', value: skippedFields.join(' | ') })
    }

    if (conflictFields.length > 0) {
      rows.push({ label: 'Conflicts', value: conflictFields.join(' | ') })
    }
  }

  if (reason) {
    rows.push({ label: 'Reason', value: reason })
  }

  if (action === 'manual_evidence_entered' || action === 'manual_evidence_triggered_refresh') {
    if (enteredBy) {
      rows.push({ label: 'Entered By', value: enteredBy })
    }

    if (appliedFields.length > 0) {
      rows.push({ label: 'Applied Fields', value: appliedFields.join(' | ') })
    }

    if (blockedFields.length > 0) {
      rows.push({ label: 'Blocked Fields', value: blockedFields.join(' | ') })
    }

    if (reviewerNote) {
      rows.push({ label: 'Reviewer Note', value: reviewerNote })
    }
  }

  if (
    action === 'evidence_conflict_resolved' ||
    action === 'evidence_conflict_resolution_triggered_refresh' ||
    action === 'evidence_conflict_resolution_blocked'
  ) {
    if (field) {
      rows.push({ label: 'Field', value: field })
    }

    if (winner) {
      rows.push({ label: 'Winner', value: winner })
    }

    if (winningSource) {
      rows.push({ label: 'Winning Source', value: winningSource })
    }

    if (losingSource) {
      rows.push({ label: 'Losing Source', value: losingSource })
    }

    if (resolvedBy) {
      rows.push({ label: 'Resolved By', value: resolvedBy })
    }

    if (valueChanged !== null) {
      rows.push({ label: 'Value Changed', value: valueChanged ? 'Yes' : 'No' })
    }

    if (reviewerNote) {
      rows.push({ label: 'Reviewer Note', value: reviewerNote })
    }
  }

  return rows
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function getOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function getOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => getOptionalString(entry)).filter((entry): entry is string => Boolean(entry))
}

function getValueAtPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cursor: unknown = root

  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined
    }

    cursor = (cursor as Record<string, unknown>)[part]
  }

  return cursor
}

function formatManualFieldDisplayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—'
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
  }

  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : '—'
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : null))
      .filter((entry): entry is string => Boolean(entry))
    return entries.length > 0 ? entries.join(', ') : '—'
  }

  if (typeof value === 'object') {
    const serialized = JSON.stringify(value)
    return serialized.length > 0 ? serialized : '—'
  }

  return '—'
}

function hasManualSlotValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }

  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0
  }

  return false
}

function formatDetectedDocumentType(value: string | null | undefined): string {
  if (value === 'carfax') {
    return 'CARFAX'
  }

  if (value === 'autocheck') {
    return 'AutoCheck'
  }

  if (value === 'choice_contract') {
    return 'Choice Contract'
  }

  return 'Unknown'
}

function formatDocumentMatchStatus(value: string | null | undefined): string {
  if (!value) {
    return 'Pending'
  }

  if (value === 'possible_match') {
    return 'Possible match'
  }

  if (value === 'no_match') {
    return 'No match'
  }

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getDocumentMatchBadgeClassName(value: string | null | undefined): string {
  const base = BADGE_BASE_CLASSNAME

  if (value === 'matched') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (value === 'possible_match') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (value === 'conflict' || value === 'no_match') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-amber-300 bg-amber-50 text-amber-900`
}

function getDocumentAnchorSummary(value: unknown): string {
  const record = asRecord(value)
  const pieces: string[] = []

  const vin = getOptionalString(record.vin)
  if (vin) {
    pieces.push(`VIN ${vin}`)
  }

  const claimantName = getOptionalString(record.claimantName)
  if (claimantName) {
    pieces.push(`Name ${claimantName}`)
  }

  const mileage = getOptionalNumber(record.mileage)
  if (mileage !== null) {
    pieces.push(`Mileage ${String(mileage)}`)
  }

  const contractDate = getOptionalString(record.contractDate)
  if (contractDate) {
    pieces.push(`Contract date ${contractDate}`)
  }

  const purchaseDate = getOptionalString(record.purchaseDate)
  if (purchaseDate) {
    pieces.push(`Purchase date ${purchaseDate}`)
  }

  const agreementDate = getOptionalString(record.agreementDate)
  if (agreementDate) {
    pieces.push(`Agreement date ${agreementDate}`)
  }

  return pieces.length > 0 ? pieces.join(' | ') : '—'
}

function formatDocumentExtractionStatus(value: string | null | undefined): string {
  if (!value) {
    return 'Pending'
  }

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatEvidenceContributionSource(entry: ClaimDocumentEvidenceSlotContribution): string {
  const sourceName = entry.sourceDocumentName || entry.sourceDocumentId || 'Existing claim data'
  const pieces = [sourceName]

  if (entry.sourceDocumentType) {
    pieces.push(formatDetectedDocumentType(entry.sourceDocumentType))
  }

  const sourceLabel = entry.sourceLabel === 'manual_reviewer_entry' ? 'manual reviewer entry' : entry.sourceLabel
  pieces.push(sourceLabel)

  if (entry.extractionMethod) {
    pieces.push(`method ${entry.extractionMethod}`)
  }

  return pieces.join(' | ')
}

function getChoiceFallbackRecord(value: unknown): Record<string, unknown> {
  const extracted = asRecord(value)
  return asRecord(extracted.__choiceContractFallback)
}

function hasChoiceFallbackUsed(extractedData: unknown): boolean {
  const fallback = getChoiceFallbackRecord(extractedData)
  return getOptionalBoolean(fallback.used) === true
}

function formatDocumentExtractionLabel(input: {
  extractionStatus: string | null | undefined
  documentType: string | null | undefined
  extractedData: unknown
}): string {
  const base = formatDocumentExtractionStatus(input.extractionStatus)
  if (input.documentType === 'choice_contract' && hasChoiceFallbackUsed(input.extractedData)) {
    return `${base} (OpenAI fallback)`
  }

  return base
}

function getDocumentExtractionBadgeClassName(value: string | null | undefined): string {
  const base = BADGE_BASE_CLASSNAME

  if (value === 'extracted') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (value === 'partial') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (value === 'failed') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (value === 'skipped') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  return `${base} border-sky-300 bg-sky-50 text-sky-700`
}

function getDocumentExtractionSummary(documentType: string | null | undefined, extractedData: unknown): string {
  const record = asRecord(extractedData)
  if (Object.keys(record).length === 0) {
    return '—'
  }

  const pieces: string[] = []
  const vin = getOptionalString(record.vin)
  if (vin) {
    pieces.push(`VIN ${vin}`)
  }

  const mileage = getOptionalNumber(record.lastReportedMileage) ?? getOptionalNumber(record.mileageAtSale)
  if (mileage !== null) {
    pieces.push(`Mileage ${String(mileage)}`)
  }

  const ownerCount = getOptionalNumber(record.ownerCount)
  if (ownerCount !== null) {
    pieces.push(`Owners ${String(ownerCount)}`)
  }

  if (documentType === 'carfax') {
    const recalls = getOptionalString(record.openRecallSummary)
    const serviceCount = getOptionalNumber(record.serviceHistoryCount)
    if (recalls) {
      pieces.push(`Recalls ${recalls}`)
    }
    if (serviceCount !== null) {
      pieces.push(`Service ${String(serviceCount)}`)
    }
  }

  if (documentType === 'autocheck') {
    const recalls = getOptionalString(record.openRecallSummary)
    const serviceCount = getOptionalNumber(record.serviceRecordCount)
    const odometer = getOptionalString(record.odometerCheckSummary)
    if (recalls) {
      pieces.push(`Recalls ${recalls}`)
    }
    if (serviceCount !== null) {
      pieces.push(`Service ${String(serviceCount)}`)
    }
    if (odometer) {
      pieces.push(`Odometer ${odometer}`)
    }
  }

  if (documentType === 'choice_contract') {
    const plan = getOptionalString(record.coverageLevel)
    const termMonths = getOptionalNumber(record.termMonths)
    const termMiles = getOptionalNumber(record.termMiles)
    const deductible = getOptionalNumber(record.deductible)

    if (plan) {
      pieces.push(`Plan ${plan}`)
    }
    if (termMonths !== null || termMiles !== null) {
      const months = termMonths !== null ? `${String(termMonths)}mo` : '—'
      const miles = termMiles !== null ? `${String(termMiles)}mi` : '—'
      pieces.push(`Term ${months}/${miles}`)
    }
    if (deductible !== null) {
      pieces.push(`Deductible $${String(deductible)}`)
    }
  }

  return pieces.length > 0 ? pieces.join(' | ') : '—'
}

function getDocumentExtractionWarnings(value: unknown): string {
  const warnings = getOptionalStringArray(value)
  return warnings.length > 0 ? warnings.join(' | ') : '—'
}

function formatDocumentProcessingStatus(value: string | null | undefined): string {
  if (!value) {
    return 'Uploaded'
  }

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatClaimDocumentSource(uploadedBy: string | null | undefined): string {
  if (uploadedBy === 'cognito_form') {
    return 'Cognito form'
  }

  if (uploadedBy && uploadedBy.trim().length > 0) {
    return uploadedBy
  }

  return 'Manual upload'
}

function getDocumentProcessingPresentation(input: {
  processingStatus: string | null | undefined
  documentType: string | null | undefined
  matchStatus: string | null | undefined
  extractionStatus: string | null | undefined
}): { label: string; className: string; note: string | null } {
  const base = BADGE_BASE_CLASSNAME
  const label = formatDocumentProcessingStatus(input.processingStatus)

  if (input.matchStatus === 'conflict') {
    return {
      label,
      className: `${base} border-red-300 bg-red-50 text-red-700`,
      note: 'Conflict detected, manual review required.'
    }
  }

  if (input.extractionStatus === 'failed') {
    return {
      label,
      className: `${base} border-red-300 bg-red-50 text-red-700`,
      note: 'Extraction failed, reprocess recommended.'
    }
  }

  if (
    input.processingStatus === 'pending' &&
    (input.documentType === 'unknown' || !input.documentType) &&
    (input.extractionStatus === 'pending' || !input.extractionStatus)
  ) {
    return {
      label: 'Stale pending',
      className: `${base} border-amber-300 bg-amber-50 text-amber-900`,
      note: 'Document remained unclassified. Use reprocess to retry classification and extraction.'
    }
  }

  if (input.processingStatus === 'classified' && input.extractionStatus === 'partial') {
    return {
      label,
      className: `${base} border-amber-300 bg-amber-50 text-amber-900`,
      note: 'Partially extracted. Reprocess can retry field capture.'
    }
  }

  if (input.processingStatus === 'classified') {
    return {
      label,
      className: `${base} border-emerald-300 bg-emerald-50 text-emerald-700`,
      note: null
    }
  }

  return {
    label,
    className: `${base} border-slate-300 bg-slate-50 text-slate-700`,
    note: null
  }
}

function getDocumentEvidenceApplyRecord(value: unknown): Record<string, unknown> {
  const extracted = asRecord(value)
  return asRecord(extracted.__evidenceApply)
}

function formatDocumentEvidenceApplyStatus(value: unknown): string {
  const record = getDocumentEvidenceApplyRecord(value)
  const status = getOptionalString(record.applyStatus)

  if (!status) {
    return 'Pending'
  }

  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getDocumentEvidenceApplyBadgeClassName(value: unknown): string {
  const record = getDocumentEvidenceApplyRecord(value)
  const status = getOptionalString(record.applyStatus)
  const base = BADGE_BASE_CLASSNAME

  if (status === 'applied') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === 'partial') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (status === 'conflict') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (status === 'skipped') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  return `${base} border-sky-300 bg-sky-50 text-sky-700`
}

function getDocumentEvidenceApplySummary(value: unknown): string {
  const record = getDocumentEvidenceApplyRecord(value)
  const appliedFields = getOptionalStringArray(record.appliedFields)
  const skippedFields = getOptionalStringArray(record.skippedFields)
  const conflicts = Array.isArray(record.conflictFields) ? record.conflictFields.length : 0

  const parts: string[] = []
  parts.push(`Applied ${String(appliedFields.length)}`)
  parts.push(`Skipped ${String(skippedFields.length)}`)
  parts.push(`Conflicts ${String(conflicts)}`)

  return parts.join(' | ')
}

function getDocumentEvidenceConflictSummary(value: unknown): string {
  const record = getDocumentEvidenceApplyRecord(value)
  const conflictFields = Array.isArray(record.conflictFields) ? record.conflictFields : []
  if (conflictFields.length === 0) {
    return '—'
  }

  const labels = conflictFields
    .map((entry) => {
      const conflict = asRecord(entry)
      const field = getOptionalString(conflict.field)
      return field || null
    })
    .filter((entry): entry is string => Boolean(entry))

  return labels.length > 0 ? labels.join(' | ') : `${String(conflictFields.length)} conflict(s)`
}

function getDocumentAppliedAt(value: unknown): string {
  const record = getDocumentEvidenceApplyRecord(value)
  return formatIsoDate(getOptionalString(record.appliedAt))
}

function getDocumentOutcomeSummary(input: {
  documentType: string | null | undefined
  matchStatus: string | null | undefined
  matchNotes: string | null | undefined
  extractionStatus: string | null | undefined
  extractionWarnings: unknown
  extractedData: unknown
}): string {
  const parts: string[] = []
  const matchStatusLabel = formatDocumentMatchStatus(input.matchStatus)
  if (matchStatusLabel !== 'Pending') {
    parts.push(`Match ${matchStatusLabel}`)
  }

  if (input.matchStatus === 'conflict' && input.matchNotes) {
    parts.push(`Match conflict: ${input.matchNotes}`)
  }

  const extractionLabel = formatDocumentExtractionLabel({
    extractionStatus: input.extractionStatus,
    documentType: input.documentType,
    extractedData: input.extractedData
  })
  if (extractionLabel !== 'Pending') {
    parts.push(`Extraction ${extractionLabel}`)
  }

  if (input.documentType === 'choice_contract' && hasChoiceFallbackUsed(input.extractedData)) {
    parts.push('OCR/vision fallback used due to weak PDF text')
  }

  const warningCount = getOptionalStringArray(input.extractionWarnings).length
  if (warningCount > 0) {
    parts.push(`${String(warningCount)} warning${warningCount === 1 ? '' : 's'}`)
  }

  const applyRecord = getDocumentEvidenceApplyRecord(input.extractedData)
  const applyStatus = getOptionalString(applyRecord.applyStatus)
  if (applyStatus) {
    parts.push(`Apply ${formatDocumentEvidenceApplyStatus(input.extractedData)}`)
  }

  const appliedCount = getOptionalStringArray(applyRecord.appliedFields).length
  if (appliedCount > 0) {
    parts.push(`Applied ${String(appliedCount)} fields`)
  }

  const conflictCount = Array.isArray(applyRecord.conflictFields) ? applyRecord.conflictFields.length : 0
  if (conflictCount > 0) {
    parts.push(`${String(conflictCount)} conflicts detected`)
  }

  return parts.length > 0 ? parts.join(' | ') : 'Uploaded; processing pending'
}

type NhtsaRecallItem = {
  campaignId: string
  component: string
  summary: string
  remedy: string
  safetyRisk: string
  reportDate: string
}

type NhtsaRecallsViewModel = {
  count: number
  fetchedAt: string | null
  message: string | null
  items: NhtsaRecallItem[]
}

type VinSpecFallbackViewModel = {
  source: string
  fetchedAt: string | null
  year: number | null
  make: string | null
  model: string | null
  trim: string | null
  bodyStyle: string | null
  drivetrain: string | null
  transmissionType: string | null
  engineSize: string | null
  cylinders: string | null
  fuelType: string | null
  manufacturer: string | null
}

type TitleHistoryEventViewModel = {
  type: string
  summary: string
  eventDate: string | null
  state: string | null
}

type TitleHistoryViewModel = {
  source: string
  fetchedAt: string | null
  titleStatus: string | null
  brandFlags: string[]
  odometerFlags: string[]
  salvageIndicator: boolean | null
  junkIndicator: boolean | null
  rebuiltIndicator: boolean | null
  theftIndicator: boolean | null
  totalLossIndicator: boolean | null
  events: TitleHistoryEventViewModel[]
  message: string | null
}

type ServiceHistoryEventViewModel = {
  eventDate: string | null
  mileage: number | null
  serviceType: string | null
  description: string | null
  shop: string | null
}

type ServiceHistoryViewModel = {
  source: string
  fetchedAt: string | null
  eventCount: number
  latestMileage: number | null
  events: ServiceHistoryEventViewModel[]
  message: string | null
}

type ValuationViewModel = {
  source: string
  fetchedAt: string | null
  estimatedValue: number | null
  retailValue: number | null
  tradeInValue: number | null
  confidence: number | null
  currency: string | null
  message: string | null
}

function getAdjudicationResult(value: unknown): AdjudicationResult | null {
  const record = asRecord(value)
  const directAdjudicationRecord = asRecord(record.adjudicationResult)
  const reviewSummaryResultRecord = asRecord(record.reviewSummaryResult)
  const reviewSummaryAdjudicationRecord = asRecord(reviewSummaryResultRecord.adjudicationResult)
  const claimReviewSnapshotRecord = asRecord(record.claimReviewSnapshot)
  const snapshotAdjudicationRecord = asRecord(claimReviewSnapshotRecord.adjudicationResult)

  const adjudicationRecord =
    Object.keys(directAdjudicationRecord).length > 0
      ? directAdjudicationRecord
      : Object.keys(reviewSummaryAdjudicationRecord).length > 0
        ? reviewSummaryAdjudicationRecord
        : snapshotAdjudicationRecord

  const version = getOptionalString(adjudicationRecord.version)
  const generatedAt = getOptionalString(adjudicationRecord.generatedAt)
  const totalScore = getOptionalNumber(adjudicationRecord.totalScore)
  const recommendation = getOptionalString(adjudicationRecord.recommendation)
  const completeness = getOptionalString(adjudicationRecord.completeness)
  const summary = getOptionalString(adjudicationRecord.summary)
  const questions = Array.isArray(adjudicationRecord.questions) ? adjudicationRecord.questions : null

  if (!version || !generatedAt || totalScore === null || !recommendation || !completeness || !summary || !questions) {
    return null
  }

  return adjudicationRecord as unknown as AdjudicationResult
}

function getAdjudicationStatusBadgeClassName(status: AdjudicationQuestionStatus): string {
  const base = BADGE_BASE_CLASSNAME

  if (status === 'scored') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === 'insufficient_data') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (status === 'not_applicable') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  return `${base} border-red-300 bg-red-50 text-red-700`
}

function formatPercentFromFraction(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }

  return `${Math.round(value * 100)}%`
}

function getProviderStatusLabel(value: unknown): string {
  if (value === 'ok' || value === 'available') {
    return 'OK'
  }

  if (value === 'not_configured') {
    return 'Not configured'
  }

  if (value === 'error') {
    return 'Error'
  }

  if (value === 'no_result' || value === 'unavailable') {
    return 'No records'
  }

  if (value === 'not_applicable') {
    return 'Not applicable'
  }

  return 'Unknown'
}

function getProviderStatusBadgeClassName(value: unknown): string {
  const base = BADGE_BASE_CLASSNAME

  if (value === 'ok' || value === 'available') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (value === 'not_configured') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (value === 'error') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (value === 'no_result' || value === 'unavailable') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  if (value === 'not_applicable') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function getRecommendationBadgeClassName(value: unknown): string {
  const base = BADGE_BASE_CLASSNAME

  if (value === 'approve') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (value === 'partial') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (value === 'manual_review') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (value === 'deny') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function formatRecommendationLabel(value: unknown): string {
  if (value === 'manual_review') {
    return 'Manual Review'
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  return 'Unknown'
}

function formatReviewerDecisionLabel(value: string | null | undefined): string {
  if (!value) {
    return 'None'
  }

  if (value === 'NeedsReview') {
    return 'Needs Review'
  }

  if (value === 'Approved' || value === 'Denied' || value === 'Partial') {
    return value
  }

  return value
}

function getReviewerDecisionBadgeClassName(value: string | null | undefined): string {
  const base = BADGE_BASE_CLASSNAME

  if (value === 'Approved') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (value === 'Partial') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (value === 'Denied') {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  if (value === 'NeedsReview') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function normalizeDecisionForCompare(value: string | null | undefined): string {
  if (!value) {
    return 'none'
  }

  if (value === 'manual_review' || value === 'NeedsReview') {
    return 'manual_review'
  }

  if (value === 'approve' || value === 'Approved') {
    return 'approve'
  }

  if (value === 'deny' || value === 'Denied') {
    return 'deny'
  }

  if (value === 'partial' || value === 'Partial') {
    return 'partial'
  }

  return String(value).toLowerCase()
}

type ProviderHealthRow = {
  provider: string
  status: ProviderHealthStatus
  source: string
  note: string
}

function formatProviderHealthStatus(status: ProviderHealthStatus): string {
  if (status === 'missing_config') {
    return 'missing config'
  }

  return status
}

function getProviderHealthBadgeClassName(status: ProviderHealthStatus): string {
  const base = BADGE_BASE_CLASSNAME

  if (status === 'ok') {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === 'configured') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (status === 'stub') {
    return `${base} border-amber-300 bg-amber-50 text-amber-900`
  }

  if (status === 'missing_config') {
    return `${base} border-slate-300 bg-slate-50 text-slate-700`
  }

  return `${base} border-red-300 bg-red-50 text-red-700`
}

function getNhtsaRecalls(value: unknown): NhtsaRecallsViewModel | null {
  const record = asRecord(value)
  const nhtsaRecord = asRecord(record.nhtsaRecalls)

  if (Object.keys(nhtsaRecord).length === 0) {
    return null
  }

  const items = Array.isArray(nhtsaRecord.items)
    ? nhtsaRecord.items
        .map((item) => {
          const entry = asRecord(item)

          return {
            campaignId: getOptionalString(entry.campaignId) || '—',
            component: getOptionalString(entry.component) || '—',
            summary: getOptionalString(entry.summary) || '—',
            remedy: getOptionalString(entry.remedy) || '—',
            safetyRisk: getOptionalString(entry.safetyRisk) || '—',
            reportDate: getOptionalString(entry.reportDate) || '—'
          }
        })
        .filter((item) => item.campaignId !== '—' || item.summary !== '—')
    : []

  const count = getOptionalNumber(nhtsaRecord.count)

  return {
    count: count !== null ? count : items.length,
    fetchedAt: getOptionalString(nhtsaRecord.fetchedAt),
    message: getOptionalString(nhtsaRecord.message),
    items
  }
}

function getVinSpecFallback(value: unknown): VinSpecFallbackViewModel | null {
  const record = asRecord(value)
  const fallbackRecord = asRecord(record.vinSpecFallback)

  if (Object.keys(fallbackRecord).length === 0) {
    return null
  }

  return {
    source: getOptionalString(fallbackRecord.source) || 'nhtsa_vpic',
    fetchedAt: getOptionalString(fallbackRecord.fetchedAt),
    year: getOptionalNumber(fallbackRecord.year),
    make: getOptionalString(fallbackRecord.make),
    model: getOptionalString(fallbackRecord.model),
    trim: getOptionalString(fallbackRecord.trim),
    bodyStyle: getOptionalString(fallbackRecord.bodyStyle),
    drivetrain: getOptionalString(fallbackRecord.drivetrain),
    transmissionType: getOptionalString(fallbackRecord.transmissionType),
    engineSize: getOptionalString(fallbackRecord.engineSize),
    cylinders: getOptionalString(fallbackRecord.cylinders),
    fuelType: getOptionalString(fallbackRecord.fuelType),
    manufacturer: getOptionalString(fallbackRecord.manufacturer)
  }
}

function getTitleHistory(value: unknown): TitleHistoryViewModel | null {
  const record = asRecord(value)
  const titleHistoryRecord = asRecord(record.titleHistory)

  if (Object.keys(titleHistoryRecord).length === 0) {
    return null
  }

  const events = Array.isArray(titleHistoryRecord.events)
    ? titleHistoryRecord.events
        .map((entry) => {
          const eventRecord = asRecord(entry)
          const type = getOptionalString(eventRecord.type)
          const summary = getOptionalString(eventRecord.summary)

          if (!type || !summary) {
            return null
          }

          return {
            type,
            summary,
            eventDate: getOptionalString(eventRecord.eventDate),
            state: getOptionalString(eventRecord.state)
          }
        })
        .filter((entry): entry is TitleHistoryEventViewModel => Boolean(entry))
    : []

  const brandFlags = Array.isArray(titleHistoryRecord.brandFlags)
    ? titleHistoryRecord.brandFlags
        .map((entry) => getOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : []

  const odometerFlags = Array.isArray(titleHistoryRecord.odometerFlags)
    ? titleHistoryRecord.odometerFlags
        .map((entry) => getOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : []

  return {
    source: getOptionalString(titleHistoryRecord.source) || 'nmvtis_stub',
    fetchedAt: getOptionalString(titleHistoryRecord.fetchedAt),
    titleStatus: getOptionalString(titleHistoryRecord.titleStatus),
    brandFlags,
    odometerFlags,
    salvageIndicator: getOptionalBoolean(titleHistoryRecord.salvageIndicator),
    junkIndicator: getOptionalBoolean(titleHistoryRecord.junkIndicator),
    rebuiltIndicator: getOptionalBoolean(titleHistoryRecord.rebuiltIndicator),
    theftIndicator: getOptionalBoolean(titleHistoryRecord.theftIndicator),
    totalLossIndicator: getOptionalBoolean(titleHistoryRecord.totalLossIndicator),
    events,
    message: getOptionalString(titleHistoryRecord.message)
  }
}

function getServiceHistory(value: unknown): ServiceHistoryViewModel | null {
  const record = asRecord(value)
  const serviceHistoryRecord = asRecord(record.serviceHistory)

  if (Object.keys(serviceHistoryRecord).length === 0) {
    return null
  }

  const events = Array.isArray(serviceHistoryRecord.events)
    ? serviceHistoryRecord.events
        .map((entry) => {
          const eventRecord = asRecord(entry)

          return {
            eventDate: getOptionalString(eventRecord.eventDate),
            mileage: getOptionalNumber(eventRecord.mileage),
            serviceType: getOptionalString(eventRecord.serviceType),
            description: getOptionalString(eventRecord.description),
            shop: getOptionalString(eventRecord.shop)
          }
        })
        .filter((entry) =>
          Boolean(entry.eventDate || entry.mileage !== null || entry.serviceType || entry.description || entry.shop)
        )
    : []

  const eventCount = getOptionalNumber(serviceHistoryRecord.eventCount)

  return {
    source: getOptionalString(serviceHistoryRecord.source) || 'service_history_stub',
    fetchedAt: getOptionalString(serviceHistoryRecord.fetchedAt),
    eventCount: eventCount !== null ? eventCount : events.length,
    latestMileage: getOptionalNumber(serviceHistoryRecord.latestMileage),
    events,
    message: getOptionalString(serviceHistoryRecord.message)
  }
}

function getValuation(value: unknown): ValuationViewModel | null {
  const record = asRecord(value)
  const valuationRecord = asRecord(record.valuation)

  if (Object.keys(valuationRecord).length === 0) {
    return null
  }

  return {
    source: getOptionalString(valuationRecord.source) || 'valuation_stub',
    fetchedAt: getOptionalString(valuationRecord.fetchedAt),
    estimatedValue: getOptionalNumber(valuationRecord.estimatedValue),
    retailValue: getOptionalNumber(valuationRecord.retailValue),
    tradeInValue: getOptionalNumber(valuationRecord.tradeInValue),
    confidence: getOptionalNumber(valuationRecord.confidence),
    currency: getOptionalString(valuationRecord.currency) || 'USD',
    message: getOptionalString(valuationRecord.message)
  }
}

type PersistedRuleFlag = {
  code: string
  severity: string
  message: string
}

function getPersistedRuleFlags(value: unknown): PersistedRuleFlag[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null
      }

      const record = asRecord(item)
      const code = getOptionalString(record.code)
      const severity = getOptionalString(record.severity)
      const message = getOptionalString(record.message)

      if (!code || !severity || !message) {
        return null
      }

      return { code, severity, message }
    })
    .filter((flag): flag is PersistedRuleFlag => Boolean(flag))
}

function getProviderEndpointHint(raw: unknown): string | null {
  const rawRecord = asRecord(raw)
  if (rawRecord.vinspecifications !== undefined) {
    return 'vinspecifications'
  }

  const hasVinSpecificationsEnvelope = rawRecord.vinSpecifications !== undefined
  return hasVinSpecificationsEnvelope ? 'vinspecifications' : null
}

function getStatusBadgeClassName(status: string): string {
  const base = BADGE_BASE_CLASSNAME

  if (status === ClaimStatus.ReadyForAI) {
    return `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
  }

  if (status === ClaimStatus.AwaitingVinData) {
    return `${base} border-amber-300 bg-amber-50 text-amber-800`
  }

  if (status === ClaimStatus.ProviderFailed || status === ClaimStatus.ProcessingError) {
    return `${base} border-red-300 bg-red-50 text-red-700`
  }

  return `${base} border-slate-300 bg-slate-50 text-slate-700`
}

function formatClaimStatusLabel(status: string): string {
  if (status === ClaimStatus.ReadyForAI) {
    return 'Ready for Review'
  }

  if (status === ClaimStatus.AwaitingVinData) {
    return 'Collecting Vehicle Data'
  }

  if (status === ClaimStatus.ProviderFailed) {
    return 'Needs Data Retry'
  }

  if (status === ClaimStatus.ProcessingError) {
    return 'Needs Attention'
  }

  if (status === ClaimStatus.Submitted) {
    return 'Submitted'
  }

  return status
}

function formatSummaryStatusLabel(status: string | null | undefined): string {
  if (!status || status === 'NotRequested') {
    return 'Not Requested'
  }

  if (status === 'Queued') {
    return 'In Progress'
  }

  if (status === 'Generated') {
    return 'Generated'
  }

  if (status === 'Failed') {
    return 'Needs Retry'
  }

  return status
}

type PageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    retry?: string
    reviewDecision?: string
    summaryRegenerate?: string
    documentUpload?: string
    documentUploadCount?: string
    documentRemove?: string
    documentReprocess?: string
    manualEvidence?: string
    conflictResolution?: string
  }>
}

function getConflictResolutionBannerMessage(value: string | undefined): string | null {
  if (value === 'saved') {
    return 'Evidence conflict resolved.'
  }

  if (value === 'saved_refresh') {
    return 'Evidence conflict resolved and refresh queued.'
  }

  if (value === 'locked_final_decision') {
    return 'Conflict resolution blocked: this claim is locked by a final reviewer decision.'
  }

  if (value === 'unsupported-slot') {
    return 'Conflict resolution blocked: selected field is not supported in this version.'
  }

  if (value === 'stale') {
    return 'Conflict resolution could not be applied because this conflict is no longer active.'
  }

  if (value === 'invalid') {
    return 'Conflict resolution failed: invalid request payload.'
  }

  if (value === 'invalid-note') {
    return 'Conflict resolution failed: reviewer note is too long.'
  }

  if (value === 'not-found') {
    return 'Conflict resolution failed: claim was not found.'
  }

  if (value === 'error') {
    return 'Conflict resolution failed unexpectedly.'
  }

  return null
}

function getConflictResolutionBannerClassName(value: string | undefined): string {
  if (value === 'saved' || value === 'saved_refresh') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  if (value === 'locked_final_decision' || value === 'unsupported-slot' || value === 'stale') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getManualEvidenceBannerMessage(value: string | undefined): string | null {
  if (value === 'saved') {
    return 'Manual evidence saved and refresh queued.'
  }

  if (value === 'blocked-populated') {
    return 'Manual evidence was not applied because selected fields are already populated.'
  }

  if (value === 'locked_final_decision') {
    return 'Manual evidence blocked: this claim is locked by a final reviewer decision.'
  }

  if (value === 'invalid') {
    return 'Manual evidence save failed: one or more values are invalid.'
  }

  if (value === 'invalid-note') {
    return 'Manual evidence save failed: reviewer note is too long.'
  }

  if (value === 'empty') {
    return 'Manual evidence save skipped: enter at least one value.'
  }

  if (value === 'not-found') {
    return 'Manual evidence save failed: claim was not found.'
  }

  if (value === 'error') {
    return 'Manual evidence save failed unexpectedly.'
  }

  return null
}

function getManualEvidenceBannerClassName(value: string | undefined): string {
  if (value === 'saved') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  if (value === 'locked_final_decision' || value === 'blocked-populated') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getRetryBannerMessage(retryParam: string | undefined): string | null {
  if (retryParam === 'queued') {
    return 'VIN retry was queued successfully.'
  }

  if (retryParam === 'not-found') {
    return 'Retry failed: claim was not found.'
  }

  if (retryParam === 'invalid-status') {
    return 'Retry is only available when claim status is Submitted, ProviderFailed, or ProcessingError.'
  }

  if (retryParam === 'duplicate-blocked') {
    return 'Retry ignored: claim status changed and is no longer retryable.'
  }

  if (retryParam === 'enqueue-failed') {
    return 'Retry failed: unable to enqueue VIN lookup job.'
  }

  if (retryParam === 'locked_final_decision') {
    return 'Retry blocked: this claim is locked by a final reviewer decision.'
  }

  return null
}

function getRetryBannerClassName(retryParam: string | undefined): string {
  if (retryParam === 'locked_final_decision') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  if (retryParam === 'queued') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getReviewDecisionBannerMessage(value: string | undefined): string | null {
  if (value === 'saved') {
    return 'Reviewer decision was saved successfully.'
  }

  if (value === 'locked_final_decision') {
    return 'Save blocked: this claim is locked by a final reviewer decision.'
  }

  if (value === 'invalid') {
    return 'Save failed: review decision is invalid.'
  }

  if (value === 'invalid-notes') {
    return 'Save failed: reviewer notes are invalid.'
  }

  if (value === 'notes-too-long') {
    return 'Save failed: reviewer notes are too long.'
  }

  if (value === 'invalid-override-reason') {
    return 'Save failed: override reason is invalid.'
  }

  if (value === 'missing-override-reason') {
    return 'Save failed: override reason is required when override is enabled.'
  }

  if (value === 'override-reason-too-long') {
    return 'Save failed: override reason is too long.'
  }

  if (value === 'invalid-payload') {
    return 'Save failed: request payload is invalid.'
  }

  if (value === 'not-found') {
    return 'Save failed: claim was not found.'
  }

  if (value === 'error') {
    return 'Save failed: unable to update reviewer decision.'
  }

  return null
}

function getReviewDecisionBannerClassName(value: string | undefined): string {
  if (value === 'saved') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  if (value === 'locked_final_decision') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getSummaryRegenerateBannerMessage(value: string | undefined): string | null {
  if (value === 'queued') {
    return 'Summary regeneration was queued successfully.'
  }

  if (value === 'not-found') {
    return 'Summary regenerate failed: claim was not found.'
  }

  if (value === 'invalid-status') {
    return 'Summary regenerate is only available when claim status is ReadyForAI.'
  }

  if (value === 'missing-rule-evaluation') {
    return 'Summary regenerate blocked: rule evaluation is required first.'
  }

  if (value === 'already-queued') {
    return 'Summary regenerate ignored: generation is already queued.'
  }

  if (value === 'enqueue-failed') {
    return 'Summary regenerate failed: unable to enqueue summary job.'
  }

  if (value === 'locked_final_decision') {
    return 'Summary regenerate blocked: this claim is locked by a final reviewer decision.'
  }

  if (value === 'error') {
    return 'Summary regenerate failed unexpectedly.'
  }

  return null
}

function getSummaryRegenerateBannerClassName(value: string | undefined): string {
  if (value === 'locked_final_decision') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  if (value === 'queued') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getDocumentUploadCount(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function getDocumentUploadBannerMessage(value: string | undefined, count: number | null): string | null {
  if (value === 'uploaded') {
    if (count && count > 1) {
      return `Uploaded ${String(count)} documents successfully.`
    }

    return 'Document uploaded successfully.'
  }

  if (value === 'missing-file') {
    return 'Upload failed: select at least one PDF document.'
  }

  if (value === 'invalid-file') {
    return 'Upload failed: one or more files could not be processed.'
  }

  if (value === 'empty-file') {
    return 'Upload failed: uploaded file is empty.'
  }

  if (value === 'file-too-large') {
    return 'Upload failed: each PDF must be 15MB or smaller.'
  }

  if (value === 'invalid-file-type') {
    return 'Upload failed: only PDF files are supported.'
  }

  if (value === 'upload-failed') {
    return 'Upload failed: unable to persist one or more documents.'
  }

  if (value === 'not-found') {
    return 'Upload failed: claim was not found.'
  }

  return null
}

function getDocumentUploadBannerClassName(value: string | undefined): string {
  if (value === 'uploaded') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getDocumentRemoveBannerMessage(value: string | undefined): string | null {
  if (value === 'removed') {
    return 'Document removed. You can now re-upload and retest this claim.'
  }

  if (value === 'missing-document') {
    return 'Remove failed: document was not found for this claim.'
  }

  if (value === 'remove-failed') {
    return 'Remove failed: unable to delete this document.'
  }

  if (value === 'not-found') {
    return 'Remove failed: claim was not found.'
  }

  return null
}

function getDocumentRemoveBannerClassName(value: string | undefined): string {
  if (value === 'removed') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getDocumentReprocessBannerMessage(value: string | undefined): string | null {
  if (value === 'reprocessed') {
    return 'Document reprocessed successfully.'
  }

  if (value === 'missing-document') {
    return 'Reprocess failed: document was not found for this claim.'
  }

  if (value === 'file-unavailable') {
    return 'Reprocess failed: source file is missing from storage.'
  }

  if (value === 'failed') {
    return 'Reprocess failed: unable to refresh this document.'
  }

  if (value === 'not-found') {
    return 'Reprocess failed: claim was not found.'
  }

  if (value === 'locked_final_decision') {
    return 'Reprocess blocked: this claim is locked by a final reviewer decision.'
  }

  return null
}

function getDocumentReprocessBannerClassName(value: string | undefined): string {
  if (value === 'reprocessed') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
  }

  if (value === 'locked_final_decision') {
    return 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
  }

  return 'rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
}

function getSummaryRegenerateDisabledReason(input: {
  claimLockedForProcessing: boolean
  status: string
  reviewSummaryStatus: string | null
  reviewRuleEvaluatedAt: Date | null
}): string | null {
  if (input.claimLockedForProcessing) {
    return 'Claim locked by final decision'
  }

  if (input.status !== ClaimStatus.ReadyForAI) {
    return 'Summary regenerate is available when status is ReadyForAI'
  }

  if (!input.reviewRuleEvaluatedAt) {
    return 'Rule evaluation must be completed before summary regenerate'
  }

  if (input.reviewSummaryStatus === 'Queued') {
    return 'Summary generation is already queued'
  }

  return null
}

function isMissingClaimDocumentsFieldError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientValidationError)) {
    return false
  }

  return error.message.includes('Unknown field `claimDocuments`')
}

function isMissingClaimDocumentMetadataFieldError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientValidationError)) {
    return false
  }

  return (
    error.message.includes('Unknown field `matchNotes`') ||
    error.message.includes('Unknown field `parsedAnchors`')
  )
}

function isMissingClaimDocumentExtractionFieldError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientValidationError)) {
    return false
  }

  return (
    error.message.includes('Unknown field `extractionStatus`') ||
    error.message.includes('Unknown field `extractedAt`') ||
    error.message.includes('Unknown field `extractedData`') ||
    error.message.includes('Unknown field `extractionWarnings`')
  )
}

function isMissingClaimDocumentsTableError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false
  }

  return error.code === 'P2021'
}

export default async function AdminClaimDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const retryBannerMessage = getRetryBannerMessage(resolvedSearchParams.retry)
  const reviewDecisionBannerMessage = getReviewDecisionBannerMessage(resolvedSearchParams.reviewDecision)
  const summaryRegenerateBannerMessage = getSummaryRegenerateBannerMessage(
    resolvedSearchParams.summaryRegenerate
  )
  const documentUploadCount = getDocumentUploadCount(resolvedSearchParams.documentUploadCount)
  const documentUploadBannerMessage = getDocumentUploadBannerMessage(
    resolvedSearchParams.documentUpload,
    documentUploadCount
  )
  const documentRemoveBannerMessage = getDocumentRemoveBannerMessage(resolvedSearchParams.documentRemove)
  const documentReprocessBannerMessage = getDocumentReprocessBannerMessage(
    resolvedSearchParams.documentReprocess
  )
  const manualEvidenceBannerMessage = getManualEvidenceBannerMessage(resolvedSearchParams.manualEvidence)
  const conflictResolutionBannerMessage = getConflictResolutionBannerMessage(
    resolvedSearchParams.conflictResolution
  )

  const claimSelectBase = {
    id: true,
    claimNumber: true,
    status: true,
    source: true,
    claimantName: true,
    claimantEmail: true,
    claimantPhone: true,
    rawSubmissionPayload: true,
    vin: true,
    vinDataProvider: true,
    vinDataFetchedAt: true,
    vinDataResult: true,
    vinDataRawPayload: true,
    vinDataProviderResultCode: true,
    vinDataProviderResultMessage: true,
    vinLookupRetryRequestedAt: true,
    vinLookupAttemptCount: true,
    vinLookupLastError: true,
    vinLookupLastFailedAt: true,
    vinLookupLastJobId: true,
    vinLookupLastJobName: true,
    vinLookupLastQueueName: true,
    reviewRuleFlags: true,
    reviewRuleEvaluatedAt: true,
    reviewRuleVersion: true,
    reviewRuleLastError: true,
    reviewSummaryStatus: true,
    reviewSummaryEnqueuedAt: true,
    reviewSummaryGeneratedAt: true,
    reviewSummaryText: true,
    reviewSummaryLastError: true,
    reviewSummaryJobId: true,
    reviewSummaryVersion: true,
    reviewDecision: true,
    reviewDecisionSetAt: true,
    reviewDecisionNotes: true,
    reviewDecisionBy: true,
    reviewDecisionVersion: true,
    submittedAt: true,
    attachments: {
      orderBy: { uploadedAt: 'asc' },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        fileSize: true,
        sourceUrl: true,
        externalId: true,
        storageKey: true,
        uploadedAt: true
      }
    },
    auditLogs: {
      orderBy: { createdAt: 'desc' },
      take: AUDIT_TIMELINE_LIMIT,
      select: {
        id: true,
        action: true,
        metadata: true,
        createdAt: true
      }
    }
  } satisfies Prisma.ClaimSelect

  const claimSelectWithDocuments = {
    ...claimSelectBase,
    claimDocuments: {
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        storageKey: true,
        uploadedBy: true,
        processingStatus: true,
        documentType: true,
        matchStatus: true,
        matchNotes: true,
        parsedAnchors: true,
        extractionStatus: true,
        extractedAt: true,
        extractedData: true,
        extractionWarnings: true,
        uploadedAt: true
      }
    }
  } satisfies Prisma.ClaimSelect

  const claimSelectWithDocumentsWithoutExtraction = {
    ...claimSelectBase,
    claimDocuments: {
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        storageKey: true,
        uploadedBy: true,
        processingStatus: true,
        documentType: true,
        matchStatus: true,
        matchNotes: true,
        parsedAnchors: true,
        uploadedAt: true
      }
    }
  } satisfies Prisma.ClaimSelect

  const claimSelectWithDocumentsLegacy = {
    ...claimSelectBase,
    claimDocuments: {
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        storageKey: true,
        uploadedBy: true,
        processingStatus: true,
        documentType: true,
        matchStatus: true,
        uploadedAt: true
      }
    }
  } satisfies Prisma.ClaimSelect

  let claimRecord: Record<string, unknown> | null = null

  try {
    claimRecord = (await prisma.claim.findUnique({
      where: { id },
      select: claimSelectWithDocuments
    })) as Record<string, unknown> | null
  } catch (error) {
    const isMissingDocumentsField = isMissingClaimDocumentsFieldError(error)
    const isMissingDocumentsTable = isMissingClaimDocumentsTableError(error)
    const isMissingDocumentMetadataField = isMissingClaimDocumentMetadataFieldError(error)
    const isMissingDocumentExtractionField = isMissingClaimDocumentExtractionFieldError(error)

    if (
      !isMissingDocumentsField &&
      !isMissingDocumentsTable &&
      !isMissingDocumentMetadataField &&
      !isMissingDocumentExtractionField
    ) {
      throw error
    }

    if (isMissingDocumentExtractionField) {
      console.warn('[claim_document] extraction fields unavailable; using metadata-only select', {
        claimId: id,
        reason: 'missing_extraction_field_in_client'
      })

      try {
        claimRecord = (await prisma.claim.findUnique({
          where: { id },
          select: claimSelectWithDocumentsWithoutExtraction
        })) as Record<string, unknown> | null
      } catch (withoutExtractionError) {
        const withoutExtractionMissingMetadata = isMissingClaimDocumentMetadataFieldError(withoutExtractionError)
        const withoutExtractionMissingRelation = isMissingClaimDocumentsFieldError(withoutExtractionError)
        const withoutExtractionMissingTable = isMissingClaimDocumentsTableError(withoutExtractionError)

        if (!withoutExtractionMissingMetadata && !withoutExtractionMissingRelation && !withoutExtractionMissingTable) {
          throw withoutExtractionError
        }

        if (withoutExtractionMissingMetadata) {
          console.warn('[claim_document] metadata fields unavailable after extraction fallback; using legacy select', {
            claimId: id,
            reason: 'missing_document_metadata_field_in_client'
          })

          claimRecord = (await prisma.claim.findUnique({
            where: { id },
            select: claimSelectWithDocumentsLegacy
          })) as Record<string, unknown> | null
        } else {
          console.warn('[claim_document] claimDocuments unavailable after extraction fallback; using base select', {
            claimId: id,
            reason: withoutExtractionMissingRelation ? 'missing_relation_in_client' : 'missing_table_in_database'
          })

          claimRecord = (await prisma.claim.findUnique({
            where: { id },
            select: claimSelectBase
          })) as Record<string, unknown> | null
        }
      }
    } else if (isMissingDocumentMetadataField) {
      console.warn('[claim_document] claimDocuments metadata fields unavailable; using legacy select', {
        claimId: id,
        reason: 'missing_document_metadata_field_in_client'
      })

      try {
        claimRecord = (await prisma.claim.findUnique({
          where: { id },
          select: claimSelectWithDocumentsLegacy
        })) as Record<string, unknown> | null
      } catch (legacyError) {
        if (!isMissingClaimDocumentsFieldError(legacyError) && !isMissingClaimDocumentsTableError(legacyError)) {
          throw legacyError
        }

        console.warn('[claim_document] claimDocuments relation unavailable after legacy fallback; using base select', {
          claimId: id,
          reason: isMissingClaimDocumentsFieldError(legacyError)
            ? 'missing_relation_in_client'
            : 'missing_table_in_database'
        })

        claimRecord = (await prisma.claim.findUnique({
          where: { id },
          select: claimSelectBase
        })) as Record<string, unknown> | null
      }
    } else {
      console.warn('[claim_document] claimDocuments unavailable; falling back', {
        claimId: id,
        reason: isMissingDocumentsField ? 'missing_relation_in_client' : 'missing_table_in_database'
      })

      claimRecord = (await prisma.claim.findUnique({
        where: { id },
        select: claimSelectBase
      })) as Record<string, unknown> | null
    }
  }

  const claim = claimRecord as any

  if (claim && !Array.isArray(claim.claimDocuments)) {
    claim.claimDocuments = []
  }

  if (claim && Array.isArray(claim.claimDocuments)) {
    claim.claimDocuments = claim.claimDocuments.map((document: any) => ({
      ...document,
      storageKey: typeof document.storageKey === 'string' ? document.storageKey : null,
      matchNotes: document.matchNotes ?? null,
      parsedAnchors: document.parsedAnchors ?? null,
      extractionStatus: document.extractionStatus ?? 'pending',
      extractedAt: document.extractedAt ?? null,
      extractedData: document.extractedData ?? null,
      extractionWarnings: document.extractionWarnings ?? null
    }))
  }

  if (!claim) {
    notFound()
  }

  const baseVinDataResult = asRecord(claim.vinDataResult)
  const vinDataResult = withCognitoSubmissionMileageEvidence({
    vinDataResult: baseVinDataResult,
    rawSubmissionPayload: claim.rawSubmissionPayload,
    claimSource: claim.source
  })
  const legacyEmbeddedRawPayload = vinDataResult.raw
  const resolvedRawProviderPayload = claim.vinDataRawPayload ?? legacyEmbeddedRawPayload ?? null
  const vinDataYear = getOptionalNumber(vinDataResult.year)
  const vinDataMake = getOptionalString(vinDataResult.make)
  const vinDataModel = getOptionalString(vinDataResult.model)
  const vinSpecFallback = getVinSpecFallback(vinDataResult)
  const nhtsaRecalls = getNhtsaRecalls(vinDataResult)
  const titleHistory = getTitleHistory(vinDataResult)
  const serviceHistory = getServiceHistory(vinDataResult)
  const valuation = getValuation(vinDataResult)
  const adjudicationResult = getAdjudicationResult(vinDataResult)
  const providerEndpointHint = getProviderEndpointHint(resolvedRawProviderPayload)
  const latestReviewDecisionAudit = claim.auditLogs.find(
    (auditLog: any) => auditLog.action === 'review_decision_changed'
  )
  const latestReviewDecisionChange = latestReviewDecisionAudit
    ? formatReviewDecisionChangeMetadata(latestReviewDecisionAudit.metadata)
    : null
  const currentOverrideUsed = latestReviewDecisionChange?.overrideUsed || false
  const currentOverrideReason =
    latestReviewDecisionChange && latestReviewDecisionChange.overrideReason !== '—'
      ? latestReviewDecisionChange.overrideReason
      : ''
  const timelineAuditLogs = claim.auditLogs
  const persistedRuleFlags = getPersistedRuleFlags(claim.reviewRuleFlags)
  const hasLegacyRuleFlags = persistedRuleFlags.length > 0
  const adjudicationReasons = Array.isArray(adjudicationResult?.reasons)
    ? adjudicationResult.reasons.filter(
        (reason): reason is string => typeof reason === 'string' && reason.trim().length > 0
      )
    : []
  const adjudicationMissingData = adjudicationResult
    ? Array.from(
        new Set(
          adjudicationResult.questions.flatMap((question) =>
            Array.isArray(question.missing)
              ? question.missing.filter(
                  (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
                )
              : []
          )
        )
      )
    : []
  const adjudicationProviderGaps = adjudicationResult
    ? adjudicationResult.questions
        .filter((question) => question.providerStatus !== 'available')
        .map((question) => `${question.title}: ${getProviderStatusLabel(question.providerStatus)}`)
    : []
  const hasAdjudicationSignals =
    adjudicationReasons.length > 0 || adjudicationMissingData.length > 0 || adjudicationProviderGaps.length > 0
  const providerConfigStatus = getProviderConfigStatus()
  const openAiSummaryConfigured = Boolean(process.env.OPENAI_API_KEY?.trim())

  const providerHealthRows: ProviderHealthRow[] = [
    {
      provider: 'MarketCheck',
      status: getProviderHealthStatus({
        configured: providerConfigStatus.marketCheckConfigured,
        source: claim.vinDataProvider,
        hasData: claim.vinDataProvider === 'marketcheck',
        error:
          claim.status === ClaimStatus.ProviderFailed || claim.status === ClaimStatus.ProcessingError
            ? claim.vinLookupLastError
            : null
      }),
      source: claim.vinDataProvider || '—',
      note: claim.vinLookupLastError || 'VIN decode provider health'
    },
    {
      provider: 'NHTSA Recalls',
      status: getProviderHealthStatus({
        configured: true,
        source: nhtsaRecalls?.items.length ? 'nhtsa' : nhtsaRecalls?.message,
        hasData: Boolean(nhtsaRecalls)
      }),
      source: nhtsaRecalls ? 'nhtsa' : '—',
      note: nhtsaRecalls?.message || 'Recall enrichment health'
    },
    {
      provider: 'Title History',
      status: getProviderHealthStatus({
        configured: providerConfigStatus.titleHistoryConfigured,
        source: titleHistory?.source,
        hasData: Boolean(titleHistory),
        error: titleHistory?.message && titleHistory.message.toLowerCase().includes('failed') ? titleHistory.message : null
      }),
      source: titleHistory?.source || '—',
      note: titleHistory?.message || 'Title enrichment health'
    },
    {
      provider: 'Service History',
      status: getProviderHealthStatus({
        configured: providerConfigStatus.serviceHistoryConfigured,
        source: serviceHistory?.source,
        hasData: Boolean(serviceHistory),
        error:
          serviceHistory?.message && serviceHistory.message.toLowerCase().includes('failed')
            ? serviceHistory.message
            : null
      }),
      source: serviceHistory?.source || '—',
      note: serviceHistory?.message || 'Service enrichment health'
    },
    {
      provider: 'Valuation',
      status: getProviderHealthStatus({
        configured: providerConfigStatus.valuationConfigured,
        source: valuation?.source,
        hasData: Boolean(valuation),
        error:
          valuation?.message && valuation.message.toLowerCase().includes('failed') ? valuation.message : null
      }),
      source: valuation?.source || '—',
      note: valuation?.message || 'Valuation enrichment health'
    },
    {
      provider: 'OpenAI Summary',
      status: getProviderHealthStatus({
        configured: openAiSummaryConfigured,
        hasData: Boolean(claim.reviewSummaryText),
        error: claim.reviewSummaryStatus === 'Failed' ? claim.reviewSummaryLastError : null
      }),
      source: claim.reviewSummaryVersion || '—',
      note: claim.reviewSummaryLastError || 'Summary generation health'
    }
  ]

  const claimLockedForProcessing = isClaimLockedForProcessing(claim)
  const summaryRegenerateDisabledReason = getSummaryRegenerateDisabledReason({
    claimLockedForProcessing,
    status: claim.status,
    reviewSummaryStatus: claim.reviewSummaryStatus,
    reviewRuleEvaluatedAt: claim.reviewRuleEvaluatedAt
  })
  const canRegenerateSummary = summaryRegenerateDisabledReason === null
  const overrideValidationError =
    resolvedSearchParams.reviewDecision === 'missing-override-reason' ||
    resolvedSearchParams.reviewDecision === 'invalid-override-reason' ||
    resolvedSearchParams.reviewDecision === 'override-reason-too-long'
  const systemRecommendationLabel = adjudicationResult
    ? formatRecommendationLabel(adjudicationResult.recommendation)
    : '—'
  const recommendationDiffersFromReviewer =
    Boolean(adjudicationResult?.recommendation) &&
    claim.reviewDecision !== null &&
    normalizeDecisionForCompare(adjudicationResult?.recommendation) !==
      normalizeDecisionForCompare(claim.reviewDecision)
  const saveDecisionButtonLabel = claimLockedForProcessing
    ? 'Locked (disabled)'
    : currentOverrideUsed
      ? 'Override Decision'
      : 'Save Decision'
  const isLowConfidenceDecision =
    typeof adjudicationResult?.overallConfidence === 'number' &&
    adjudicationResult.overallConfidence < REVIEWER_LOW_CONFIDENCE_THRESHOLD
  const isLowCompletenessDecision =
    typeof adjudicationResult?.overallCompleteness === 'number' &&
    adjudicationResult.overallCompleteness < REVIEWER_LOW_COMPLETENESS_THRESHOLD
  const criticalMissingData = adjudicationMissingData.filter((entry) =>
    CRITICAL_MISSING_DATA_KEYWORDS.some((keyword) => entry.toLowerCase().includes(keyword))
  )
  const shouldHighlightImportantMissingData = criticalMissingData.length > 0
  const shouldShowLowQualityDecisionWarning = isLowConfidenceDecision || isLowCompletenessDecision
  const isOverrideActiveForForm = recommendationDiffersFromReviewer || currentOverrideUsed
  const shouldWarnNotesAreEmpty = !claim.reviewDecisionNotes || claim.reviewDecisionNotes.trim().length === 0
  const overrideReasonValidationMessage = overrideValidationError
    ? 'Override reason is required when override is enabled.'
    : isOverrideActiveForForm && !currentOverrideReason.trim()
      ? 'Override reason is required before submitting this override.'
      : null
  const claimDocumentEvidenceModel = buildClaimDocumentEvidenceReadModel({
    vinDataResult,
    claimDocuments: claim.claimDocuments as Array<Record<string, unknown>>,
    adjudicationMissingData
  })
  const satisfiedEvidenceSlots = claimDocumentEvidenceModel.slots.filter((slot) => slot.satisfied)
  const missingEvidenceSlots = claimDocumentEvidenceModel.slots.filter((slot) => !slot.satisfied)
  const hasAdjudicationResult = Boolean(adjudicationResult)
  const suggestedNextAction = claimLockedForProcessing
    ? 'Claim is finalized. Review details for reference only.'
    : missingEvidenceSlots.length > 0
      ? 'Add missing information or upload supporting documents to complete review.'
      : claim.reviewSummaryStatus !== 'Generated'
        ? 'Generate or refresh the summary before final reviewer decision.'
        : 'Review recommendation details and save a reviewer decision.'
  const pageReadinessLabel = claimLockedForProcessing
    ? 'Final decision completed'
    : missingEvidenceSlots.length === 0 && hasAdjudicationResult
      ? 'Review-ready'
      : 'Needs reviewer input'
  const pageReadinessClassName = claimLockedForProcessing
    ? `${BADGE_BASE_CLASSNAME} border-slate-300 bg-slate-100 text-slate-700`
    : missingEvidenceSlots.length === 0 && hasAdjudicationResult
      ? `${BADGE_BASE_CLASSNAME} border-emerald-300 bg-emerald-50 text-emerald-700`
      : `${BADGE_BASE_CLASSNAME} border-amber-300 bg-amber-50 text-amber-900`
  const hasEnrichmentData =
    claim.vinDataFetchedAt !== null ||
    Boolean(claim.vinDataProvider) ||
    Boolean(claim.vinDataProviderResultCode) ||
    Boolean(claim.vinDataProviderResultMessage) ||
    Object.keys(vinDataResult).length > 0
  const claimSubmissionMileage = formatClaimSubmissionMileage(claim.rawSubmissionPayload)
  const manualPurchaseDate =
    getValueAtPath(vinDataResult, 'documentEvidence.contract.vehiclePurchaseDate') ||
    getValueAtPath(vinDataResult, 'documentEvidence.contract.agreementPurchaseDate')
  const manualPurchaseMileage = getValueAtPath(vinDataResult, 'documentEvidence.contract.mileageAtSale')
  const manualCurrentMileage = getValueAtPath(vinDataResult, 'serviceHistory.latestMileage')
  const manualAgreementNumber = getValueAtPath(vinDataResult, 'documentEvidence.contract.agreementNumber')
  const manualDeductible = getValueAtPath(vinDataResult, 'documentEvidence.contract.deductible')
  const manualTermMonths = getValueAtPath(vinDataResult, 'documentEvidence.contract.termMonths')
  const manualTermMiles = getValueAtPath(vinDataResult, 'documentEvidence.contract.termMiles')
  const manualCoverageLevel = getValueAtPath(vinDataResult, 'documentEvidence.contract.coverageLevel')
  const manualPlanName = getValueAtPath(vinDataResult, 'documentEvidence.contract.planName')
  const manualWarrantyCoverageSummary = getValueAtPath(
    vinDataResult,
    'documentEvidence.contract.warrantyCoverageSummary'
  )
  const manualValuationContextNote = getValueAtPath(vinDataResult, 'valuation.contextNote')
  const manualObdCodes = getValueAtPath(vinDataResult, 'documentEvidence.contract.obdCodes')

  const manualFieldState = {
    purchaseDate: hasManualSlotValue(manualPurchaseDate),
    purchaseMileage: hasManualSlotValue(manualPurchaseMileage),
    currentMileage: hasManualSlotValue(manualCurrentMileage),
    agreementNumber: hasManualSlotValue(manualAgreementNumber),
    deductible: hasManualSlotValue(manualDeductible),
    termMonths: hasManualSlotValue(manualTermMonths),
    termMiles: hasManualSlotValue(manualTermMiles),
    coverageLevel: hasManualSlotValue(manualCoverageLevel),
    planName: hasManualSlotValue(manualPlanName),
    warrantyCoverageSummary: hasManualSlotValue(manualWarrantyCoverageSummary),
    valuationContextNote: hasManualSlotValue(manualValuationContextNote),
    obdCodes: hasManualSlotValue(manualObdCodes)
  }
  const cognitoAttachmentLabelCandidates =
    typeof claim.source === 'string' && claim.source.toLowerCase().includes('cognito')
      ? buildCognitoAttachmentLabelCandidates(claim.rawSubmissionPayload)
      : []
  const attachmentCognitoLabelByStorageKey = new Map<string, string>()

  for (const attachment of claim.attachments as Array<any>) {
    const resolvedLabel = resolveCognitoAttachmentFieldLabel(
      {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        sourceUrl: attachment.sourceUrl,
        externalId: attachment.externalId
      },
      cognitoAttachmentLabelCandidates
    )

    if (resolvedLabel && typeof attachment.storageKey === 'string' && attachment.storageKey.trim().length > 0) {
      attachmentCognitoLabelByStorageKey.set(attachment.storageKey, resolvedLabel)
    }
  }

  const evidenceSection = asRecord(vinDataResult.documentEvidence)
  const evidenceDocuments = asRecord(evidenceSection.documents)
  const evidenceConflictsRaw = Array.isArray(evidenceSection.conflicts) ? evidenceSection.conflicts : []
  const evidenceResolvedConflictsRaw = Array.isArray(evidenceSection.conflictResolutions)
    ? evidenceSection.conflictResolutions
    : []

  const slotLabelByFieldPath = new Map<string, string | null>(
    claimDocumentEvidenceModel.conflicts.map((entry) => [entry.fieldPath, entry.slotLabel])
  )

  const claimDocumentById = new Map<string, Record<string, unknown>>(
    (claim.claimDocuments as Array<Record<string, unknown>>).map((document) => [
      getOptionalString(document.id) || '',
      asRecord(document)
    ])
  )

  const unresolvedConflictViewModels: ConflictResolutionViewModel[] = evidenceConflictsRaw
    .map((entry) => {
      const record = asRecord(entry)
      const fieldPath = getOptionalString(record.field)
      if (!fieldPath || !SUPPORTED_CONFLICT_RESOLUTION_PATHS.has(fieldPath)) {
        return null
      }

      const sourceDocumentId = getOptionalString(record.documentId)
      const sourceDocument = asRecord((sourceDocumentId && claimDocumentById.get(sourceDocumentId)) || {})
      const evidenceDocument = asRecord((sourceDocumentId && evidenceDocuments[sourceDocumentId]) || {})
      const sourceLabel = getOptionalString(evidenceDocument.source) || 'uploaded_document'
      const detectedAt = getOptionalString(record.detectedAt)

      return {
        conflictKey: [fieldPath, sourceDocumentId || '', detectedAt || ''].join('|'),
        fieldPath,
        fieldLabel: formatConflictFieldLabel(fieldPath),
        slotLabel: slotLabelByFieldPath.get(fieldPath) || null,
        reason: getOptionalString(record.reason) || 'existing_value_differs',
        existingValue: record.existing,
        incomingValue: record.incoming,
        currentValue: getValueAtPath(vinDataResult, fieldPath),
        sourceLabel,
        sourceDocumentId,
        sourceDocumentName: getOptionalString(sourceDocument.fileName),
        sourceDocumentType: getOptionalString(sourceDocument.documentType),
        detectedAt
      }
    })
    .filter((entry): entry is ConflictResolutionViewModel => Boolean(entry))
    .sort((left, right) => {
      const slotLeft = left.slotLabel || left.fieldLabel
      const slotRight = right.slotLabel || right.fieldLabel
      const slotRank = slotLeft.localeCompare(slotRight)
      if (slotRank !== 0) {
        return slotRank
      }

      return left.fieldLabel.localeCompare(right.fieldLabel)
    })

  const resolvedConflictHistory: ResolvedConflictViewModel[] = evidenceResolvedConflictsRaw
    .map((entry) => {
      const record = asRecord(entry)
      const fieldPath = getOptionalString(record.field)
      if (!fieldPath || !SUPPORTED_CONFLICT_RESOLUTION_PATHS.has(fieldPath)) {
        return null
      }

      return {
        fieldPath,
        fieldLabel: formatConflictFieldLabel(fieldPath),
        winner: getOptionalString(record.winner) || 'unknown',
        winningSource: getOptionalString(record.winningSource),
        losingSource: getOptionalString(record.losingSource),
        resolvedAt: getOptionalString(record.resolvedAt),
        resolvedBy: getOptionalString(record.resolvedBy),
        note: getOptionalString(record.note)
      }
    })
    .filter((entry): entry is ResolvedConflictViewModel => Boolean(entry))
    .slice(-8)
    .reverse()

  return (
    <section className="card space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl">Claim Details</h1>
          <p className="text-sm text-slate-600">
            {claim.claimNumber} | {claim.claimantName || 'Unknown customer'}
          </p>
        </div>
        <Link href="/admin/claims" className="text-sm text-slate-600 underline underline-offset-2">
          Back to Claims
        </Link>
      </div>

      {retryBannerMessage ? (
        <p className={getRetryBannerClassName(resolvedSearchParams.retry)}>{retryBannerMessage}</p>
      ) : null}

      {reviewDecisionBannerMessage ? (
        <p className={getReviewDecisionBannerClassName(resolvedSearchParams.reviewDecision)}>
          {reviewDecisionBannerMessage}
        </p>
      ) : null}

      {summaryRegenerateBannerMessage ? (
        <p className={getSummaryRegenerateBannerClassName(resolvedSearchParams.summaryRegenerate)}>
          {summaryRegenerateBannerMessage}
        </p>
      ) : null}

      {documentUploadBannerMessage ? (
        <p className={getDocumentUploadBannerClassName(resolvedSearchParams.documentUpload)}>
          {documentUploadBannerMessage}
        </p>
      ) : null}

      {documentRemoveBannerMessage ? (
        <p className={getDocumentRemoveBannerClassName(resolvedSearchParams.documentRemove)}>
          {documentRemoveBannerMessage}
        </p>
      ) : null}

      {documentReprocessBannerMessage ? (
        <p className={getDocumentReprocessBannerClassName(resolvedSearchParams.documentReprocess)}>
          {documentReprocessBannerMessage}
        </p>
      ) : null}

      {manualEvidenceBannerMessage ? (
        <p className={getManualEvidenceBannerClassName(resolvedSearchParams.manualEvidence)}>
          {manualEvidenceBannerMessage}
        </p>
      ) : null}

      {conflictResolutionBannerMessage ? (
        <p className={getConflictResolutionBannerClassName(resolvedSearchParams.conflictResolution)}>
          {conflictResolutionBannerMessage}
        </p>
      ) : null}

      {claimLockedForProcessing ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Claim is locked by final reviewer decision ({formatReviewerDecisionLabel(claim.reviewDecision)}).
        </p>
      ) : null}

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={getStatusBadgeClassName(claim.status)}>{formatClaimStatusLabel(claim.status)}</span>
          <span className={pageReadinessClassName}>{pageReadinessLabel}</span>
          <span className={BADGE_BASE_CLASSNAME + ' border-slate-300 bg-white text-slate-700'}>
            Summary {formatSummaryStatusLabel(claim.reviewSummaryStatus)}
          </span>
        </div>

        <div className="mt-3 grid gap-3 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
          <p>
            <span className="font-medium text-slate-900">Current Decision:</span>{' '}
            {formatReviewerDecisionLabel(claim.reviewDecision)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Evidence Ready:</span>{' '}
            {String(satisfiedEvidenceSlots.length)} satisfied / {String(missingEvidenceSlots.length)} missing
          </p>
          <p>
            <span className="font-medium text-slate-900">Supporting Docs:</span>{' '}
            {String(claim.claimDocuments.length)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Claim Source:</span>{' '}
            {formatClaimDocumentSource(claim.source)}
          </p>
        </div>

        <p className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <span className="font-medium">Next best action:</span> {suggestedNextAction}
        </p>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Claim Info</h2>
        <p className="text-sm text-slate-600">
          Core claim details used by reviewers to understand customer context and current processing state.
        </p>
      </div>

      <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
        <p>
          <span className="font-medium text-slate-900">Claim #:</span> {claim.claimNumber}
        </p>
        <p>
          <span className="font-medium text-slate-900">Status:</span>{' '}
          <span className={getStatusBadgeClassName(claim.status)}>{formatClaimStatusLabel(claim.status)}</span>
        </p>
        <p>
          <span className="font-medium text-slate-900">Source:</span> {claim.source || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant:</span> {claim.claimantName || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant Email:</span>{' '}
          {claim.claimantEmail || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Claimant Phone:</span>{' '}
          {claim.claimantPhone || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">VIN:</span> {claim.vin || '—'}
        </p>
        <p>
          <span className="font-medium text-slate-900">Submitted:</span> {formatDate(claim.submittedAt)}
        </p>
        <p>
          <span className="font-medium text-slate-900">Mileage at Claim Submission:</span>{' '}
          {claimSubmissionMileage}
        </p>
        <p>
          <span className="font-medium text-slate-900">Attachment Count:</span> {claim.attachments.length}
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Add Missing Information</h2>
          <span className="text-xs text-slate-600">Empty fields only in this version</span>
        </div>
        <p className="text-sm text-slate-600">
          Add reviewer-confirmed values when evidence is still missing. Existing values remain read-only.
        </p>
        <form method="post" action={`/api/admin/claims/${claim.id}/manual-evidence`} className="space-y-3">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label className="space-y-1">
              <span className="font-medium text-slate-900">Purchase Date</span>
              {manualFieldState.purchaseDate ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualPurchaseDate)}
                </p>
              ) : (
                <input type="date" name="purchaseDate" className="w-full rounded border border-slate-300 px-2 py-1" />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Purchase Mileage</span>
              {manualFieldState.purchaseMileage ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualPurchaseMileage)}
                </p>
              ) : (
                <input
                  type="number"
                  min="0"
                  step="1"
                  name="purchaseMileage"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Current Mileage</span>
              {manualFieldState.currentMileage ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualCurrentMileage)}
                </p>
              ) : (
                <input
                  type="number"
                  min="0"
                  step="1"
                  name="currentMileage"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Agreement Number</span>
              {manualFieldState.agreementNumber ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualAgreementNumber)}
                </p>
              ) : (
                <input type="text" name="agreementNumber" className="w-full rounded border border-slate-300 px-2 py-1" />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Deductible</span>
              {manualFieldState.deductible ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualDeductible)}
                </p>
              ) : (
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  name="deductible"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Term Months</span>
              {manualFieldState.termMonths ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualTermMonths)}
                </p>
              ) : (
                <input
                  type="number"
                  min="0"
                  step="1"
                  name="termMonths"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Term Miles</span>
              {manualFieldState.termMiles ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualTermMiles)}
                </p>
              ) : (
                <input
                  type="number"
                  min="0"
                  step="1"
                  name="termMiles"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Coverage Level</span>
              {manualFieldState.coverageLevel ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualCoverageLevel)}
                </p>
              ) : (
                <input type="text" name="coverageLevel" className="w-full rounded border border-slate-300 px-2 py-1" />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Plan Name</span>
              {manualFieldState.planName ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualPlanName)}
                </p>
              ) : (
                <input type="text" name="planName" className="w-full rounded border border-slate-300 px-2 py-1" />
              )}
            </label>
          </div>

          <div className="grid gap-3 text-sm">
            <label className="space-y-1">
              <span className="font-medium text-slate-900">Warranty Coverage Summary</span>
              {manualFieldState.warrantyCoverageSummary ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualWarrantyCoverageSummary)}
                </p>
              ) : (
                <textarea
                  name="warrantyCoverageSummary"
                  rows={2}
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Valuation Context Note</span>
              {manualFieldState.valuationContextNote ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualValuationContextNote)}
                </p>
              ) : (
                <textarea
                  name="valuationContextNote"
                  rows={2}
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">OBD Codes</span>
              {manualFieldState.obdCodes ? (
                <p className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-700">
                  {formatManualFieldDisplayValue(manualObdCodes)}
                </p>
              ) : (
                <input
                  type="text"
                  name="obdCodes"
                  placeholder="e.g. P0420, P0301"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                />
              )}
            </label>

            <label className="space-y-1">
              <span className="font-medium text-slate-900">Reviewer Note (optional)</span>
              <textarea name="reviewerNote" rows={2} className="w-full rounded border border-slate-300 px-2 py-1" />
            </label>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-600">Source is recorded as manual_reviewer_entry.</p>
            <button
              type="submit"
              disabled={claimLockedForProcessing}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save Manual Evidence
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Resolve Evidence Conflicts</h2>
          <span className="text-xs text-slate-600">Explicit reviewer choice required</span>
        </div>
        <p className="text-sm text-slate-600">
          Choose which value should win for supported conflicting fields. Winning values are written with reviewer
          resolution provenance and audit history.
        </p>

        {unresolvedConflictViewModels.length === 0 ? (
          <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            No unresolved high-value conflicts are available for reviewer resolution.
          </p>
        ) : (
          <div className="space-y-3">
            {unresolvedConflictViewModels.map((conflict) => (
              <form
                key={conflict.conflictKey}
                method="post"
                action={`/api/admin/claims/${claim.id}/resolve-evidence-conflict`}
                className="space-y-2 rounded-md border border-red-200 bg-white p-3"
              >
                <input type="hidden" name="conflictField" value={conflict.fieldPath} />
                <input type="hidden" name="conflictDocumentId" value={conflict.sourceDocumentId || ''} />
                <input type="hidden" name="conflictDetectedAt" value={conflict.detectedAt || ''} />

                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-900">
                    {conflict.slotLabel ? `${conflict.slotLabel}: ` : ''}
                    {conflict.fieldLabel}
                  </p>
                  <p className="text-xs text-slate-600">
                    Source: {conflict.sourceDocumentName || conflict.sourceDocumentId || 'Unknown document'} |{' '}
                    {formatEvidenceSourceLabel(conflict.sourceLabel)}
                    {conflict.sourceDocumentType ? ` | ${formatDetectedDocumentType(conflict.sourceDocumentType)}` : ''}
                  </p>
                  <p className="text-xs text-slate-600">Reason: {conflict.reason}</p>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current value</p>
                    <p className="mt-1 text-slate-900">{formatConflictValuePreview(conflict.currentValue)}</p>
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Keep existing</p>
                    <p className="mt-1 text-slate-900">{formatConflictValuePreview(conflict.existingValue)}</p>
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Accept candidate</p>
                    <p className="mt-1 text-slate-900">{formatConflictValuePreview(conflict.incomingValue)}</p>
                  </div>
                </div>

                <label className="block space-y-1 text-sm text-slate-700">
                  <span className="font-medium text-slate-900">Reviewer note (optional)</span>
                  <input
                    type="text"
                    name="reviewerNote"
                    maxLength={2000}
                    className="w-full rounded border border-slate-300 px-2 py-1"
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    name="winner"
                    value="existing"
                    disabled={claimLockedForProcessing}
                    className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Keep Existing Value
                  </button>
                  <button
                    type="submit"
                    name="winner"
                    value="incoming"
                    disabled={claimLockedForProcessing}
                    className="inline-flex items-center rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-900 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Accept Candidate Value
                  </button>
                </div>
              </form>
            ))}
          </div>
        )}

        <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
          <p className="font-medium text-slate-900">Recent Resolved Conflicts</p>
          {resolvedConflictHistory.length === 0 ? (
            <p className="mt-2 text-slate-600">No reviewer conflict resolutions have been recorded yet.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {resolvedConflictHistory.map((entry, index) => (
                <li key={`${entry.fieldPath}-${entry.resolvedAt || 'unknown'}-${String(index)}`}>
                  <span className="font-medium">{entry.fieldLabel}</span>: winner {entry.winner} ({' '}
                  {formatEvidenceSourceLabel(entry.winningSource)})
                  {entry.losingSource ? ` | loser ${formatEvidenceSourceLabel(entry.losingSource)}` : ''}
                  {entry.resolvedBy ? ` | by ${entry.resolvedBy}` : ''}
                  {entry.resolvedAt ? ` | ${formatIsoDate(entry.resolvedAt)}` : ''}
                  {entry.note ? ` | note: ${entry.note}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Review Summary</h2>
          <form method="post" action={`/api/admin/claims/${claim.id}/regenerate-summary`}>
            <button
              type="submit"
              disabled={!canRegenerateSummary}
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Regenerate Summary
            </button>
          </form>
        </div>

        <p className="text-sm text-slate-600">
          Business summary of the claim based on currently available evidence.
        </p>

        {!canRegenerateSummary && summaryRegenerateDisabledReason ? (
          <p className="text-sm text-amber-900">{summaryRegenerateDisabledReason}</p>
        ) : null}

        {claim.reviewSummaryText ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <pre className="whitespace-pre-wrap text-sm leading-6 text-slate-800">
              {claim.reviewSummaryText}
            </pre>
          </div>
        ) : (
          <p className="text-slate-600">No summary generated yet. Add evidence or regenerate the summary.</p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Adjudication Result</h2>

        <p className="text-sm text-slate-600">
          Recommendation details showing confidence, completeness, and remaining risk areas.
        </p>

        {!adjudicationResult ? (
          <p className="text-slate-600">No recommendation available yet for this claim.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-slate-200 bg-white p-4">
              <div className="grid gap-3 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Recommendation</p>
                  <p className="mt-1">
                    <span className={getRecommendationBadgeClassName(adjudicationResult.recommendation)}>
                      {formatRecommendationLabel(adjudicationResult.recommendation)}
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Confidence %</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {formatPercentFromFraction(adjudicationResult.overallConfidence)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Completeness %</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {formatPercentFromFraction(adjudicationResult.overallCompleteness)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Total Score</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">{String(adjudicationResult.totalScore)}</p>
                </div>
              </div>

              {typeof adjudicationResult.explanation === 'string' && adjudicationResult.explanation ? (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="font-medium text-slate-900">Explanation</p>
                  <p className="mt-1">{adjudicationResult.explanation}</p>
                </div>
              ) : null}

              {typeof adjudicationResult.overrideSuggestion === 'string' && adjudicationResult.overrideSuggestion ? (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">Override guidance</p>
                  <p className="mt-1">{adjudicationResult.overrideSuggestion}</p>
                </div>
              ) : null}

              <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                <p>
                  <span className="font-medium text-slate-700">Version:</span> {adjudicationResult.version}
                </p>
                <p>
                  <span className="font-medium text-slate-700">Generated At:</span>{' '}
                  {formatIsoDate(adjudicationResult.generatedAt)}
                </p>
                <p>
                  <span className="font-medium text-slate-700">Legacy Completeness:</span>{' '}
                  {adjudicationResult.completeness}
                </p>
                <p>
                  <span className="font-medium text-slate-700">Questions:</span>{' '}
                  {String(adjudicationResult.questions.length)}
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Reasons</p>
                {Array.isArray(adjudicationResult.reasons) && adjudicationResult.reasons.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5">
                    {adjudicationResult.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-slate-600">No explicit reasons recorded.</p>
                )}
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Missing Data</p>
                {Array.from(
                  new Set(
                    adjudicationResult.questions.flatMap((question) =>
                      Array.isArray(question.missing) ? question.missing : []
                    )
                  )
                ).length > 0 ? (
                  <ul className="mt-2 list-disc pl-5">
                    {Array.from(
                      new Set(
                        adjudicationResult.questions.flatMap((question) =>
                          Array.isArray(question.missing) ? question.missing : []
                        )
                      )
                    ).map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-slate-600">No missing data recorded.</p>
                )}
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-600">
                    <th className="py-2 pr-4 font-medium">Question</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Score</th>
                    <th className="py-2 pr-4 font-medium">Confidence %</th>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 pr-4 font-medium">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {adjudicationResult.questions.map((question) => (
                    <tr key={question.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 text-slate-900">
                        <p className="font-medium">{question.title}</p>
                        <p className="text-xs text-slate-600">{question.id}</p>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={getAdjudicationStatusBadgeClassName(question.status)}>
                          {question.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">
                        {question.score !== null ? String(question.score) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{formatPercentFromFraction(question.confidence)}</td>
                      <td className="py-2 pr-4">
                        <span className={getProviderStatusBadgeClassName(question.providerStatus)}>
                          {getProviderStatusLabel(question.providerStatus)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">
                        {Array.isArray(question.missing) && question.missing.length > 0
                          ? question.missing.join(', ')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">System Signals</h2>

        <p className="text-sm text-slate-600">
          Supporting system checks that help explain the recommendation.
        </p>

        <p className="text-xs text-slate-500">
          Adjudication Result is a separate recommendation layer and may show reasons or missing data even when
          legacy rule flags are empty.
        </p>

        {!hasLegacyRuleFlags ? (
          <div className="space-y-3">
            <p className="text-slate-600">No legacy rule flags for this claim.</p>

            {hasAdjudicationSignals ? (
              <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
                <p className="font-medium">Adjudication Signals (reference)</p>

                {adjudicationReasons.length > 0 ? (
                  <p className="mt-2">
                    <span className="font-medium">Reasons:</span>{' '}
                    {adjudicationReasons.slice(0, 3).join('; ')}
                  </p>
                ) : null}

                {adjudicationMissingData.length > 0 ? (
                  <p className="mt-1">
                    <span className="font-medium">Missing data:</span>{' '}
                    {adjudicationMissingData.slice(0, 3).join(', ')}
                  </p>
                ) : null}

                {adjudicationProviderGaps.length > 0 ? (
                  <p className="mt-1">
                    <span className="font-medium">Provider gaps:</span>{' '}
                    {adjudicationProviderGaps.slice(0, 2).join('; ')}
                  </p>
                ) : null}

                <p className="mt-2 text-xs text-sky-800">See Adjudication Result for full recommendation details.</p>
              </div>
            ) : (
              <p className="text-sm text-slate-600">No adjudication signals are available for this claim.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Severity</th>
                  <th className="py-2 pr-4 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {persistedRuleFlags.map((flag) => (
                  <tr key={`${flag.code}-${flag.message}`} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 font-medium text-slate-900">{flag.code}</td>
                    <td className="py-2 pr-4 text-slate-700">{flag.severity}</td>
                    <td className="py-2 pr-4 text-slate-700">{flag.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Reviewer Decision</h2>

        <p className="text-sm text-slate-600">
          Confirm the final reviewer outcome after checking recommendation, evidence, and missing data.
        </p>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <p>
              <span className="font-medium text-slate-900">System Recommendation:</span>{' '}
              <span className={getRecommendationBadgeClassName(adjudicationResult?.recommendation)}>
                {systemRecommendationLabel}
              </span>
            </p>
            <p>
              <span className="font-medium text-slate-900">Confidence %:</span>{' '}
              {formatPercentFromFraction(adjudicationResult?.overallConfidence)}
            </p>
            <p>
              <span className="font-medium text-slate-900">Completeness %:</span>{' '}
              {formatPercentFromFraction(adjudicationResult?.overallCompleteness)}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <p>
              <span className="font-medium text-slate-900">Current Decision:</span>{' '}
              <span className={getReviewerDecisionBadgeClassName(claim.reviewDecision)}>
                {formatReviewerDecisionLabel(claim.reviewDecision)}
              </span>
            </p>
            <p>
              <span className="font-medium text-slate-900">Locked:</span>{' '}
              {claimLockedForProcessing ? 'Yes' : 'No'}
            </p>
          </div>

          {recommendationDiffersFromReviewer ? (
            <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              Reviewer decision differs from system recommendation.
            </p>
          ) : null}

          {shouldShowLowQualityDecisionWarning ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Low confidence decision - limited data available.
            </p>
          ) : null}

          {shouldHighlightImportantMissingData ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="font-medium">Important data missing for this claim.</p>
              <p className="mt-1">{criticalMissingData.join(', ')}</p>
            </div>
          ) : null}
        </div>

        {claimLockedForProcessing ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This claim is locked due to final decision.
          </p>
        ) : null}

        {reviewDecisionBannerMessage ? (
          <p className={getReviewDecisionBannerClassName(resolvedSearchParams.reviewDecision)}>
            {reviewDecisionBannerMessage}
          </p>
        ) : null}

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2 rounded-md border border-slate-200 bg-white p-3">
          <p>
            <span className="font-medium text-slate-900">Current Decision:</span>{' '}
            <span className={getReviewerDecisionBadgeClassName(claim.reviewDecision)}>
              {formatReviewerDecisionLabel(claim.reviewDecision)}
            </span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Updated:</span>{' '}
            {claim.reviewDecisionSetAt ? formatDate(claim.reviewDecisionSetAt) : '—'}
          </p>
          <p className="sm:col-span-2">
            <span className="font-medium text-slate-900">Current Notes:</span>{' '}
            {claim.reviewDecisionNotes || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Override Used:</span>{' '}
            {currentOverrideUsed ? 'Yes' : 'No'}
          </p>
          <p className="sm:col-span-2">
            <span className="font-medium text-slate-900">Override Reason:</span>{' '}
            {currentOverrideUsed ? currentOverrideReason || '—' : '—'}
          </p>
        </div>

        <form
          method="post"
          action={`/api/admin/claims/${claim.id}/review-decision`}
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <p className="text-sm font-medium text-slate-900">Decision Update Form</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Decision</span>
              <select
                name="decision"
                defaultValue={claim.reviewDecision || 'NeedsReview'}
                disabled={claimLockedForProcessing}
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              >
                <option value="NeedsReview">Needs Review</option>
                <option value="Approved">Approved</option>
                <option value="Denied">Denied</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Notes</span>
            <textarea
              name="notes"
              defaultValue={claim.reviewDecisionNotes || ''}
              rows={4}
              disabled={claimLockedForProcessing}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              placeholder="Add reviewer notes"
            />
          </label>

          {shouldWarnNotesAreEmpty ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Notes are currently empty. Add reviewer context to improve audit clarity.
            </p>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="override"
              value="true"
              defaultChecked={isOverrideActiveForForm}
              disabled={claimLockedForProcessing}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span className="font-medium text-slate-900">Override recommended outcome</span>
          </label>

          <p className="text-xs text-slate-600">
            Use override only when reviewer judgment should supersede system recommendation.
          </p>

          {isOverrideActiveForForm ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You are overriding the system recommendation.
            </p>
          ) : null}

          {recommendationDiffersFromReviewer ? (
            <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              Reviewer decision differs from system recommendation.
            </p>
          ) : null}

          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Override Reason</span>
            <textarea
              name="overrideReason"
              defaultValue={currentOverrideReason}
              rows={3}
              required={isOverrideActiveForForm}
              minLength={isOverrideActiveForForm ? 8 : undefined}
              disabled={claimLockedForProcessing}
              className={`w-full rounded-md border bg-white px-2 py-1.5 text-sm text-slate-900 ${
                overrideReasonValidationMessage ? 'border-red-400' : 'border-slate-300'
              }`}
              placeholder="Explain why reviewer is overriding the guidance"
            />
          </label>

          {overrideReasonValidationMessage ? (
            <p className="text-sm text-red-700">{overrideReasonValidationMessage}</p>
          ) : null}

          <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            <p className="font-medium text-slate-900">Decision Confirmation</p>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Selected decision:</span>{' '}
                {formatReviewerDecisionLabel(claim.reviewDecision || 'NeedsReview')}
              </p>
              <p>
                <span className="font-medium text-slate-900">Override active:</span>{' '}
                {isOverrideActiveForForm ? 'Yes' : 'No'}
              </p>
              <p className="sm:col-span-2">
                <span className="font-medium text-slate-900">System recommendation:</span>{' '}
                {systemRecommendationLabel}
              </p>
              <p className="sm:col-span-2">
                <span className="font-medium text-slate-900">Override reason:</span>{' '}
                {currentOverrideReason.trim() || 'None entered'}
              </p>
            </div>
          </div>

          {claimLockedForProcessing ? (
            <p className="text-sm text-amber-900">Reviewer decision is read-only because this claim is locked.</p>
          ) : null}

          <button
            type="submit"
            disabled={claimLockedForProcessing}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          >
            {saveDecisionButtonLabel}
          </button>
        </form>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Claim Attachments</h2>
        <p className="text-sm text-slate-600">Original intake files from the customer submission.</p>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Attachment Count:</span> {claim.attachments.length}
          </p>
          <p>
            <span className="font-medium text-slate-900">Has Attachments:</span>{' '}
            {claim.attachments.length > 0 ? 'Yes' : 'No'}
          </p>
        </div>

        {claim.attachments.length === 0 ? (
          <p className="text-slate-600">No attachments available for this claim.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {claim.attachments.map((attachment: any) => {
              const cognitoFieldLabel = resolveCognitoAttachmentFieldLabel(
                {
                  filename: attachment.filename,
                  mimeType: attachment.mimeType,
                  fileSize: attachment.fileSize,
                  sourceUrl: attachment.sourceUrl,
                  externalId: attachment.externalId
                },
                cognitoAttachmentLabelCandidates
              )
              const safePreviewUrl = isSafePreviewUrl(attachment.sourceUrl) ? attachment.sourceUrl : null
              const canPreviewImage = safePreviewUrl && isImageAttachment(attachment)
              const canPreviewPdf = safePreviewUrl && isPdfAttachment(attachment)
              const canPreviewHeic = safePreviewUrl && isHeicAttachment(attachment)

              return (
                <article
                  key={attachment.id}
                  className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
                >
                  <div className="space-y-2">
                    {cognitoFieldLabel ? (
                      <p className="text-xs font-medium uppercase tracking-wide text-sky-700">
                        {cognitoFieldLabel}
                      </p>
                    ) : null}
                    <p className="font-medium text-slate-900 break-all">{attachment.filename}</p>

                    <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                      <p>
                        <span className="font-medium text-slate-800">Type:</span>{' '}
                        {getAttachmentTypeLabel(attachment)}
                      </p>
                      <p>
                        <span className="font-medium text-slate-800">MIME:</span>{' '}
                        {attachment.mimeType || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-800">Uploaded:</span>{' '}
                        {attachment.uploadedAt ? formatDate(attachment.uploadedAt) : '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-800">Size:</span>{' '}
                        {formatFileSize(attachment.fileSize)}
                      </p>
                    </div>

                    {safePreviewUrl ? (
                      <details className="rounded-md border border-slate-200 bg-white p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-800">
                          Preview
                        </summary>

                        <div className="mt-2">
                          {canPreviewImage && !canPreviewHeic ? (
                            <img
                              src={safePreviewUrl}
                              alt={attachment.filename}
                              className="max-h-64 w-full rounded border border-slate-200 object-contain"
                            />
                          ) : null}

                          {canPreviewHeic ? (
                            <HeicImagePreview
                              sourceUrl={safePreviewUrl}
                              filename={attachment.filename}
                              className="max-h-64 w-full rounded border border-slate-200 object-contain"
                            />
                          ) : null}

                          {canPreviewPdf ? (
                            <p className="text-xs text-slate-600">
                              PDF preview is available via Open file to avoid automatic downloads.
                            </p>
                          ) : null}

                          {!canPreviewImage && !canPreviewPdf && !canPreviewHeic ? (
                            <p className="text-xs text-slate-600">Inline preview not available for this type.</p>
                          ) : null}
                        </div>
                      </details>
                    ) : (
                      <p className="text-xs text-slate-600">Preview unavailable: no supported file URL.</p>
                    )}

                    <div className="flex flex-wrap gap-3 text-xs">
                      <p>
                        <span className="font-medium text-slate-800">External ID:</span>{' '}
                        {attachment.externalId || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-800">Storage Key:</span>{' '}
                        {attachment.storageKey || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-800">URL:</span>{' '}
                        {safePreviewUrl ? (
                          <a
                            href={safePreviewUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 underline underline-offset-2"
                          >
                            Open file
                          </a>
                        ) : (
                          '—'
                        )}
                      </p>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Evidence Summary</h2>
        <p className="text-sm text-slate-600">
          Quick view of what evidence is confirmed, what is still missing, and where reviewer attention is needed.
        </p>

        {claimDocumentEvidenceModel.totalDocuments === 0 ? (
          <p className="text-slate-600">
            No supporting document evidence has been applied yet. Upload or reprocess documents to improve coverage.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
              <p>
                <span className="font-medium text-slate-900">Processed documents:</span>{' '}
                {String(claimDocumentEvidenceModel.processedDocuments)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Contributed evidence:</span>{' '}
                {String(claimDocumentEvidenceModel.contributedDocuments)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Conflict-only:</span>{' '}
                {String(claimDocumentEvidenceModel.conflictOnlyDocuments)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Skipped:</span>{' '}
                {String(claimDocumentEvidenceModel.skippedDocuments)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Pending/reprocess:</span>{' '}
                {String(claimDocumentEvidenceModel.pendingOrReprocessDocuments)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Satisfied evidence slots:</span>{' '}
                {String(claimDocumentEvidenceModel.satisfiedSlotCount)}
              </p>
            </div>

            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Applied fields from documents:</span>{' '}
                {String(claimDocumentEvidenceModel.appliedFieldCount)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Reduced adjudication gaps:</span>{' '}
                {String(claimDocumentEvidenceModel.gapCoverage.reduced.length)}
              </p>
            </div>

            {satisfiedEvidenceSlots.length === 0 ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                No high-value evidence slots are satisfied yet. Reprocess existing documents or upload additional
                supporting PDFs.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-slate-600">
                      <th className="py-2 pr-4 font-medium">Evidence Slot</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Provenance</th>
                      <th className="py-2 pr-4 font-medium">Contributions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claimDocumentEvidenceModel.slots.map((slot) => {
                      const appliedSources = slot.contributions.filter((entry) => entry.state === 'applied')
                      const sourcePreview =
                        appliedSources.length > 0
                          ? appliedSources.slice(0, 2).map((entry) => formatEvidenceContributionSource(entry)).join(' | ')
                          : 'No applied source yet'

                      return (
                        <tr key={slot.slotId} className="border-b last:border-0 align-top">
                          <td className="py-2 pr-4 text-slate-900">
                            <p className="font-medium">{slot.slotLabel}</p>
                          </td>
                          <td className="py-2 pr-4">
                            <span
                              className={
                                slot.satisfied
                                  ? `${BADGE_BASE_CLASSNAME} border-emerald-300 bg-emerald-50 text-emerald-700`
                                  : `${BADGE_BASE_CLASSNAME} border-slate-300 bg-slate-50 text-slate-700`
                              }
                            >
                              {slot.satisfied ? 'Satisfied' : 'Missing'}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-slate-700">{sourcePreview}</td>
                          <td className="py-2 pr-4 text-slate-700">
                            {slot.contributions.length === 0 ? (
                              '—'
                            ) : (
                              <ul className="space-y-1">
                                {slot.contributions.map((entry, index) => (
                                  <li key={`${slot.slotId}-${entry.fieldPath}-${entry.sourceDocumentId || 'none'}-${String(index)}`}>
                                    <span className="font-medium">{entry.fieldLabel}</span> |{' '}
                                    {formatDocumentEvidenceSlotState(entry.state)} | {entry.sourceLabel}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Adjudication Gaps Reduced By Evidence</p>
                {claimDocumentEvidenceModel.gapCoverage.reduced.length === 0 ? (
                  <p className="mt-2 text-slate-600">No current adjudication gaps are reduced by satisfied slots yet.</p>
                ) : (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {claimDocumentEvidenceModel.gapCoverage.reduced.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Important Gaps Remaining</p>
                {claimDocumentEvidenceModel.gapCoverage.remaining.length === 0 ? (
                  <p className="mt-2 text-slate-600">No major adjudication data gaps currently flagged.</p>
                ) : (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {claimDocumentEvidenceModel.gapCoverage.remaining.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="font-medium text-slate-900">Coverage Mapping (slot to reduced gaps)</p>
              {claimDocumentEvidenceModel.gapCoverage.reducedBySlot.length === 0 ? (
                <p className="mt-2 text-slate-600">No slot-to-gap reductions detected.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {claimDocumentEvidenceModel.gapCoverage.reducedBySlot.map((entry) => (
                    <li key={entry.slotId}>
                      <span className="font-medium">{entry.slotLabel}:</span> {entry.gaps.join(', ')}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="font-medium text-slate-900">Conflicts</p>
              {claimDocumentEvidenceModel.conflicts.length === 0 ? (
                <p className="mt-2 text-slate-600">No unresolved document evidence conflicts.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {claimDocumentEvidenceModel.conflicts.map((conflict, index) => (
                    <li
                      key={`${conflict.fieldPath}-${conflict.sourceDocumentId || 'unknown'}-${String(index)}`}
                      className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-red-900"
                    >
                      <p className="font-medium">
                        {conflict.slotLabel ? `${conflict.slotLabel}: ` : ''}
                        {conflict.fieldLabel}
                      </p>
                      <p className="text-xs">
                        Source: {conflict.sourceDocumentName || conflict.sourceDocumentId || 'Unknown document'} |{' '}
                        {conflict.sourceLabel}
                      </p>
                      <p className="text-xs">Reason: {conflict.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Supporting Documents</h2>
        <p className="text-sm text-slate-600">
          Reviewer-uploaded and intake documents used to confirm claim details.
        </p>

        <form
          method="post"
          action={`/api/admin/claims/${claim.id}/documents/upload`}
          encType="multipart/form-data"
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">PDF Files</span>
            <input
              type="file"
              name="documents"
              accept="application/pdf,.pdf"
              multiple
              required
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            />
          </label>

          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Uploaded By (optional)</span>
            <input
              type="text"
              name="uploadedBy"
              maxLength={120}
              placeholder="Reviewer name"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            />
          </label>

          <button
            type="submit"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          >
            Upload Supporting Documents
          </button>
        </form>

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Uploaded Document Count:</span>{' '}
            {String(claim.claimDocuments.length)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Last Upload:</span>{' '}
            {claim.claimDocuments[0]?.uploadedAt ? formatDate(claim.claimDocuments[0].uploadedAt) : '—'}
          </p>
        </div>

        {claim.claimDocuments.length === 0 ? (
          <p className="text-slate-600">No supporting documents uploaded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">File</th>
                  <th className="py-2 pr-4 font-medium">Stage Progress</th>
                  <th className="py-2 pr-4 font-medium">Detected Type</th>
                  <th className="py-2 pr-4 font-medium">Match</th>
                  <th className="py-2 pr-4 font-medium">Match Note</th>
                  <th className="py-2 pr-4 font-medium">Anchors</th>
                  <th className="py-2 pr-4 font-medium">Extraction</th>
                  <th className="py-2 pr-4 font-medium">Extracted At</th>
                  <th className="py-2 pr-4 font-medium">Extracted Summary</th>
                  <th className="py-2 pr-4 font-medium">Evidence Apply</th>
                  <th className="py-2 pr-4 font-medium">Applied At</th>
                  <th className="py-2 pr-4 font-medium">Apply Summary</th>
                  <th className="py-2 pr-4 font-medium">Conflicts</th>
                  <th className="py-2 pr-4 font-medium">Outcome</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Uploaded</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {claim.claimDocuments.map((document: any) => {
                  const processingPresentation = getDocumentProcessingPresentation({
                    processingStatus: document.processingStatus,
                    documentType: document.documentType,
                    matchStatus: document.matchStatus,
                    extractionStatus: document.extractionStatus
                  })
                  const cognitoFieldLabel =
                    document.uploadedBy === 'cognito_form'
                      ? (typeof document.storageKey === 'string' && document.storageKey.trim().length > 0
                          ? attachmentCognitoLabelByStorageKey.get(document.storageKey) ||
                            resolveCognitoAttachmentFieldLabel(
                              {
                                filename: document.fileName,
                                mimeType: document.mimeType,
                                fileSize: document.fileSize
                              },
                              cognitoAttachmentLabelCandidates
                            )
                          : resolveCognitoAttachmentFieldLabel(
                              {
                                filename: document.fileName,
                                mimeType: document.mimeType,
                                fileSize: document.fileSize
                              },
                              cognitoAttachmentLabelCandidates
                            ))
                      : null

                  return (
                    <tr key={document.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 text-slate-900">
                      <div className="space-y-1">
                        {cognitoFieldLabel ? (
                          <p className="text-xs font-medium uppercase tracking-wide text-sky-700">
                            {cognitoFieldLabel}
                          </p>
                        ) : null}
                        <p className="break-all font-medium">{document.fileName}</p>
                        <a
                          href={`/api/admin/claims/${claim.id}/documents/${document.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-700 underline underline-offset-2"
                        >
                          Open PDF
                        </a>
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      <div className="space-y-1">
                        <p>Uploaded</p>
                        <p>Classified: {formatDetectedDocumentType(document.documentType)}</p>
                        <p>Match: {formatDocumentMatchStatus(document.matchStatus)}</p>
                        <p>
                          Extraction:{' '}
                          {formatDocumentExtractionLabel({
                            extractionStatus: document.extractionStatus,
                            documentType: document.documentType,
                            extractedData: document.extractedData
                          })}
                        </p>
                        <p>Evidence: {formatDocumentEvidenceApplyStatus(document.extractedData)}</p>
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{formatDetectedDocumentType(document.documentType)}</td>
                    <td className="py-2 pr-4">
                      <span className={getDocumentMatchBadgeClassName(document.matchStatus)}>
                        {formatDocumentMatchStatus(document.matchStatus)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{document.matchNotes || '—'}</td>
                    <td className="py-2 pr-4 text-slate-700">{getDocumentAnchorSummary(document.parsedAnchors)}</td>
                    <td className="py-2 pr-4">
                      <span className={getDocumentExtractionBadgeClassName(document.extractionStatus)}>
                        {formatDocumentExtractionLabel({
                          extractionStatus: document.extractionStatus,
                          documentType: document.documentType,
                          extractedData: document.extractedData
                        })}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{formatIsoDate(document.extractedAt)}</td>
                    <td className="py-2 pr-4 text-slate-700">
                      <div className="space-y-1">
                        <p>{getDocumentExtractionSummary(document.documentType, document.extractedData)}</p>
                        {document.extractionWarnings ? (
                          <p className="text-xs text-amber-800">Warnings: {getDocumentExtractionWarnings(document.extractionWarnings)}</p>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <span className={getDocumentEvidenceApplyBadgeClassName(document.extractedData)}>
                        {formatDocumentEvidenceApplyStatus(document.extractedData)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{getDocumentAppliedAt(document.extractedData)}</td>
                    <td className="py-2 pr-4 text-slate-700">{getDocumentEvidenceApplySummary(document.extractedData)}</td>
                    <td className="py-2 pr-4 text-slate-700">{getDocumentEvidenceConflictSummary(document.extractedData)}</td>
                    <td className="py-2 pr-4 text-slate-700">
                      {getDocumentOutcomeSummary({
                        documentType: document.documentType,
                        matchStatus: document.matchStatus,
                        matchNotes: document.matchNotes,
                        extractionStatus: document.extractionStatus,
                        extractionWarnings: document.extractionWarnings,
                        extractedData: document.extractedData
                      })}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      <div className="space-y-1">
                        <span className={processingPresentation.className}>{processingPresentation.label}</span>
                        {processingPresentation.note ? (
                          <p className="text-xs text-slate-600">{processingPresentation.note}</p>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{formatDate(document.uploadedAt)}</td>
                    <td className="py-2 pr-4 text-slate-700">{formatClaimDocumentSource(document.uploadedBy)}</td>
                    <td className="py-2 pr-4 text-slate-700">{formatFileSize(document.fileSize)}</td>
                    <td className="py-2 pr-4 text-slate-700">
                      <div className="flex flex-col gap-2">
                        <form method="post" action={`/api/admin/claims/${claim.id}/documents/${document.id}/reprocess`}>
                          <button
                            type="submit"
                            disabled={claimLockedForProcessing}
                            className="inline-flex items-center rounded-md border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60"
                            title={
                              claimLockedForProcessing
                                ? 'Claim is locked by final decision'
                                : 'Reprocess this document'
                            }
                          >
                            Reprocess
                          </button>
                        </form>
                        <form method="post" action={`/api/admin/claims/${claim.id}/documents/${document.id}/remove`}>
                          <button
                            type="submit"
                            className="inline-flex items-center rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </form>
                      </div>
                    </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Enrichment &amp; Processing</h2>
        <p className="text-sm text-slate-600">Reference data from background lookups and processing services.</p>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Provider Health</h2>
        <p className="text-sm text-slate-600">
          Runtime provider status summary based on current config and persisted enrichment outputs.
        </p>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {providerHealthRows.map((entry) => (
                <tr key={entry.provider} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-4 font-medium text-slate-900">{entry.provider}</td>
                  <td className="py-2 pr-4">
                    <span className={getProviderHealthBadgeClassName(entry.status)}>
                      {formatProviderHealthStatus(entry.status)}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-700">{entry.source}</td>
                  <td className="py-2 pr-4 text-slate-700">{entry.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Provider Summary</h2>
        {!hasEnrichmentData ? <p className="text-slate-600">No enrichment data is available for this claim yet.</p> : null}
        {(claim.status === ClaimStatus.Submitted ||
          claim.status === ClaimStatus.ProviderFailed ||
          claim.status === ClaimStatus.ProcessingError) &&
        !claimLockedForProcessing ? (
          <form method="post" action={`/api/admin/claims/${claim.id}/retry-vin`}>
            <button
              type="submit"
              className="inline-flex items-center rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Retry VIN lookup
            </button>
          </form>
        ) : null}

        {(claim.status === ClaimStatus.Submitted ||
          claim.status === ClaimStatus.ProviderFailed ||
          claim.status === ClaimStatus.ProcessingError) &&
        claimLockedForProcessing ? (
          <p className="text-sm text-amber-900">Claim locked by final decision</p>
        ) : null}

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Provider:</span> {claim.vinDataProvider || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Year:</span>{' '}
            {vinDataYear !== null ? String(vinDataYear) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Make:</span> {vinDataMake || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Model:</span> {vinDataModel || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Provider Endpoint:</span>{' '}
            {providerEndpointHint || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Fetched At:</span>{' '}
            {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Spec Fallback Source:</span>{' '}
            {vinSpecFallback?.source || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Spec Fallback Fetched At:</span>{' '}
            {formatIsoDate(vinSpecFallback?.fetchedAt)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Body Style:</span>{' '}
            {vinSpecFallback?.bodyStyle || getOptionalString(vinDataResult.bodyStyle) || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Drivetrain:</span>{' '}
            {vinSpecFallback?.drivetrain || getOptionalString(vinDataResult.drivetrain) || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Transmission:</span>{' '}
            {vinSpecFallback?.transmissionType || getOptionalString(vinDataResult.transmissionType) || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Engine:</span>{' '}
            {vinSpecFallback?.engineSize || getOptionalString(vinDataResult.engineSize) || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Fuel Type:</span>{' '}
            {vinSpecFallback?.fuelType || getOptionalString(vinDataResult.fuelType) || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Manufacturer:</span>{' '}
            {vinSpecFallback?.manufacturer || getOptionalString(vinDataResult.manufacturer) || '—'}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Recall Information</h2>

        {!nhtsaRecalls ? (
          <p className="text-slate-600">NHTSA recall data is not available yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Recall Count:</span> {String(nhtsaRecalls.count)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Fetched At:</span>{' '}
                {formatIsoDate(nhtsaRecalls.fetchedAt)}
              </p>
            </div>

            {nhtsaRecalls.message ? (
              <p className="text-xs text-slate-600">NHTSA message: {nhtsaRecalls.message}</p>
            ) : null}

            {nhtsaRecalls.items.length === 0 ? (
              <p className="text-slate-600">No active recalls returned for this VIN.</p>
            ) : (
              <div className="space-y-2">
                {nhtsaRecalls.items.map((item, index) => (
                  <details
                    key={`${item.campaignId}-${index}`}
                    className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <summary className="cursor-pointer text-sm font-medium text-slate-900">
                      {item.campaignId !== '—' ? item.campaignId : `Recall ${index + 1}`} - {item.component}
                    </summary>
                    <div className="mt-2 grid gap-2 text-sm text-slate-700">
                      <p>
                        <span className="font-medium text-slate-900">Report Date:</span> {item.reportDate}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Safety Risk:</span> {item.safetyRisk}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Summary:</span> {item.summary}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Remedy:</span> {item.remedy}
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Title History</h2>

        {!titleHistory ? (
          <p className="text-slate-600">Title history data is not available yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Source:</span> {titleHistory.source}
              </p>
              <p>
                <span className="font-medium text-slate-900">Fetched At:</span>{' '}
                {formatIsoDate(titleHistory.fetchedAt)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Title Status:</span>{' '}
                {titleHistory.titleStatus || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Brand Flags:</span>{' '}
                {titleHistory.brandFlags.length > 0 ? titleHistory.brandFlags.join(', ') : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Odometer Flags:</span>{' '}
                {titleHistory.odometerFlags.length > 0 ? titleHistory.odometerFlags.join(', ') : '—'}
              </p>
            </div>

            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Salvage:</span>{' '}
                {titleHistory.salvageIndicator === null ? '—' : titleHistory.salvageIndicator ? 'Yes' : 'No'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Junk:</span>{' '}
                {titleHistory.junkIndicator === null ? '—' : titleHistory.junkIndicator ? 'Yes' : 'No'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Rebuilt:</span>{' '}
                {titleHistory.rebuiltIndicator === null ? '—' : titleHistory.rebuiltIndicator ? 'Yes' : 'No'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Theft:</span>{' '}
                {titleHistory.theftIndicator === null ? '—' : titleHistory.theftIndicator ? 'Yes' : 'No'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Total Loss:</span>{' '}
                {titleHistory.totalLossIndicator === null ? '—' : titleHistory.totalLossIndicator ? 'Yes' : 'No'}
              </p>
            </div>

            {titleHistory.message ? (
              <p className="text-xs text-slate-600">Provider note: {titleHistory.message}</p>
            ) : null}

            {titleHistory.events.length === 0 ? (
              <p className="text-slate-600">No title-history events returned.</p>
            ) : (
              <div className="space-y-2">
                {titleHistory.events.map((event, index) => (
                  <details
                    key={`${event.type}-${index}`}
                    className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <summary className="cursor-pointer text-sm font-medium text-slate-900">
                      {event.type}
                    </summary>
                    <div className="mt-2 grid gap-2 text-sm text-slate-700">
                      <p>
                        <span className="font-medium text-slate-900">Summary:</span> {event.summary}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Event Date:</span> {event.eventDate || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">State:</span> {event.state || '—'}
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Service History</h2>

        {!serviceHistory ? (
          <p className="text-slate-600">Service history data is not available yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Source:</span> {serviceHistory.source}
              </p>
              <p>
                <span className="font-medium text-slate-900">Fetched At:</span>{' '}
                {formatIsoDate(serviceHistory.fetchedAt)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Event Count:</span>{' '}
                {String(serviceHistory.eventCount)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Latest Mileage:</span>{' '}
                {serviceHistory.latestMileage !== null ? String(serviceHistory.latestMileage) : '—'}
              </p>
            </div>

            {serviceHistory.message ? (
              <p className="text-xs text-slate-600">Provider note: {serviceHistory.message}</p>
            ) : null}

            {serviceHistory.events.length === 0 ? (
              <p className="text-slate-600">No service-history events returned.</p>
            ) : (
              <div className="space-y-2">
                {serviceHistory.events.map((event, index) => (
                  <details
                    key={`${event.eventDate || 'unknown-date'}-${event.serviceType || 'service'}-${index}`}
                    className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <summary className="cursor-pointer text-sm font-medium text-slate-900">
                      {event.serviceType || 'Service Event'}
                    </summary>
                    <div className="mt-2 grid gap-2 text-sm text-slate-700">
                      <p>
                        <span className="font-medium text-slate-900">Event Date:</span>{' '}
                        {event.eventDate || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Mileage:</span>{' '}
                        {event.mileage !== null ? String(event.mileage) : '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Description:</span>{' '}
                        {event.description || '—'}
                      </p>
                      <p>
                        <span className="font-medium text-slate-900">Shop:</span> {event.shop || '—'}
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Valuation</h2>

        {!valuation ? (
          <p className="text-slate-600">Valuation data is not available yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Source:</span> {valuation.source}
              </p>
              <p>
                <span className="font-medium text-slate-900">Fetched At:</span>{' '}
                {formatIsoDate(valuation.fetchedAt)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Estimated Value:</span>{' '}
                {valuation.estimatedValue !== null
                  ? `${valuation.currency || 'USD'} ${String(valuation.estimatedValue)}`
                  : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Retail Value:</span>{' '}
                {valuation.retailValue !== null
                  ? `${valuation.currency || 'USD'} ${String(valuation.retailValue)}`
                  : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Trade-In Value:</span>{' '}
                {valuation.tradeInValue !== null
                  ? `${valuation.currency || 'USD'} ${String(valuation.tradeInValue)}`
                  : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Confidence:</span>{' '}
                {valuation.confidence !== null ? String(valuation.confidence) : '—'}
              </p>
            </div>

            {valuation.message ? (
              <p className="text-xs text-slate-600">Provider note: {valuation.message}</p>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Processing Status</h2>
        <p className="text-sm text-slate-600">Current processing checkpoints for this claim.</p>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Status:</span>{' '}
            <span className={getStatusBadgeClassName(claim.status)}>{formatClaimStatusLabel(claim.status)}</span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Status:</span>{' '}
            {formatSummaryStatusLabel(claim.reviewSummaryStatus)}
          </p>
          <p>
            <span className="font-medium text-slate-900">Generated At:</span>{' '}
            {claim.reviewSummaryGeneratedAt ? formatDate(claim.reviewSummaryGeneratedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Job ID:</span>{' '}
            {claim.reviewSummaryJobId || '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Rule Evaluated At:</span>{' '}
            {claim.reviewRuleEvaluatedAt ? formatDate(claim.reviewRuleEvaluatedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">VIN Fetched At:</span>{' '}
            {claim.vinDataFetchedAt ? formatDate(claim.vinDataFetchedAt) : '—'}
          </p>
          <p>
            <span className="font-medium text-slate-900">Retry Requested At:</span>{' '}
            {claim.vinLookupRetryRequestedAt ? formatDate(claim.vinLookupRetryRequestedAt) : '—'}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Activity Timeline</h2>
        <p className="text-sm text-slate-600">Chronological history of key claim events and reviewer actions.</p>

        {timelineAuditLogs.length === 0 ? (
          <p className="text-slate-600">No activity recorded for this claim yet.</p>
        ) : (
          <ol className="space-y-3">
            {timelineAuditLogs.map((auditLog: any) => {
              const label = getAuditActionLabel(auditLog.action)
              const message = getAuditMessage(auditLog.action, auditLog.metadata)
              const metadataRows = getTimelineMetadataRows(auditLog.action, auditLog.metadata)
              const timestamp = formatDateParts(auditLog.createdAt)

              return (
                <li key={auditLog.id} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 break-all text-sm font-medium text-slate-900">{label}</p>
                      <span className={getTimelineEventBadgeClassName(auditLog.action)}>
                        {getTimelineEventBadgeText(auditLog.action)}
                      </span>
                    </div>
                    <div className="text-right text-xs text-slate-600">
                      <p>
                        <span className="font-medium text-slate-700">Date:</span> {timestamp.date}
                      </p>
                      <p>
                        <span className="font-medium text-slate-700">Time:</span> {timestamp.time}
                      </p>
                    </div>
                  </div>

                  {message ? <p className="mt-2 break-words text-sm text-slate-700">{message}</p> : null}

                  {metadataRows.length > 0 ? (
                    <div className="mt-2 grid gap-1 text-xs text-slate-700 sm:grid-cols-2">
                      {metadataRows.map((entry, index) => (
                        <p key={`${entry.label}-${entry.value}-${index}`}>
                          <span className="font-medium text-slate-900">{entry.label}:</span> {entry.value}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
      </div>

    </section>
  )
}

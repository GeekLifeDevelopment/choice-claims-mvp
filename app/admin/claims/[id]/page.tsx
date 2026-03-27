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
import { isClaimLockedForProcessing } from '../../../../lib/review/claim-lock'

export const dynamic = 'force-dynamic'

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

function getAuditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    claim_created: 'Claim created',
    claim_document_uploaded: 'Document uploaded',
    claim_document_classified: 'Document classified',
    claim_document_match_evaluated: 'Document match evaluated',
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
    action === 'claim_document_classified' ||
    action === 'claim_document_match_evaluated'
  ) {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
  }

  if (action === 'claim_document_classified' || action === 'claim_document_match_evaluated') {
    return `${base} border-sky-300 bg-sky-50 text-sky-700`
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

  if (action === 'claim_document_classified' || action === 'claim_document_match_evaluated') {
    return 'Document'
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
  const processingStatus = getOptionalString(record.processingStatus)
  const documentType = getOptionalString(record.documentType)
  const matchStatus = getOptionalString(record.matchStatus)
  const matchNotes = getOptionalString(record.matchNotes)
  const fileSize = getOptionalNumber(record.fileSize)

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

  if (action === 'claim_document_uploaded') {
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
  }

  if (reason) {
    rows.push({ label: 'Reason', value: reason })
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

type PageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    retry?: string
    reviewDecision?: string
    summaryRegenerate?: string
    documentUpload?: string
    documentUploadCount?: string
  }>
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

  const claimSelectBase = {
    id: true,
    claimNumber: true,
    status: true,
    source: true,
    claimantName: true,
    claimantEmail: true,
    claimantPhone: true,
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

    if (!isMissingDocumentsField && !isMissingDocumentsTable && !isMissingDocumentMetadataField) {
      throw error
    }

    if (isMissingDocumentMetadataField) {
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
      matchNotes: document.matchNotes ?? null,
      parsedAnchors: document.parsedAnchors ?? null
    }))
  }

  if (!claim) {
    notFound()
  }

  const vinDataResult = asRecord(claim.vinDataResult)
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
  const hasEnrichmentData =
    claim.vinDataFetchedAt !== null ||
    Boolean(claim.vinDataProvider) ||
    Boolean(claim.vinDataProviderResultCode) ||
    Boolean(claim.vinDataProviderResultMessage) ||
    Object.keys(vinDataResult).length > 0

  return (
    <section className="card space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl">Claim {claim.claimNumber}</h1>
        <Link href="/admin/claims" className="text-sm text-slate-600 underline underline-offset-2">
          Back to Claims
        </Link>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Claim Info</h2>
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

      {claimLockedForProcessing ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Claim locked by final decision ({claim.reviewDecision}).
        </p>
      ) : null}

      <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
        <p>
          <span className="font-medium text-slate-900">Claim #:</span> {claim.claimNumber}
        </p>
        <p>
          <span className="font-medium text-slate-900">Status:</span>{' '}
          <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
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
          <span className="font-medium text-slate-900">Attachment Count:</span> {claim.attachments.length}
        </p>
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
          <p className="text-slate-600">No review summary yet.</p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Adjudication Result</h2>

        {!adjudicationResult ? (
          <p className="text-slate-600">No adjudication result available for this claim.</p>
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
        <h2 className="text-lg font-semibold text-slate-900">Rule Flags</h2>

        <p className="text-sm text-slate-600">
          Legacy/system rule outputs from the earlier rule evaluation step.
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
                <option value="NeedsReview">NeedsReview</option>
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
        <h2 className="text-lg font-semibold text-slate-900">Attachments</h2>
        <p className="text-sm text-slate-600">Preview image only. Use Open file for PDFs and other file types.</p>
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
        <h2 className="text-lg font-semibold text-slate-900">Supporting Documents</h2>
        <p className="text-sm text-slate-600">
          Upload claim-specific supporting PDFs for reviewer reference. These files are separate from intake
          attachments.
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
              placeholder="Reviewer or team name"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            />
          </label>

          <button
            type="submit"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          >
            Upload Supporting PDFs
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
                  <th className="py-2 pr-4 font-medium">Detected Type</th>
                  <th className="py-2 pr-4 font-medium">Match</th>
                  <th className="py-2 pr-4 font-medium">Match Note</th>
                  <th className="py-2 pr-4 font-medium">Anchors</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Uploaded</th>
                  <th className="py-2 pr-4 font-medium">By</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {claim.claimDocuments.map((document: any) => (
                  <tr key={document.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 text-slate-900">
                      <div className="space-y-1">
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
                    <td className="py-2 pr-4 text-slate-700">{formatDetectedDocumentType(document.documentType)}</td>
                    <td className="py-2 pr-4">
                      <span className={getDocumentMatchBadgeClassName(document.matchStatus)}>
                        {formatDocumentMatchStatus(document.matchStatus)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{document.matchNotes || '—'}</td>
                    <td className="py-2 pr-4 text-slate-700">{getDocumentAnchorSummary(document.parsedAnchors)}</td>
                    <td className="py-2 pr-4 text-slate-700">{document.processingStatus || 'uploaded'}</td>
                    <td className="py-2 pr-4 text-slate-700">{formatDate(document.uploadedAt)}</td>
                    <td className="py-2 pr-4 text-slate-700">{document.uploadedBy || '—'}</td>
                    <td className="py-2 pr-4 text-slate-700">{formatFileSize(document.fileSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Enrichment &amp; Processing</h2>
        <p className="text-sm text-slate-600">Provider and downstream enrichment outputs grouped for review.</p>
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
        <h2 className="text-lg font-semibold text-slate-900">Pipeline Status</h2>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Status:</span>{' '}
            <span className={getStatusBadgeClassName(claim.status)}>{claim.status}</span>
          </p>
          <p>
            <span className="font-medium text-slate-900">Summary Status:</span>{' '}
            {claim.reviewSummaryStatus || 'NotRequested'}
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
        <p className="text-sm text-slate-600">Timeline uses the latest persisted claim audit events.</p>

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

                  <p className="mt-1 text-xs text-slate-600">Event key: {auditLog.action}</p>

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

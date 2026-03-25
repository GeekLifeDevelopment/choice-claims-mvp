import Link from 'next/link'
import { notFound } from 'next/navigation'
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

function getAuditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    claim_created: 'Claim created',
    duplicate_blocked: 'Duplicate blocked',
    vin_lookup_enqueued: 'VIN lookup queued',
    vin_lookup_requeued: 'VIN retry requested',
    vin_data_fetched: 'VIN data fetched',
    vin_data_fetch_failed: 'VIN data fetch failed',
    review_summary_queued: 'Summary generation queued',
    review_summary_generated: 'Summary generated',
    review_summary_failed: 'Summary generation failed',
    review_summary_regenerate_queued: 'Summary regenerate requested',
    review_decision_changed: 'Decision changed',
    intake_validation_failed: 'Validation failed'
  }

  return labels[action] || action.replace(/_/g, ' ')
}

function getTimelineMetadataDetails(action: string, metadata: unknown): string | null {
  const record = asRecord(metadata)
  const source = getOptionalString(record.source)
  const reason = getOptionalString(record.reason)
  const reviewer = getOptionalString(record.reviewer)
  const provider = getOptionalString(record.provider)
  const queueName = getOptionalString(record.queueName)

  if (action === 'review_decision_changed') {
    const toDecision = getOptionalString(record.toDecision)
    const fromDecision = getOptionalString(record.fromDecision)
    if (toDecision) {
      return `Decision changed${fromDecision ? ` from ${fromDecision}` : ''} to ${toDecision}`
    }
  }

  if (reason) {
    return `Reason: ${reason}`
  }

  if (reviewer) {
    return `Reviewer: ${reviewer}`
  }

  if (provider) {
    return `Provider: ${provider}`
  }

  if (queueName) {
    return `Queue: ${queueName}`
  }

  if (source) {
    return `Source: ${source}`
  }

  return null
}

function formatDebugJson(value: unknown): string {
  if (value == null) {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
  const adjudicationRecord = asRecord(record.adjudicationResult)

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
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

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

function getProviderStatusLabel(value: unknown, questionId?: string): string {
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
    if (questionId === 'recall_relevance') {
      return 'No matching recalls'
    }

    if (questionId === 'maintenance_history' || questionId === 'prior_repairs') {
      return 'No service records'
    }

    if (questionId === 'branded_title') {
      return 'No title records'
    }

    if (questionId === 'valuation_context') {
      return 'No valuation data'
    }

    return 'No result'
  }

  if (value === 'not_applicable') {
    return 'Not applicable'
  }

  return 'Unknown'
}

function getProviderStatusBadgeClassName(value: unknown): string {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

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
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold'

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
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

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

function getProviderSourceHint(normalized: Record<string, unknown>, raw: unknown): string | null {
  const rawRecord = asRecord(raw)
  const rawSource = getOptionalString(rawRecord.source)
  if (rawSource) {
    return rawSource
  }

  const hasVinSpecificationsEnvelope = rawRecord.vinSpecifications !== undefined
  if (hasVinSpecificationsEnvelope) {
    return 'vinSpecifications'
  }

  const normalizedSource = getOptionalString(normalized.source)
  if (normalizedSource) {
    return normalizedSource
  }

  return null
}

function getProviderEndpointHint(raw: unknown): string | null {
  const rawRecord = asRecord(raw)
  if (rawRecord.vinspecifications !== undefined) {
    return 'vinspecifications'
  }

  const hasVinSpecificationsEnvelope = rawRecord.vinSpecifications !== undefined
  return hasVinSpecificationsEnvelope ? 'vinspecifications' : null
}

function getEndpointAttempts(raw: unknown): string[] {
  const rawRecord = asRecord(raw)
  return Object.keys(rawRecord).filter((key) => key !== 'endpointErrors')
}

function getEndpointErrors(raw: unknown): Array<{ endpoint: string; message: string; status?: number; reason?: string }> {
  const rawRecord = asRecord(raw)
  const endpointErrors = asRecord(rawRecord.endpointErrors)

  return Object.entries(endpointErrors)
    .map(([endpoint, details]) => {
      const detailRecord = asRecord(details)
      const message = getOptionalString(detailRecord.message)

      return {
        endpoint,
        message: message || 'Endpoint failed',
        status: getOptionalNumber(detailRecord.status) ?? undefined,
        reason: getOptionalString(detailRecord.reason) ?? undefined
      }
    })
    .filter((entry) => Boolean(entry.endpoint))
}

const ASYNC_AUDIT_ACTIONS = new Set([
  'vin_lookup_enqueued',
  'vin_lookup_requeued',
  'review_summary_regenerate_queued',
  'vin_data_fetched',
  'vin_data_fetch_failed'
])

function getStatusBadgeClassName(status: string): string {
  const base = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium'

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
  searchParams: Promise<{ retry?: string; reviewDecision?: string; summaryRegenerate?: string }>
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

export default async function AdminClaimDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const retryBannerMessage = getRetryBannerMessage(resolvedSearchParams.retry)
  const reviewDecisionBannerMessage = getReviewDecisionBannerMessage(resolvedSearchParams.reviewDecision)
  const summaryRegenerateBannerMessage = getSummaryRegenerateBannerMessage(
    resolvedSearchParams.summaryRegenerate
  )

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
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
      rawSubmissionPayload: true,
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
    }
  })

  if (!claim) {
    notFound()
  }

  const vinDataResult = asRecord(claim.vinDataResult)
  const legacyEmbeddedRawPayload = vinDataResult.raw
  const resolvedRawProviderPayload = claim.vinDataRawPayload ?? legacyEmbeddedRawPayload ?? null
  const usingLegacyEmbeddedRawPayload = !claim.vinDataRawPayload && legacyEmbeddedRawPayload !== undefined
  const vinDataYear = getOptionalNumber(vinDataResult.year)
  const vinDataMake = getOptionalString(vinDataResult.make)
  const vinDataModel = getOptionalString(vinDataResult.model)
  const vinSpecFallback = getVinSpecFallback(vinDataResult)
  const nhtsaRecalls = getNhtsaRecalls(vinDataResult)
  const titleHistory = getTitleHistory(vinDataResult)
  const serviceHistory = getServiceHistory(vinDataResult)
  const valuation = getValuation(vinDataResult)
  const adjudicationResult = getAdjudicationResult(vinDataResult)
  const providerSourceHint = getProviderSourceHint(vinDataResult, resolvedRawProviderPayload)
  const providerEndpointHint = getProviderEndpointHint(resolvedRawProviderPayload)
  const endpointAttempts = getEndpointAttempts(resolvedRawProviderPayload)
  const endpointErrors = getEndpointErrors(resolvedRawProviderPayload)
  const asyncAuditLogs = claim.auditLogs.filter((auditLog) => ASYNC_AUDIT_ACTIONS.has(auditLog.action))
  const latestReviewDecisionAudit = claim.auditLogs.find(
    (auditLog) => auditLog.action === 'review_decision_changed'
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
  const saveDecisionButtonLabel = claimLockedForProcessing
    ? 'Locked (disabled)'
    : currentOverrideUsed
      ? 'Override Decision'
      : 'Save Decision'

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl">Claim {claim.claimNumber}</h1>
        <Link href="/admin/claims" className="text-sm text-slate-600 underline underline-offset-2">
          Back to Claims
        </Link>
      </div>

      <div className="space-y-2">
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

      <div className="space-y-2">
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Adjudication Result</h2>

        {!adjudicationResult ? (
          <p className="text-slate-600">No adjudication result scaffold generated yet.</p>
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
                  <p className="text-xs uppercase tracking-wide text-slate-500">Confidence</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {formatPercentFromFraction(adjudicationResult.overallConfidence)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Completeness</p>
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
                  <span className="font-medium text-slate-700">Generated:</span>{' '}
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
                    <th className="py-2 pr-4 font-medium">Confidence</th>
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
                          {getProviderStatusLabel(question.providerStatus, question.id)}
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Rule Flags</h2>

        {persistedRuleFlags.length === 0 ? (
          <p className="text-slate-600">No rule flags</p>
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

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <div className="grid gap-2 sm:grid-cols-2">
            <p>
              <span className="font-medium text-slate-900">Current Decision:</span>{' '}
              {claim.reviewDecision || 'None'}
            </p>
            <p>
              <span className="font-medium text-slate-900">Locked:</span>{' '}
              {claimLockedForProcessing ? 'Yes' : 'No'}
            </p>
          </div>
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

        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-900">Current Decision:</span>{' '}
            {claim.reviewDecision || 'None'}
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

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="override"
              value="true"
              defaultChecked={currentOverrideUsed}
              disabled={claimLockedForProcessing}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span className="font-medium text-slate-900">Override recommended outcome</span>
          </label>

          {currentOverrideUsed ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Override enabled - this will replace the existing decision.
            </p>
          ) : null}

          <label className="block space-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Override Reason (optional)</span>
            <textarea
              name="overrideReason"
              defaultValue={currentOverrideReason}
              rows={3}
              disabled={claimLockedForProcessing}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              placeholder="Explain why reviewer is overriding the guidance"
            />
          </label>

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

      <div className="space-y-2">
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
          <p className="text-slate-600">No attachments linked to this claim.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {claim.attachments.map((attachment) => {
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

      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">Enrichment &amp; Processing</h2>
        <p className="text-sm text-slate-600">Provider and downstream enrichment outputs grouped for review.</p>
      </div>

      <div className="space-y-2">
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Provider Summary</h2>
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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

      <div className="space-y-2">
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
            <span className="font-medium text-slate-900">Summary Generated At:</span>{' '}
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Activity Timeline</h2>
        <p className="text-sm text-slate-600">Timeline uses the latest persisted claim audit events.</p>

        {timelineAuditLogs.length === 0 ? (
          <p className="text-slate-600">No activity recorded for this claim yet.</p>
        ) : (
          <ol className="space-y-3">
            {timelineAuditLogs.map((auditLog) => {
              const label = getAuditActionLabel(auditLog.action)
              const message = getAuditMessage(auditLog.action, auditLog.metadata)
              const metadataDetails = getTimelineMetadataDetails(auditLog.action, auditLog.metadata)

              return (
                <li key={auditLog.id} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-all text-sm font-medium text-slate-900">{label}</p>
                    <p className="whitespace-nowrap text-xs text-slate-600">{formatDate(auditLog.createdAt)}</p>
                  </div>

                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-700">
                    <p>
                      <span className="font-medium text-slate-900">Event:</span> {auditLog.action}
                    </p>
                  </div>

                  {message ? <p className="mt-2 break-words text-sm text-slate-700">{message}</p> : null}

                  {metadataDetails ? <p className="mt-1 break-words text-xs text-slate-600">{metadataDetails}</p> : null}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Debug Data</h2>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Raw Submission Data</summary>
          <div className="mt-3">
            {!claim.rawSubmissionPayload ? (
              <p className="text-slate-600">Raw submission payload is not available for this claim.</p>
            ) : (
              <pre className="max-h-[28rem] overflow-auto text-xs leading-5 text-slate-800">
                {formatDebugJson(claim.rawSubmissionPayload)}
              </pre>
            )}
          </div>
        </details>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Provider JSON</summary>
          <div className="mt-3 space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-600">
                Normalized Provider Result JSON
              </p>
              {claim.vinDataResult ? (
                <pre className="max-h-[20rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(claim.vinDataResult)}
                </pre>
              ) : (
                <p className="text-slate-600">No normalized provider data persisted yet.</p>
              )}
            </div>

            {endpointErrors.length > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-amber-800">
                  Optional Endpoint Failures
                </p>
                <ul className="space-y-1 text-xs text-amber-900">
                  {endpointErrors.map((entry) => (
                    <li key={entry.endpoint}>
                      <span className="font-medium">{entry.endpoint}:</span> {entry.message}
                      {entry.status !== undefined ? ` (status ${entry.status})` : ''}
                      {entry.reason ? ` [${entry.reason}]` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              {usingLegacyEmbeddedRawPayload ? (
                <p className="mb-2 text-xs text-amber-700">
                  Showing legacy embedded raw payload from normalized result.
                </p>
              ) : null}
              {resolvedRawProviderPayload ? (
                <pre className="max-h-[20rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(resolvedRawProviderPayload)}
                </pre>
              ) : (
                <p className="text-slate-600">No raw provider payload persisted yet.</p>
              )}
            </div>
          </div>
        </details>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900">Developer Debug</summary>
          <div className="mt-3 space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium text-slate-900">Latest Async Audit Events</p>
              {asyncAuditLogs.length === 0 ? (
                <p className="text-slate-600">No async-specific audit events yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-slate-600">
                        <th className="py-2 pr-4 font-medium">Created</th>
                        <th className="py-2 pr-4 font-medium">Action</th>
                        <th className="py-2 pr-4 font-medium">Attempts</th>
                        <th className="py-2 pr-4 font-medium">Provider</th>
                        <th className="py-2 pr-4 font-medium">Error / Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asyncAuditLogs.map((auditLog) => {
                        const metadata = asRecord(auditLog.metadata)
                        const attemptsMade = getOptionalNumber(metadata.attemptsMade)
                        const attemptsAllowed = getOptionalNumber(metadata.attemptsAllowed)
                        const provider = getOptionalString(metadata.provider)
                        const errorMessage = getOptionalString(metadata.errorMessage)
                        const reason = getOptionalString(metadata.reason)

                        return (
                          <tr key={auditLog.id} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-4 whitespace-nowrap">{formatDate(auditLog.createdAt)}</td>
                            <td className="py-2 pr-4 text-slate-900">{auditLog.action}</td>
                            <td className="py-2 pr-4 text-slate-700">
                              {attemptsMade !== null && attemptsAllowed !== null
                                ? `${attemptsMade}/${attemptsAllowed}`
                                : '—'}
                            </td>
                            <td className="py-2 pr-4 text-slate-700">{provider || '—'}</td>
                            <td className="py-2 pr-4 text-slate-700">
                              {errorMessage ? (
                                <span className="font-medium text-red-700">{errorMessage}</span>
                              ) : (
                                reason || '—'
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-slate-900">Audit Logs</p>
              {claim.auditLogs.length === 0 ? (
                <p className="text-slate-600">No audit logs linked to this claim yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-slate-600">
                        <th className="py-2 pr-4 font-medium">Created</th>
                        <th className="py-2 pr-4 font-medium">Action</th>
                        <th className="py-2 pr-4 font-medium">Metadata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claim.auditLogs.map((auditLog) => (
                        <tr key={auditLog.id} className="border-b last:border-0 align-top">
                          <td className="py-2 pr-4 whitespace-nowrap">{formatDate(auditLog.createdAt)}</td>
                          <td className="py-2 pr-4 text-slate-900">{auditLog.action}</td>
                          <td className="py-2 pr-4 text-slate-700">
                            {auditLog.action === 'review_decision_changed' ? (
                              (() => {
                                const change = formatReviewDecisionChangeMetadata(auditLog.metadata)
                                if (!change) {
                                  return formatMetadataPreview(auditLog.metadata)
                                }

                                return (
                                  <div className="space-y-1">
                                    <p>
                                      Decision changed: <span className="font-medium">{change.fromDecision}</span>{' '}
                                      -&gt; <span className="font-medium">{change.toDecision}</span>
                                    </p>
                                    <p>Reviewer: {change.reviewer}</p>
                                    <p>Override Used: {change.overrideUsed ? 'Yes' : 'No'}</p>
                                    {change.overrideUsed ? <p>Override Reason: {change.overrideReason}</p> : null}
                                    <p>Notes: {change.notes}</p>
                                  </div>
                                )
                              })()
                            ) : (
                              formatMetadataPreview(auditLog.metadata)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {claim.reviewRuleFlags ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Rule Flags JSON</p>
                <pre className="max-h-[16rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(claim.reviewRuleFlags)}
                </pre>
              </div>
            ) : null}

            {adjudicationResult ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Adjudication Result JSON</p>
                <pre className="max-h-[16rem] overflow-auto text-xs leading-5 text-slate-800">
                  {formatDebugJson(adjudicationResult)}
                </pre>
              </div>
            ) : null}

            <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
              <p>
                <span className="font-medium text-slate-900">Summary Version:</span>{' '}
                {claim.reviewSummaryVersion || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Rule Version:</span>{' '}
                {claim.reviewRuleVersion || '—'}
              </p>
              <p className="sm:col-span-2">
                <span className="font-medium text-slate-900">Rule Last Error:</span>{' '}
                <span className={claim.reviewRuleLastError ? 'font-medium text-red-700' : ''}>
                  {claim.reviewRuleLastError || '—'}
                </span>
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Source Hint:</span>{' '}
                {providerSourceHint || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Endpoints Attempted:</span>{' '}
                {endpointAttempts.length > 0 ? endpointAttempts.join(', ') : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Result Code:</span>{' '}
                {claim.vinDataProviderResultCode !== null ? String(claim.vinDataProviderResultCode) : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Provider Result Message:</span>{' '}
                {claim.vinDataProviderResultMessage || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Run Attempt Count:</span>{' '}
                {String(claim.vinLookupAttemptCount)}
              </p>
              <p>
                <span className="font-medium text-slate-900">Last Failed At:</span>{' '}
                {claim.vinLookupLastFailedAt ? formatDate(claim.vinLookupLastFailedAt) : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Last Queue:</span>{' '}
                {claim.vinLookupLastQueueName || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Last Job Name:</span>{' '}
                {claim.vinLookupLastJobName || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Last Job ID:</span>{' '}
                {claim.vinLookupLastJobId || '—'}
              </p>
              <p>
                <span className="font-medium text-slate-900">Summary Enqueued At:</span>{' '}
                {claim.reviewSummaryEnqueuedAt ? formatDate(claim.reviewSummaryEnqueuedAt) : '—'}
              </p>
            </div>
          </div>
        </details>
      </div>
    </section>
  )
}

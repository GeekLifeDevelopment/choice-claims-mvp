import type { Prisma } from '@prisma/client'
import { isFeatureEnabled } from '../config/feature-flags'
import { ClaimStatus } from '../domain/claims'
import { prisma } from '../prisma'
import { classifyExternalFailure, type ExternalFailureCategory } from '../providers/failure-classification'
import { getOpenAiTimeoutMs } from '../providers/config'
import { logProviderHealth } from '../providers/provider-health-log'
import { buildClaimEvaluationInput, type ClaimEvaluationInput } from './claim-evaluation-input'
import { parseAdjudicationAiEnvelope, type AdjudicationAiFinding } from './adjudication-ai-contract'
import { buildAdjudicationResult } from './adjudication-result'
import { buildAdjudicationAiPrompt } from './build-adjudication-ai-prompt'
import { buildReviewSummaryPrompt } from './build-review-summary-prompt'
import { isClaimLockedForProcessing } from './claim-lock'
import { enqueueReviewSummaryForClaim } from './enqueue-review-summary'

const REVIEW_SUMMARY_VERSION = 'v1'
const DEFAULT_OPENAI_MODEL = process.env.REVIEW_SUMMARY_MODEL || 'gpt-4.1-mini'
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_SUMMARY_INPUT_JSON_CHARS = 12000
const FINAL_REVIEW_DECISIONS = ['Approved', 'Denied']
const STALE_JOB_GRACE_MS = 5_000

type RuleFlag = {
  code: string
  severity: string
  message: string
}

const REVIEW_SUMMARY_CLAIM_SELECT = {
  id: true,
  claimNumber: true,
  status: true,
  reviewDecision: true,
  vin: true,
  vinDataResult: true,
  reviewRuleFlags: true,
  reviewRuleEvaluatedAt: true,
  reviewSummaryEnqueuedAt: true,
  reviewSummaryStatus: true,
  updatedAt: true,
  attachments: {
    orderBy: { uploadedAt: 'asc' as const },
    select: {
      filename: true,
      mimeType: true,
      fileSize: true
    }
  }
} satisfies Prisma.ClaimSelect

type ReviewSummaryClaim = Prisma.ClaimGetPayload<{ select: typeof REVIEW_SUMMARY_CLAIM_SELECT }>

export type ProcessReviewSummaryJobResult = {
  ok: boolean
  claimId: string
  status: 'generated' | 'failed' | 'skipped'
  reason?: string
}

type ProcessReviewSummaryJobOptions = {
  requestedAt?: string | null
  persistFailureStatus?: boolean
  source?: 'rules_ready' | 'manual' | 'backfill' | 'document_evidence'
}

type AdjudicationAiExtractionOutcome = {
  findings: AdjudicationAiFinding[]
  malformedJson: boolean
  emptyResponse: boolean
  rejectedCount: number
  lowConfidenceCount: number
  skipped: boolean
  skipReason?: string
}

class OpenAiSummaryError extends Error {
  readonly category: ExternalFailureCategory
  readonly status?: number
  readonly reason?: string

  constructor(message: string, category: ExternalFailureCategory, options?: { status?: number; reason?: string }) {
    super(message)
    this.name = 'OpenAiSummaryError'
    this.category = category
    this.status = options?.status
    this.reason = options?.reason
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Review summary generation failed.'
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
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseRuleFlags(value: unknown): RuleFlag[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      const code = getOptionalString(record.code)
      const severity = getOptionalString(record.severity)
      const message = getOptionalString(record.message)

      if (!code || !severity || !message) {
        return null
      }

      return { code, severity, message }
    })
    .filter((flag): flag is RuleFlag => Boolean(flag))
}

function hasPersistedRuleFlags(value: unknown): boolean {
  return Array.isArray(value)
}

function buildProviderResultSummary(value: unknown): Record<string, unknown> {
  const record = asRecord(value)

  return {
    provider: getOptionalString(record.provider),
    vin: getOptionalString(record.vin),
    year: getOptionalNumber(record.year),
    make: getOptionalString(record.make),
    model: getOptionalString(record.model),
    trim: getOptionalString(record.trim),
    bodyStyle: getOptionalString(record.bodyStyle),
    drivetrain: getOptionalString(record.drivetrain),
    transmissionType: getOptionalString(record.transmissionType),
    engineSize: getOptionalString(record.engineSize),
    cylinders: getOptionalString(record.cylinders),
    fuelType: getOptionalString(record.fuelType),
    manufacturer: getOptionalString(record.manufacturer),
    eventCount: getOptionalNumber(record.eventCount),
    providerResultCode: getOptionalNumber(record.providerResultCode),
    providerResultMessage: getOptionalString(record.providerResultMessage),
    quickCheck: record.quickCheck,
    ownershipHistory: record.ownershipHistory,
    accident: record.accident,
    mileage: record.mileage,
    recall: record.recall,
    nhtsaRecalls: record.nhtsaRecalls,
    vinSpecFallback: record.vinSpecFallback,
    titleHistory: record.titleHistory,
    serviceHistory: record.serviceHistory,
    valuation: record.valuation,
    titleProblem: record.titleProblem,
    titleBrand: record.titleBrand
  }
}

function buildDocumentEvidenceSummary(value: unknown): Record<string, unknown> {
  const vinData = asRecord(value)
  const documentEvidence = asRecord(vinData.documentEvidence)
  const contract = asRecord(documentEvidence.contract)
  const provenance = asRecord(documentEvidence.provenance)
  const documents = asRecord(documentEvidence.documents)

  const appliedFieldCount = Object.keys(provenance).length
  const contributingDocumentCount = Object.keys(documents).length

  return {
    appliedFieldCount,
    contributingDocumentCount,
    lastAppliedAt: getOptionalString(documentEvidence.lastAppliedAt),
    contract: {
      vehiclePurchaseDate: getOptionalString(contract.vehiclePurchaseDate),
      agreementPurchaseDate: getOptionalString(contract.agreementPurchaseDate),
      mileageAtSale: getOptionalNumber(contract.mileageAtSale),
      agreementNumber: getOptionalString(contract.agreementNumber),
      deductible: getOptionalNumber(contract.deductible),
      termMonths: getOptionalNumber(contract.termMonths),
      termMiles: getOptionalNumber(contract.termMiles),
      coverageLevel: getOptionalString(contract.coverageLevel),
      planName: getOptionalString(contract.planName),
      warrantyCoverageSummary: getOptionalString(contract.warrantyCoverageSummary),
      obdCodes: Array.isArray(contract.obdCodes)
        ? contract.obdCodes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : getOptionalString(contract.obdCodes)
    },
    claimMileage: getOptionalNumber(asRecord(vinData.serviceHistory).latestMileage),
    valuationContextNote: getOptionalString(asRecord(vinData.valuation).contextNote)
  }
}

function buildSummaryInput(claim: ReviewSummaryClaim, evaluationInput: ClaimEvaluationInput, ruleFlags: RuleFlag[]) {
  return {
    claimNumber: claim.claimNumber,
    status: claim.status,
    vin: claim.vin,
    providerResult: buildProviderResultSummary(claim.vinDataResult),
    attachments: {
      count: claim.attachments.length,
      items: claim.attachments.slice(0, 8).map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize
      }))
    },
    documentEvidence: buildDocumentEvidenceSummary(claim.vinDataResult),
    ruleFlags,
    evaluationInput: {
      generatedAt: evaluationInput.generatedAt,
      readiness: evaluationInput.readiness
    },
    snapshot: evaluationInput.snapshot
  }
}

function trimSummaryText(value: string): string {
  return value.trim().replace(/\s+\n/g, '\n')
}

function stringifySummaryInput(value: unknown): string {
  const serialized = JSON.stringify(value)

  if (serialized.length <= MAX_SUMMARY_INPUT_JSON_CHARS) {
    return serialized
  }

  return `${serialized.slice(0, MAX_SUMMARY_INPUT_JSON_CHARS)}...`
}

function hasProviderData(claim: ReviewSummaryClaim): boolean {
  const providerResult = asRecord(claim.vinDataResult)
  const provider = getOptionalString(providerResult.provider)
  return Boolean(provider)
}

function buildSummaryLimitationNotes(claim: ReviewSummaryClaim, evaluationInput: ClaimEvaluationInput): string[] {
  const notes: string[] = []
  const snapshot = evaluationInput.snapshot
  const attachmentsCount = snapshot.attachments?.count ?? 0

  if (!hasProviderData(claim)) {
    notes.push('provider unavailable')
  }

  if (attachmentsCount === 0) {
    notes.push('no attachments')
  }

  if (!snapshot.attachments?.hasDocuments) {
    notes.push('no supporting documents detected')
  }

  if (!snapshot.attachments?.hasPhotos) {
    notes.push('no photos detected')
  }

  if (!snapshot.vin) {
    notes.push('VIN missing from snapshot')
  }

  if (Array.isArray(snapshot.flags) && snapshot.flags.includes('provider_failed')) {
    notes.push('provider reported failure in prior attempts')
  }

  return Array.from(new Set(notes))
}

function shouldSkipAdjudicationExtraction(evaluationInput: ClaimEvaluationInput, claim: ReviewSummaryClaim): {
  skip: boolean
  reason?: string
} {
  const snapshot = evaluationInput.snapshot
  const attachmentsCount = snapshot.attachments?.count ?? 0
  const providerAvailable = hasProviderData(claim)
  const hasCoreClaimContext = Boolean(snapshot.vin || claim.vin)

  if (!providerAvailable && attachmentsCount === 0 && !hasCoreClaimContext) {
    return {
      skip: true,
      reason: 'missing_provider_attachments_and_core_claim_context'
    }
  }

  return {
    skip: false
  }
}

function buildFallbackReviewSummary(
  claim: ReviewSummaryClaim,
  evaluationInput: ClaimEvaluationInput,
  limitationNotes: string[]
): string {
  const snapshot = evaluationInput.snapshot
  const attachmentsCount = snapshot.attachments?.count ?? 0
  const providerAvailable = hasProviderData(claim)
  const retryCount = snapshot.asyncStatus?.attemptCount
  const retryText =
    typeof retryCount === 'number' && retryCount > 1
      ? `Provider enrichment required ${retryCount} attempts.`
      : null

  const lines = [
    `Claim ${claim.claimNumber} summary generated with limited data available.`,
    providerAvailable
      ? 'Provider enrichment data exists but should be verified during review.'
      : 'Provider unavailable or incomplete at summary time.',
    attachmentsCount > 0
      ? `Attachments present (${attachmentsCount}), but document-level interpretation may be incomplete.`
      : 'No attachments were available for document or image analysis.',
    retryText,
    limitationNotes.length > 0
      ? `Insufficient evidence areas: ${limitationNotes.join('; ')}.`
      : 'Evidence coverage is partial; manual review recommended.',
    'This summary is informational only and does not make a decision. Manual review recommended.'
  ].filter((value): value is string => Boolean(value))

  return lines.join(' ')
}

function ensureSummarySafetyLanguage(
  summaryText: string,
  limitationNotes: string[],
  extractionOutcome: AdjudicationAiExtractionOutcome,
  usedFallbackSummary: boolean
): string {
  const additions: string[] = []
  const normalized = summaryText.trim()
  const lower = normalized.toLowerCase()

  if (limitationNotes.length > 0 && !/limited data available|insufficient evidence/.test(lower)) {
    additions.push('Limited data available and insufficient evidence for a fully confident automated interpretation.')
  }

  if (limitationNotes.some((note) => /provider/.test(note)) && !/provider unavailable|provider data/.test(lower)) {
    additions.push('Provider unavailable or partially available during this summary run.')
  }

  if (extractionOutcome.skipped && !/manual review recommended/.test(lower)) {
    additions.push('Manual review recommended because structured AI extraction was skipped due to missing context.')
  }

  if (
    (extractionOutcome.malformedJson || extractionOutcome.emptyResponse || extractionOutcome.lowConfidenceCount > 0) &&
    !/manual review recommended/.test(lower)
  ) {
    additions.push('Manual review recommended due to degraded AI extraction quality in this run.')
  }

  if (usedFallbackSummary && !/informational/.test(lower)) {
    additions.push('This fallback summary is informational and should not be treated as a decision.')
  }

  if (additions.length === 0) {
    return normalized
  }

  return `${normalized} ${additions.join(' ')}`.trim()
}

function buildPersistedVinDataResult(
  existingVinDataResult: unknown,
  adjudicationResult: ReturnType<typeof buildAdjudicationResult>
): Prisma.InputJsonObject {
  const vinData = asRecord(existingVinDataResult)

  return {
    ...vinData,
    adjudicationResult
  }
}

function hasPersistedAdjudicationResult(value: unknown): boolean {
  const vinData = asRecord(value)
  const adjudication = asRecord(vinData.adjudicationResult)

  return Object.keys(adjudication).length > 0
}

async function callOpenAiChatCompletions(systemMessage: string, userMessage: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.')
  }

  const timeoutMs = getOpenAiTimeoutMs()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response

  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_OPENAI_MODEL,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: {
          type: 'json_object'
        },
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>
  }

  const content = payload.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) {
    throw new Error('OpenAI response did not include content.')
  }

  return text
}

async function callOpenAiForAdjudicationFindings(
  systemMessage: string,
  userMessage: string,
  context: { claimId: string }
): Promise<AdjudicationAiExtractionOutcome> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return {
      findings: [],
      malformedJson: false,
      emptyResponse: true,
      rejectedCount: 0,
      lowConfidenceCount: 0,
      skipped: true,
      skipReason: 'missing_openai_api_key'
    }
  }

  try {
    const raw = await callOpenAiChatCompletions(systemMessage, userMessage, 700)
    const trimmed = raw.trim()
    if (!trimmed) {
      console.warn('[adjudication_ai] empty extraction response; continuing without AI findings', {
        claimId: context.claimId,
        stage: 'adjudication_extraction',
        action: 'parse_response'
      })
      return {
        findings: [],
        malformedJson: false,
        emptyResponse: true,
        rejectedCount: 0,
        lowConfidenceCount: 0,
        skipped: false
      }
    }

    const parsed = parseAdjudicationAiEnvelope(raw)
    const lowConfidenceCount = parsed.findings.filter(
      (finding) => typeof finding.confidence === 'number' && finding.confidence < 0.55
    ).length

    if (parsed.malformedJson) {
      console.warn('[adjudication_ai] malformed JSON detected; salvaged parse result used', {
        claimId: context.claimId,
        stage: 'adjudication_extraction',
        action: 'parse_response',
        acceptedCount: parsed.findings.length,
        rejectedCount: parsed.rejectedCount
      })
    }

    if (parsed.findingsInputCount === 0) {
      console.warn('[adjudication_ai] extraction returned empty findings payload', {
        claimId: context.claimId,
        stage: 'adjudication_extraction',
        action: 'validate_findings'
      })
    }

    if (parsed.rejectedCount > 0) {
      console.warn('[adjudication_ai] rejected findings during validation', {
        claimId: context.claimId,
        stage: 'adjudication_extraction',
        action: 'validate_findings',
        rejectedCount: parsed.rejectedCount,
        acceptedCount: parsed.findings.length
      })
    }

    if (lowConfidenceCount > 0) {
      console.info('[adjudication_ai] low-confidence findings detected', {
        claimId: context.claimId,
        stage: 'adjudication_extraction',
        action: 'validate_findings',
        lowConfidenceCount,
        acceptedCount: parsed.findings.length
      })
    }

    return {
      findings: parsed.findings,
      malformedJson: parsed.malformedJson,
      emptyResponse: parsed.findingsInputCount === 0,
      rejectedCount: parsed.rejectedCount,
      lowConfidenceCount,
      skipped: false
    }
  } catch (error) {
    console.warn('[adjudication_ai] extraction failed; continuing without AI findings', {
      claimId: context.claimId,
      stage: 'adjudication_extraction',
      action: 'call_openai',
      error: error instanceof Error ? error.message : 'unknown_error'
    })
    return {
      findings: [],
      malformedJson: true,
      emptyResponse: true,
      rejectedCount: 0,
      lowConfidenceCount: 0,
      skipped: false
    }
  }
}

async function persistReviewSummaryFailure(
  claimId: string,
  message: string,
  persistFailureStatus: boolean
): Promise<void> {
  await prisma.claim.updateMany({
    where: {
      id: claimId,
      status: ClaimStatus.ReadyForAI,
      OR: [
        { reviewDecision: null },
        {
          reviewDecision: {
            notIn: FINAL_REVIEW_DECISIONS
          }
        }
      ]
    },
    data: {
      ...(persistFailureStatus ? { reviewSummaryStatus: 'Failed' } : {}),
      reviewSummaryLastError: message
    }
  })
}

async function callOpenAiForReviewSummary(
  systemMessage: string,
  userMessage: string,
  context: { claimId: string }
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logProviderHealth({
      provider: 'openai',
      capability: 'summary_generation',
      event: 'unconfigured',
      mode: 'unconfigured',
      reason: 'missing_openai_api_key',
      claimId: context.claimId,
      stage: 'review_summary',
      action: 'call_openai'
    })

    throw new Error('OPENAI_API_KEY is not configured.')
  }

  logProviderHealth({
    provider: 'openai',
    capability: 'summary_generation',
    event: 'configured',
    mode: 'live',
    source: DEFAULT_OPENAI_MODEL,
    claimId: context.claimId,
    stage: 'review_summary',
    action: 'call_openai'
  })

  const timeoutMs = getOpenAiTimeoutMs()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response

  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_OPENAI_MODEL,
        temperature: 0.1,
        max_tokens: 280,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: controller.signal
    })
  } catch (error) {
    const category = classifyExternalFailure({
      errorMessage: error instanceof Error ? error.message : null,
      fallbackCategory: 'network_error'
    })

    if (category === 'timeout') {
      logProviderHealth({
        provider: 'openai',
        capability: 'summary_generation',
        event: 'live_failure',
        mode: 'failed',
        reason: 'openai_timeout',
        claimId: context.claimId,
        stage: 'review_summary',
        action: 'call_openai'
      })

      console.warn('[summary] openai timeout', {
        claimId: context.claimId,
        timeoutMs,
        model: DEFAULT_OPENAI_MODEL
      })

      throw new OpenAiSummaryError(`OpenAI request timed out after ${timeoutMs}ms`, 'timeout', {
        reason: 'openai_timeout'
      })
    }

    logProviderHealth({
      provider: 'openai',
      capability: 'summary_generation',
      event: 'live_failure',
      mode: 'failed',
      reason: 'openai_network_error',
      details: error instanceof Error ? error.message : undefined,
      claimId: context.claimId,
      stage: 'review_summary',
      action: 'call_openai'
    })

    console.error('[summary] openai network_error', {
      claimId: context.claimId,
      model: DEFAULT_OPENAI_MODEL,
      error: error instanceof Error ? error.message : 'Unknown OpenAI network error'
    })

    throw new OpenAiSummaryError('OpenAI request failed before response.', 'network_error', {
      reason: 'openai_network_error'
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const errorBody = await response.text()
    const failureCategory = classifyExternalFailure({
      status: response.status,
      reason: 'openai_http_error',
      errorMessage: errorBody,
      fallbackCategory: 'unknown_error'
    })

    logProviderHealth({
      provider: 'openai',
      capability: 'summary_generation',
      event: 'live_failure',
      mode: 'failed',
      status: response.status,
      reason: 'openai_http_error',
      details: errorBody.slice(0, 300),
      claimId: context.claimId,
      stage: 'review_summary',
      action: 'call_openai'
    })

    console.warn(`[summary] openai ${failureCategory}`, {
      claimId: context.claimId,
      status: response.status,
      model: DEFAULT_OPENAI_MODEL
    })

    throw new OpenAiSummaryError(
      `OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`,
      failureCategory,
      {
        status: response.status,
        reason: 'openai_http_error'
      }
    )
  }

  let payload: {
    choices?: Array<{ message?: { content?: string | null } }>
  }

  try {
    payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
  } catch {
    logProviderHealth({
      provider: 'openai',
      capability: 'summary_generation',
      event: 'live_failure',
      mode: 'failed',
      reason: 'openai_invalid_json',
      claimId: context.claimId,
      stage: 'review_summary',
      action: 'parse_response'
    })

    console.warn('[summary] openai bad_response', {
      claimId: context.claimId,
      reason: 'openai_invalid_json',
      model: DEFAULT_OPENAI_MODEL
    })

    throw new OpenAiSummaryError('OpenAI response was not valid JSON.', 'bad_response', {
      reason: 'openai_invalid_json'
    })
  }

  const content = payload.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? trimSummaryText(content) : ''

  if (!text) {
    logProviderHealth({
      provider: 'openai',
      capability: 'summary_generation',
      event: 'capability_unavailable',
      mode: 'failed',
      reason: 'empty_summary_text',
      claimId: context.claimId,
      stage: 'review_summary',
      action: 'parse_response'
    })

    console.warn('[summary] openai bad_response', {
      claimId: context.claimId,
      reason: 'empty_summary_text',
      model: DEFAULT_OPENAI_MODEL
    })

    throw new OpenAiSummaryError('OpenAI response did not include summary text.', 'bad_response', {
      reason: 'empty_summary_text'
    })
  }

  logProviderHealth({
    provider: 'openai',
    capability: 'summary_generation',
    event: 'live_success',
    mode: 'live',
    source: DEFAULT_OPENAI_MODEL,
    claimId: context.claimId,
    stage: 'review_summary',
    action: 'parse_response'
  })

  return text
}

function parseRequestedAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isStaleRequestedAt(requestedAt: Date | null, claimUpdatedAt: Date): boolean {
  if (!requestedAt) {
    return false
  }

  return claimUpdatedAt.getTime() > requestedAt.getTime() + STALE_JOB_GRACE_MS
}

function shouldBypassFinalDecisionLock(source: string | null | undefined): boolean {
  return source === 'manual' || source === 'document_evidence'
}

export async function processReviewSummaryJob(
  claimId: string,
  options: ProcessReviewSummaryJobOptions = {}
): Promise<ProcessReviewSummaryJobResult> {
  const persistFailureStatus = options.persistFailureStatus ?? true
  const bypassFinalDecisionLock = shouldBypassFinalDecisionLock(options.source)

  if (!isFeatureEnabled('summary_generation') || !isFeatureEnabled('openai')) {
    console.info('[feature] openai disabled', {
      claimId
    })

    return {
      ok: true,
      claimId,
      status: 'skipped',
      reason: 'summary_disabled'
    }
  }

  console.info('[summary] job started', {
    claimId,
    requestedAt: options.requestedAt ?? null
  })

  const requestedAt = parseRequestedAt(options.requestedAt)
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: REVIEW_SUMMARY_CLAIM_SELECT
  })

  if (!claim) {
    console.error('[summary] job failed claim missing', {
      claimId
    })

    return {
      ok: false,
      claimId,
      status: 'failed',
      reason: 'Claim not found for review summary job.'
    }
  }

  if (isClaimLockedForProcessing(claim) && !bypassFinalDecisionLock) {
    console.warn('[summary] job skipped locked claim', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision
    })

    return {
      ok: true,
      claimId: claim.id,
      status: 'skipped',
      reason: 'locked_final_decision'
    }
  }

  if (claim.reviewSummaryStatus !== 'Queued') {
    console.info('[summary] job skipped non-queued status', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewSummaryStatus: claim.reviewSummaryStatus
    })

    return {
      ok: true,
      claimId: claim.id,
      status: 'skipped',
      reason: 'obsolete_review_summary_status'
    }
  }

  if (isStaleRequestedAt(requestedAt, claim.updatedAt)) {
    let staleTransitionCount = 0

    if (bypassFinalDecisionLock) {
      const requeueResult = await enqueueReviewSummaryForClaim(claim.id, options.source ?? 'manual', {
        allowLockedFinalDecision: true
      })

      staleTransitionCount = requeueResult.enqueued ? 1 : 0
    } else {
      const staleTransition = await prisma.claim.updateMany({
        where: {
          id: claim.id,
          reviewSummaryStatus: 'Queued',
          status: ClaimStatus.ReadyForAI,
          OR: [
            { reviewDecision: null },
            {
              reviewDecision: {
                notIn: FINAL_REVIEW_DECISIONS
              }
            }
          ]
        },
        data: {
          reviewSummaryStatus: 'Failed',
          reviewSummaryLastError: 'stale_job',
          reviewSummaryVersion: REVIEW_SUMMARY_VERSION
        }
      })

      staleTransitionCount = staleTransition.count
    }

    console.info('[summary] job skipped stale request', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      requestedAt: options.requestedAt ?? null,
      claimUpdatedAt: claim.updatedAt.toISOString(),
      transitioned: staleTransitionCount,
      source: options.source ?? null,
      bypassFinalDecisionLock
    })

    return {
      ok: true,
      claimId: claim.id,
      status: 'skipped',
      reason: 'stale_job'
    }
  }

  try {
    if (claim.status !== ClaimStatus.ReadyForAI) {
      return {
        ok: true,
        claimId: claim.id,
        status: 'skipped',
        reason: `obsolete_claim_status:${claim.status}`
      }
    }

    const evaluationInput = buildClaimEvaluationInput(claim)
    if (!evaluationInput) {
      const message = 'ClaimEvaluationInput is missing and summary generation cannot proceed.'
      await persistReviewSummaryFailure(claim.id, message, persistFailureStatus)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    const snapshot = evaluationInput.snapshot
    if (!snapshot) {
      const message = 'ClaimReviewSnapshot is missing and summary generation cannot proceed.'
      await persistReviewSummaryFailure(claim.id, message, persistFailureStatus)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    if (!claim.reviewRuleEvaluatedAt) {
      const message = 'Missing persisted rule evaluation timestamp.'
      await persistReviewSummaryFailure(claim.id, message, persistFailureStatus)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    if (!hasPersistedRuleFlags(claim.reviewRuleFlags)) {
      const message = 'Missing persisted rule flags for review summary generation.'
      await persistReviewSummaryFailure(claim.id, message, persistFailureStatus)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    const ruleFlags = parseRuleFlags(claim.reviewRuleFlags)

    const summaryInput = buildSummaryInput(claim, evaluationInput, ruleFlags)
    const summaryInputJson = stringifySummaryInput(summaryInput)

    const limitationNotes = buildSummaryLimitationNotes(claim, evaluationInput)

    const prompt = buildReviewSummaryPrompt({
      claimNumber: claim.claimNumber,
      status: claim.status,
      summaryInputJson,
      limitationNotes
    })

    let reviewSummaryText: string
    let usedFallbackSummary = false

    try {
      reviewSummaryText = await callOpenAiForReviewSummary(prompt.systemMessage, prompt.userMessage, {
        claimId: claim.id
      })
    } catch (error) {
      usedFallbackSummary = true
      const reason = error instanceof Error ? error.message : 'unknown_error'
      console.warn('[summary] ai summary failed; using fallback summary', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        reason
      })

      reviewSummaryText = buildFallbackReviewSummary(claim, evaluationInput, limitationNotes)
    }

    const aiPrompt = buildAdjudicationAiPrompt({
      claimNumber: claim.claimNumber,
      status: claim.status,
      summaryInputJson,
      limitationNotes
    })

    const extractionSkip = shouldSkipAdjudicationExtraction(evaluationInput, claim)
    let aiExtractionOutcome: AdjudicationAiExtractionOutcome

    if (extractionSkip.skip) {
      console.info('[adjudication_ai] extraction skipped due to missing context', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        reason: extractionSkip.reason
      })

      aiExtractionOutcome = {
        findings: [],
        malformedJson: false,
        emptyResponse: true,
        rejectedCount: 0,
        lowConfidenceCount: 0,
        skipped: true,
        skipReason: extractionSkip.reason
      }
    } else {
      aiExtractionOutcome = await callOpenAiForAdjudicationFindings(aiPrompt.systemMessage, aiPrompt.userMessage, {
        claimId: claim.id
      })
    }

    const safeReviewSummaryText = ensureSummarySafetyLanguage(
      reviewSummaryText,
      limitationNotes,
      aiExtractionOutcome,
      usedFallbackSummary
    )

    if (
      limitationNotes.length > 0 ||
      usedFallbackSummary ||
      aiExtractionOutcome.malformedJson ||
      aiExtractionOutcome.emptyResponse ||
      aiExtractionOutcome.lowConfidenceCount > 0 ||
      aiExtractionOutcome.skipped
    ) {
      console.info('[summary] generated with degraded inputs', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        usedFallbackSummary,
        limitationCount: limitationNotes.length,
        extractionSkipped: aiExtractionOutcome.skipped,
        extractionMalformedJson: aiExtractionOutcome.malformedJson,
        extractionLowConfidenceCount: aiExtractionOutcome.lowConfidenceCount,
        extractionRejectedCount: aiExtractionOutcome.rejectedCount
      })
    }

    const adjudicationResult = buildAdjudicationResult({
      evaluationInput,
      vinDataResult: claim.vinDataResult,
      reviewSummaryText: safeReviewSummaryText,
      aiFindings: aiExtractionOutcome.findings
    })
    const persistedVinDataResult = buildPersistedVinDataResult(claim.vinDataResult, adjudicationResult)

    const persisted = await prisma.claim.updateMany({
      where: {
        id: claim.id,
        status: ClaimStatus.ReadyForAI,
        reviewSummaryStatus: 'Queued',
        ...(bypassFinalDecisionLock
          ? {}
          : {
              OR: [
                { reviewDecision: null },
                {
                  reviewDecision: {
                    notIn: FINAL_REVIEW_DECISIONS
                  }
                }
              ]
            })
      },
      data: {
        vinDataResult: persistedVinDataResult,
        reviewSummaryStatus: 'Generated',
        reviewSummaryGeneratedAt: new Date(),
        reviewSummaryText: safeReviewSummaryText,
        reviewSummaryVersion: REVIEW_SUMMARY_VERSION,
        reviewSummaryLastError: null
      }
    })

    if (persisted.count === 0) {
      console.info('[summary] job skipped obsolete claim state', {
        claimId: claim.id,
        claimNumber: claim.claimNumber
      })

      return {
        ok: true,
        claimId: claim.id,
        status: 'skipped',
        reason: 'obsolete_claim_state'
      }
    }

    const persistedClaim = await prisma.claim.findUnique({
      where: { id: claim.id },
      select: {
        vinDataResult: true
      }
    })

    if (persistedClaim && !hasPersistedAdjudicationResult(persistedClaim.vinDataResult)) {
      const backfilledVinDataResult = buildPersistedVinDataResult(
        persistedClaim.vinDataResult,
        adjudicationResult
      )

      await prisma.claim.updateMany({
        where: {
          id: claim.id,
          reviewSummaryStatus: 'Generated'
        },
        data: {
          vinDataResult: backfilledVinDataResult
        }
      })
    }

    console.info('[summary] job finished', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: 'generated'
    })

    return {
      ok: true,
      claimId: claim.id,
      status: 'generated'
    }
  } catch (error) {
    const message = toErrorMessage(error)
    const failureCategory =
      error instanceof OpenAiSummaryError
        ? error.category
        : classifyExternalFailure({
            errorMessage: message,
            fallbackCategory: 'unknown_error'
          })

    console.error('[summary] job failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      persistFailureStatus,
      failureCategory,
      error: message
    })

    await persistReviewSummaryFailure(claim.id, message, persistFailureStatus)

    return {
      ok: false,
      claimId: claim.id,
      status: 'failed',
      reason: message
    }
  }
}

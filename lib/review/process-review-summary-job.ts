import type { Prisma } from '@prisma/client'
import { ClaimStatus } from '../domain/claims'
import { prisma } from '../prisma'
import { buildClaimEvaluationInput, type ClaimEvaluationInput } from './claim-evaluation-input'
import { buildReviewSummaryPrompt } from './build-review-summary-prompt'
import { isClaimLockedForProcessing } from './claim-lock'

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

async function persistReviewSummaryFailure(claimId: string, message: string): Promise<void> {
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
      reviewSummaryStatus: 'Failed',
      reviewSummaryLastError: message
    }
  })
}

async function callOpenAiForReviewSummary(systemMessage: string, userMessage: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.')
  }

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
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
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>
  }

  const content = payload.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? trimSummaryText(content) : ''

  if (!text) {
    throw new Error('OpenAI response did not include summary text.')
  }

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

export async function processReviewSummaryJob(
  claimId: string,
  options: ProcessReviewSummaryJobOptions = {}
): Promise<ProcessReviewSummaryJobResult> {
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

  if (isClaimLockedForProcessing(claim)) {
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
    console.info('[summary] job skipped stale request', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      requestedAt: options.requestedAt ?? null,
      claimUpdatedAt: claim.updatedAt.toISOString()
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
      await persistReviewSummaryFailure(claim.id, message)

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
      await persistReviewSummaryFailure(claim.id, message)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    if (!claim.reviewRuleEvaluatedAt) {
      const message = 'Missing persisted rule evaluation timestamp.'
      await persistReviewSummaryFailure(claim.id, message)

      return {
        ok: false,
        claimId: claim.id,
        status: 'failed',
        reason: message
      }
    }

    if (!hasPersistedRuleFlags(claim.reviewRuleFlags)) {
      const message = 'Missing persisted rule flags for review summary generation.'
      await persistReviewSummaryFailure(claim.id, message)

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

    const prompt = buildReviewSummaryPrompt({
      claimNumber: claim.claimNumber,
      status: claim.status,
      summaryInputJson
    })

    const reviewSummaryText = await callOpenAiForReviewSummary(prompt.systemMessage, prompt.userMessage)

    const persisted = await prisma.claim.updateMany({
      where: {
        id: claim.id,
        status: ClaimStatus.ReadyForAI,
        reviewSummaryStatus: 'Queued',
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
        reviewSummaryStatus: 'Generated',
        reviewSummaryGeneratedAt: new Date(),
        reviewSummaryText,
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
    console.error('[summary] job failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error: message
    })

    await persistReviewSummaryFailure(claim.id, message)

    return {
      ok: false,
      claimId: claim.id,
      status: 'failed',
      reason: message
    }
  }
}

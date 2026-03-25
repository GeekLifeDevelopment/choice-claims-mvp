import type { ClaimEvaluationInput } from './claim-evaluation-input'
import {
  ADJUDICATION_AI_SUPPORTED_QUESTION_IDS,
  type AdjudicationAiFinding
} from './adjudication-ai-contract'
import {
  buildDeterministicQuestionScores,
  computeDeterministicTotalScore
} from './adjudication-scoring'
import { buildQuestionEvidenceAndMissing } from './adjudication-evidence'
import { calculateQuestionCompleteness } from './adjudication-completeness'
import { calculateQuestionConfidence } from './adjudication-confidence'
import { resolveQuestionProviderStatus } from './provider-status'
import { calculateOverallCompleteness, calculateOverallConfidence } from './adjudication-overall'
import { calculateRecommendation, buildOverrideSuggestion } from './adjudication-recommendation'
import { buildDecisionReasons } from './adjudication-reasons'
import { buildDecisionExplanation } from './adjudication-explanation'

export type AdjudicationQuestionStatus =
  | 'scored'
  | 'insufficient_data'
  | 'not_applicable'
  | 'provider_unavailable'

export type AdjudicationRecommendation = 'approve' | 'deny' | 'partial' | 'manual_review'

export type AdjudicationCompleteness = 'low' | 'medium' | 'high'

export type AdjudicationSourceType = 'provider' | 'claim' | 'documents' | 'system'

export type AdjudicationProviderStatus =
  | 'ok'
  | 'not_configured'
  | 'error'
  | 'no_result'
  | 'available'
  | 'unavailable'
  | 'not_applicable'

export type AdjudicationEvidenceEntry = {
  label: string
  value: string | number | boolean | null
}

export type AdjudicationQuestionResult = {
  id: string
  title: string
  status: AdjudicationQuestionStatus
  score: number | null
  explanation: string
  evidence: AdjudicationEvidenceEntry[]
  missing?: string[]
  completeness?: number
  confidence?: number
  sourceType: AdjudicationSourceType
  providerStatus: AdjudicationProviderStatus
}

export type AdjudicationResult = {
  version: string
  generatedAt: string
  totalScore: number
  recommendation: AdjudicationRecommendation
  completeness: AdjudicationCompleteness
  overallCompleteness?: number
  overallConfidence?: number
  reasons?: string[]
  explanation?: string
  overrideSuggestion?: string
  summary: string
  questions: AdjudicationQuestionResult[]
}

const ADJUDICATION_RESULT_VERSION = 's8_5_ticket5_v1'
const AI_INTERPRETATION_QUESTION_ID_SET = new Set<string>(ADJUDICATION_AI_SUPPORTED_QUESTION_IDS)

function buildQuestion(
  input: Pick<AdjudicationQuestionResult, 'id' | 'title' | 'sourceType' | 'status' | 'score' | 'explanation' | 'providerStatus'> & {
    evidence?: AdjudicationEvidenceEntry[]
    missing?: string[]
    completeness?: number
    confidence?: number
  }
): AdjudicationQuestionResult {
  return {
    ...input,
    evidence: input.evidence ?? [],
    missing: input.missing ?? [],
    completeness: input.completeness ?? 0,
    confidence: input.confidence ?? 0
  }
}

function resolveCompleteness(scoredCount: number, totalCount: number): AdjudicationCompleteness {
  if (totalCount === 0) {
    return 'low'
  }

  const ratio = scoredCount / totalCount
  if (ratio >= 0.66) {
    return 'high'
  }

  if (ratio >= 0.33) {
    return 'medium'
  }

  return 'low'
}

function mergeAiFindingsIntoQuestions(
  questions: AdjudicationQuestionResult[],
  aiFindings: AdjudicationAiFinding[]
): AdjudicationQuestionResult[] {
  if (aiFindings.length === 0) {
    return questions
  }

  const findingsByQuestion = new Map<string, AdjudicationAiFinding>()
  for (const finding of aiFindings) {
    findingsByQuestion.set(finding.questionId, finding)
  }

  return questions.map((question) => {
    if (!AI_INTERPRETATION_QUESTION_ID_SET.has(question.id)) {
      return question
    }

    const aiFinding = findingsByQuestion.get(question.id)
    if (!aiFinding) {
      return question
    }

    return {
      ...question,
      status: aiFinding.status,
      score: aiFinding.status === 'scored' ? aiFinding.scoreSuggestion ?? null : null,
      explanation: aiFinding.explanation,
      evidence: aiFinding.evidence,
      confidence: aiFinding.confidence ?? question.confidence,
      sourceType: aiFinding.sourceType
    }
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeQuestionConsistency(
  question: AdjudicationQuestionResult,
  providerStatus: AdjudicationProviderStatus
): Pick<AdjudicationQuestionResult, 'status' | 'score' | 'explanation'> {
  let status = question.status
  let score = question.score
  let explanation = question.explanation

  const providerUnavailable = providerStatus === 'not_configured' || providerStatus === 'error'

  if (providerUnavailable && question.sourceType === 'provider') {
    status = 'provider_unavailable'
    score = null
    if (!/not configured|error|unavailable/i.test(explanation)) {
      explanation = `${explanation} Provider data is currently unavailable for trusted scoring.`
    }
  }

  if (providerStatus === 'no_result' && status === 'provider_unavailable' && question.sourceType === 'provider') {
    status = 'insufficient_data'
  }

  if (status !== 'scored') {
    score = null
  }

  if (status === 'scored' && score === null) {
    status = 'insufficient_data'
  }

  return {
    status,
    score,
    explanation
  }
}

function applyQuestionMetadata(
  questions: AdjudicationQuestionResult[],
  input: {
    evaluationInput: ClaimEvaluationInput
    vinDataResult: unknown
    aiFindings?: AdjudicationAiFinding[]
  }
): AdjudicationQuestionResult[] {
  const vinDataResultRecord = asRecord(input.vinDataResult)
  const claimSnapshotRecord = asRecord(input.evaluationInput.snapshot)
  const aiFindingsByQuestion = new Map<string, AdjudicationAiFinding>(
    (input.aiFindings ?? []).map((finding) => [finding.questionId, finding])
  )

  return questions.map((question) => {
    const providerStatus = resolveQuestionProviderStatus(question.id, vinDataResultRecord)
    const normalized = normalizeQuestionConsistency(question, providerStatus)
    const evidenceAndMissing = buildQuestionEvidenceAndMissing({
      questionId: question.id,
      existingEvidence: question.evidence,
      providerStatus,
      vinDataResult: vinDataResultRecord,
      claimSnapshot: claimSnapshotRecord,
      hasAiFinding: aiFindingsByQuestion.has(question.id)
    })

    const completeness = calculateQuestionCompleteness({
      providerStatus,
      evidence: evidenceAndMissing.evidence.map((entry) => entry.label),
      missing: evidenceAndMissing.missing
    })

    const confidence = calculateQuestionConfidence({
      status: normalized.status,
      providerStatus,
      completeness,
      aiConfidence: question.confidence
    })

    return {
      ...question,
      status: normalized.status,
      score: normalized.score,
      explanation: normalized.explanation,
      providerStatus,
      evidence: evidenceAndMissing.evidence,
      missing: evidenceAndMissing.missing,
      completeness,
      confidence
    }
  })
}

export function buildAdjudicationResult(input: {
  evaluationInput: ClaimEvaluationInput
  vinDataResult: unknown
  reviewSummaryText: string
  aiFindings?: AdjudicationAiFinding[]
}): AdjudicationResult {
  const hasAttachments = input.evaluationInput.snapshot.attachments?.count
    ? input.evaluationInput.snapshot.attachments.count > 0
    : false

  const deterministicScores = buildDeterministicQuestionScores({
    evaluationInput: input.evaluationInput,
    vinDataResult: input.vinDataResult
  })

  const baseQuestions: AdjudicationQuestionResult[] = [
    deterministicScores.miles_since_purchase ??
      buildQuestion({
        id: 'miles_since_purchase',
        title: 'Miles since purchase',
        status: 'insufficient_data',
        score: null,
        explanation: 'Purchase mileage baseline is not available.',
        sourceType: 'claim',
        providerStatus: 'no_result'
      }),
    deterministicScores.days_since_purchase ??
      buildQuestion({
        id: 'days_since_purchase',
        title: 'Days since purchase',
        status: 'insufficient_data',
        score: null,
        explanation: 'Purchase date is not currently captured for deterministic scoring.',
        sourceType: 'claim',
        providerStatus: 'no_result'
      }),
    deterministicScores.maintenance_history ??
      buildQuestion({
        id: 'maintenance_history',
        title: 'Maintenance history consistency',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Service history provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'no_result'
      }),
    deterministicScores.branded_title ??
      buildQuestion({
        id: 'branded_title',
        title: 'Branded title risk',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Title history provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'no_result'
      }),
    deterministicScores.recall_relevance ??
      buildQuestion({
        id: 'recall_relevance',
        title: 'Recall relevance to claim',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Recall provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'no_result'
      }),
    buildQuestion({
      id: 'prior_repairs',
      title: 'Prior repairs evidence',
      status: 'insufficient_data',
      score: null,
      explanation: 'Prior repair pattern logic is deferred to a later ticket.',
      sourceType: 'provider',
      providerStatus: 'no_result'
    }),
    buildQuestion({
      id: 'document_match',
      title: 'Document-to-claim consistency',
      status: hasAttachments ? 'insufficient_data' : 'not_applicable',
      score: null,
      explanation: hasAttachments
        ? 'Attachments exist, but document matching logic is not implemented in this ticket.'
        : 'No documents attached for matching.',
      sourceType: 'documents',
      providerStatus: 'no_result',
      evidence: [
        {
          label: 'attachment_count',
          value: input.evaluationInput.snapshot.attachments?.count ?? 0
        }
      ]
    }),
    buildQuestion({
      id: 'image_modifications',
      title: 'Image modification risk',
      status: hasAttachments ? 'insufficient_data' : 'not_applicable',
      score: null,
      explanation: hasAttachments
        ? 'Image-forensics scoring is deferred to a future ticket.'
        : 'No image evidence attached.',
      sourceType: 'documents',
      providerStatus: 'no_result'
    }),
    buildQuestion({
      id: 'obd_codes',
      title: 'OBD code consistency',
      status: 'insufficient_data',
      score: null,
      explanation: 'OBD code ingestion is not yet part of the current processing flow.',
      sourceType: 'claim',
      providerStatus: 'no_result'
    }),
    buildQuestion({
      id: 'warranty_support',
      title: 'Warranty support alignment',
      status: 'insufficient_data',
      score: null,
      explanation: 'Warranty eligibility checks are deferred to later adjudication tickets.',
      sourceType: 'system',
      providerStatus: 'no_result'
    }),
    deterministicScores.valuation_context ??
      buildQuestion({
        id: 'valuation_context',
        title: 'Valuation context',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Valuation provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'no_result'
      })
  ]

  const mergedQuestions = mergeAiFindingsIntoQuestions(baseQuestions, input.aiFindings ?? [])
  const questions = applyQuestionMetadata(mergedQuestions, input)
  const scoredQuestions = questions.filter((question) => question.status === 'scored' && question.score !== null)
  const totalScore = computeDeterministicTotalScore(questions)
  const overallCompleteness = calculateOverallCompleteness({ questions })
  const overallConfidence = calculateOverallConfidence({
    questions,
    overallCompleteness
  })
  const recommendation = calculateRecommendation({
    totalScore,
    overallCompleteness,
    overallConfidence,
    questions
  })
  const reasons = buildDecisionReasons({
    questions,
    overallCompleteness,
    overallConfidence
  })
  const explanation = buildDecisionExplanation({
    recommendation,
    reasons,
    overallCompleteness,
    overallConfidence
  })
  const overrideSuggestion = buildOverrideSuggestion({
    recommendation,
    overallCompleteness,
    overallConfidence,
    questions
  })

  return {
    version: ADJUDICATION_RESULT_VERSION,
    generatedAt: new Date().toISOString(),
    totalScore,
    recommendation,
    completeness: resolveCompleteness(scoredQuestions.length, questions.length),
    overallCompleteness,
    overallConfidence,
    reasons,
    explanation,
    overrideSuggestion,
    summary: input.reviewSummaryText,
    questions
  }
}

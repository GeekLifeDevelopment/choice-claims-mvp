import type { ClaimEvaluationInput } from './claim-evaluation-input'
import {
  buildDeterministicQuestionScores,
  computeDeterministicTotalScore,
  mapRecommendationFromScore
} from './adjudication-scoring'

export type AdjudicationQuestionStatus =
  | 'scored'
  | 'insufficient_data'
  | 'not_applicable'
  | 'provider_unavailable'

export type AdjudicationRecommendation = 'approve' | 'deny' | 'partial' | 'manual_review'

export type AdjudicationCompleteness = 'low' | 'medium' | 'high'

export type AdjudicationSourceType = 'provider' | 'claim' | 'documents' | 'system'

export type AdjudicationProviderStatus = 'available' | 'unavailable' | 'not_applicable'

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
  sourceType: AdjudicationSourceType
  providerStatus: AdjudicationProviderStatus
}

export type AdjudicationResult = {
  version: string
  generatedAt: string
  totalScore: number
  recommendation: AdjudicationRecommendation
  completeness: AdjudicationCompleteness
  summary: string
  questions: AdjudicationQuestionResult[]
}

const ADJUDICATION_RESULT_VERSION = 's8_5_ticket2_v1'

function buildQuestion(
  input: Pick<AdjudicationQuestionResult, 'id' | 'title' | 'sourceType' | 'status' | 'score' | 'explanation' | 'providerStatus'> & {
    evidence?: AdjudicationEvidenceEntry[]
  }
): AdjudicationQuestionResult {
  return {
    ...input,
    evidence: input.evidence ?? []
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

export function buildAdjudicationResult(input: {
  evaluationInput: ClaimEvaluationInput
  vinDataResult: unknown
  reviewSummaryText: string
}): AdjudicationResult {
  const hasAttachments = input.evaluationInput.snapshot.attachments?.count
    ? input.evaluationInput.snapshot.attachments.count > 0
    : false

  const deterministicScores = buildDeterministicQuestionScores({
    evaluationInput: input.evaluationInput,
    vinDataResult: input.vinDataResult
  })

  const questions: AdjudicationQuestionResult[] = [
    deterministicScores.miles_since_purchase ??
      buildQuestion({
        id: 'miles_since_purchase',
        title: 'Miles since purchase',
        status: 'insufficient_data',
        score: null,
        explanation: 'Purchase mileage baseline is not available.',
        sourceType: 'claim',
        providerStatus: 'not_applicable'
      }),
    deterministicScores.days_since_purchase ??
      buildQuestion({
        id: 'days_since_purchase',
        title: 'Days since purchase',
        status: 'insufficient_data',
        score: null,
        explanation: 'Purchase date is not currently captured for deterministic scoring.',
        sourceType: 'claim',
        providerStatus: 'not_applicable'
      }),
    deterministicScores.maintenance_history ??
      buildQuestion({
        id: 'maintenance_history',
        title: 'Maintenance history consistency',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Service history provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'unavailable'
      }),
    deterministicScores.branded_title ??
      buildQuestion({
        id: 'branded_title',
        title: 'Branded title risk',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Title history provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'unavailable'
      }),
    deterministicScores.recall_relevance ??
      buildQuestion({
        id: 'recall_relevance',
        title: 'Recall relevance to claim',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Recall provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'unavailable'
      }),
    buildQuestion({
      id: 'prior_repairs',
      title: 'Prior repairs evidence',
      status: 'insufficient_data',
      score: null,
      explanation: 'Prior repair pattern logic is deferred to a later ticket.',
      sourceType: 'provider',
      providerStatus: 'not_applicable'
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
      providerStatus: 'not_applicable',
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
      providerStatus: 'not_applicable'
    }),
    buildQuestion({
      id: 'obd_codes',
      title: 'OBD code consistency',
      status: 'insufficient_data',
      score: null,
      explanation: 'OBD code ingestion is not yet part of the current processing flow.',
      sourceType: 'claim',
      providerStatus: 'not_applicable'
    }),
    buildQuestion({
      id: 'warranty_support',
      title: 'Warranty support alignment',
      status: 'insufficient_data',
      score: null,
      explanation: 'Warranty eligibility checks are deferred to later adjudication tickets.',
      sourceType: 'system',
      providerStatus: 'not_applicable'
    }),
    deterministicScores.valuation_context ??
      buildQuestion({
        id: 'valuation_context',
        title: 'Valuation context',
        status: 'provider_unavailable',
        score: null,
        explanation: 'Valuation provider data is unavailable.',
        sourceType: 'provider',
        providerStatus: 'unavailable'
      })
  ]

  const scoredQuestions = questions.filter((question) => question.status === 'scored' && question.score !== null)
  const totalScore = computeDeterministicTotalScore(questions)
  const recommendation = mapRecommendationFromScore(totalScore, scoredQuestions.length)

  return {
    version: ADJUDICATION_RESULT_VERSION,
    generatedAt: new Date().toISOString(),
    totalScore,
    recommendation,
    completeness: resolveCompleteness(scoredQuestions.length, questions.length),
    summary: input.reviewSummaryText,
    questions
  }
}

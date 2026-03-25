import type { ClaimEvaluationInput } from './claim-evaluation-input'

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

const ADJUDICATION_RESULT_VERSION = 's8_5_ticket1_v1'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function hasArrayData(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

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
  const providerResult = asRecord(input.vinDataResult)
  const titleHistory = asRecord(providerResult.titleHistory)
  const serviceHistory = asRecord(providerResult.serviceHistory)
  const nhtsaRecalls = asRecord(providerResult.nhtsaRecalls)
  const valuation = asRecord(providerResult.valuation)

  const hasTitleHistory = Object.keys(titleHistory).length > 0
  const hasServiceHistory = Object.keys(serviceHistory).length > 0
  const hasRecalls = Object.keys(nhtsaRecalls).length > 0
  const hasValuation = Object.keys(valuation).length > 0
  const hasAttachments = input.evaluationInput.snapshot.attachments?.count
    ? input.evaluationInput.snapshot.attachments.count > 0
    : false

  const questions: AdjudicationQuestionResult[] = [
    buildQuestion({
      id: 'miles_since_purchase',
      title: 'Miles since purchase',
      status: 'insufficient_data',
      score: null,
      explanation: 'Purchase baseline is not yet modeled in the adjudication scaffold.',
      sourceType: 'claim',
      providerStatus: 'not_applicable'
    }),
    buildQuestion({
      id: 'days_since_purchase',
      title: 'Days since purchase',
      status: 'insufficient_data',
      score: null,
      explanation: 'Purchase date baseline is not yet modeled in the adjudication scaffold.',
      sourceType: 'claim',
      providerStatus: 'not_applicable'
    }),
    buildQuestion({
      id: 'maintenance_history',
      title: 'Maintenance history consistency',
      status: hasServiceHistory ? 'scored' : 'provider_unavailable',
      score: hasServiceHistory ? 55 : null,
      explanation: hasServiceHistory
        ? 'Service history is present; deterministic scoring will be added in a later ticket.'
        : 'Service history provider data is unavailable.',
      sourceType: 'provider',
      providerStatus: hasServiceHistory ? 'available' : 'unavailable',
      evidence: [
        {
          label: 'event_count',
          value: typeof serviceHistory.eventCount === 'number' ? serviceHistory.eventCount : null
        }
      ]
    }),
    buildQuestion({
      id: 'branded_title',
      title: 'Branded title risk',
      status: hasTitleHistory ? 'scored' : 'provider_unavailable',
      score: hasTitleHistory ? 45 : null,
      explanation: hasTitleHistory
        ? 'Title history is present; detailed brand severity logic is deferred.'
        : 'Title history provider data is unavailable.',
      sourceType: 'provider',
      providerStatus: hasTitleHistory ? 'available' : 'unavailable',
      evidence: [
        {
          label: 'brand_flags_present',
          value: hasArrayData(titleHistory.brandFlags)
        }
      ]
    }),
    buildQuestion({
      id: 'recall_relevance',
      title: 'Recall relevance to claim',
      status: hasRecalls ? 'scored' : 'provider_unavailable',
      score: hasRecalls ? 60 : null,
      explanation: hasRecalls
        ? 'Recall data is present; claim-specific relevance scoring is deferred.'
        : 'Recall provider data is unavailable.',
      sourceType: 'provider',
      providerStatus: hasRecalls ? 'available' : 'unavailable',
      evidence: [
        {
          label: 'recall_count',
          value: typeof nhtsaRecalls.count === 'number' ? nhtsaRecalls.count : null
        }
      ]
    }),
    buildQuestion({
      id: 'prior_repairs',
      title: 'Prior repairs evidence',
      status: hasServiceHistory ? 'scored' : 'provider_unavailable',
      score: hasServiceHistory ? 50 : null,
      explanation: hasServiceHistory
        ? 'Service events exist; repair-pattern scoring is deferred.'
        : 'Service history provider data is unavailable.',
      sourceType: 'provider',
      providerStatus: hasServiceHistory ? 'available' : 'unavailable'
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
    buildQuestion({
      id: 'valuation_context',
      title: 'Valuation context',
      status: hasValuation ? 'scored' : 'provider_unavailable',
      score: hasValuation ? 58 : null,
      explanation: hasValuation
        ? 'Valuation data is present; threshold-based financial scoring is deferred.'
        : 'Valuation provider data is unavailable.',
      sourceType: 'provider',
      providerStatus: hasValuation ? 'available' : 'unavailable'
    })
  ]

  const scoredQuestions = questions.filter((question) => question.status === 'scored' && question.score !== null)
  const totalScore =
    scoredQuestions.length > 0
      ? Math.round(
          scoredQuestions.reduce((sum, question) => sum + (question.score ?? 0), 0) / scoredQuestions.length
        )
      : 0

  return {
    version: ADJUDICATION_RESULT_VERSION,
    generatedAt: new Date().toISOString(),
    totalScore,
    recommendation: 'manual_review',
    completeness: resolveCompleteness(scoredQuestions.length, questions.length),
    summary: input.reviewSummaryText,
    questions
  }
}

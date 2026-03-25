import type { ClaimEvaluationInput } from './claim-evaluation-input'
import type {
  AdjudicationEvidenceEntry,
  AdjudicationQuestionResult,
  AdjudicationRecommendation
} from './adjudication-result'

type DeterministicQuestionId =
  | 'miles_since_purchase'
  | 'days_since_purchase'
  | 'maintenance_history'
  | 'branded_title'
  | 'recall_relevance'
  | 'valuation_context'

type DeterministicQuestionMap = Partial<Record<DeterministicQuestionId, AdjudicationQuestionResult>>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function withEvidence(evidence: AdjudicationEvidenceEntry[]): AdjudicationEvidenceEntry[] {
  return evidence.filter((entry) => entry.label.trim().length > 0)
}

function scoreMilesSincePurchase(): AdjudicationQuestionResult {
  return {
    id: 'miles_since_purchase',
    title: 'Miles since purchase',
    status: 'insufficient_data',
    score: null,
    explanation: 'Purchase mileage baseline is not available in current persisted claim/enrichment data.',
    evidence: [],
    sourceType: 'claim',
    providerStatus: 'not_applicable'
  }
}

function scoreDaysSincePurchase(): AdjudicationQuestionResult {
  return {
    id: 'days_since_purchase',
    title: 'Days since purchase',
    status: 'insufficient_data',
    score: null,
    explanation: 'Purchase date is not currently captured in a deterministic field for adjudication scoring.',
    evidence: [],
    sourceType: 'claim',
    providerStatus: 'not_applicable'
  }
}

function scoreMaintenanceHistory(vinDataResult: unknown): AdjudicationQuestionResult {
  const providerResult = asRecord(vinDataResult)
  const serviceHistory = asRecord(providerResult.serviceHistory)

  if (Object.keys(serviceHistory).length === 0) {
    return {
      id: 'maintenance_history',
      title: 'Maintenance history consistency',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Service history provider data is unavailable.',
      evidence: [],
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  const eventCount = getOptionalNumber(serviceHistory.eventCount)
  if (eventCount === null) {
    return {
      id: 'maintenance_history',
      title: 'Maintenance history consistency',
      status: 'insufficient_data',
      score: null,
      explanation: 'Service history exists but event count is missing for deterministic scoring.',
      evidence: withEvidence([{ label: 'service_history_present', value: true }]),
      sourceType: 'provider',
      providerStatus: 'available'
    }
  }

  const score = eventCount >= 6 ? 82 : eventCount >= 3 ? 68 : eventCount >= 1 ? 55 : 40

  return {
    id: 'maintenance_history',
    title: 'Maintenance history consistency',
    status: 'scored',
    score,
    explanation:
      eventCount >= 6
        ? 'Higher service event coverage suggests stronger maintenance history support.'
        : eventCount >= 3
          ? 'Moderate service event coverage supports baseline maintenance confidence.'
          : eventCount >= 1
            ? 'Limited service events provide partial maintenance evidence.'
            : 'No service events were returned, reducing maintenance-history confidence.',
    evidence: withEvidence([{ label: 'service_event_count', value: eventCount }]),
    sourceType: 'provider',
    providerStatus: 'available'
  }
}

function scoreBrandedTitle(vinDataResult: unknown): AdjudicationQuestionResult {
  const providerResult = asRecord(vinDataResult)
  const titleHistory = asRecord(providerResult.titleHistory)

  if (Object.keys(titleHistory).length === 0) {
    return {
      id: 'branded_title',
      title: 'Branded title risk',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Title history provider data is unavailable.',
      evidence: [],
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  const brandFlags = getStringArray(titleHistory.brandFlags)
  const salvage = titleHistory.salvageIndicator === true
  const rebuilt = titleHistory.rebuiltIndicator === true
  const totalLoss = titleHistory.totalLossIndicator === true

  const riskSignals = brandFlags.length + Number(salvage) + Number(rebuilt) + Number(totalLoss)
  const score = riskSignals === 0 ? 88 : riskSignals === 1 ? 62 : riskSignals === 2 ? 42 : 20

  return {
    id: 'branded_title',
    title: 'Branded title risk',
    status: 'scored',
    score,
    explanation:
      riskSignals === 0
        ? 'No title-brand risk signals were found in title history.'
        : `Detected ${riskSignals} title-risk signal(s) (brand/salvage/rebuilt/total-loss indicators).`,
    evidence: withEvidence([
      { label: 'brand_flag_count', value: brandFlags.length },
      { label: 'salvage_indicator', value: salvage },
      { label: 'rebuilt_indicator', value: rebuilt },
      { label: 'total_loss_indicator', value: totalLoss }
    ]),
    sourceType: 'provider',
    providerStatus: 'available'
  }
}

function scoreRecallRelevance(vinDataResult: unknown): AdjudicationQuestionResult {
  const providerResult = asRecord(vinDataResult)
  const recalls = asRecord(providerResult.nhtsaRecalls)

  if (Object.keys(recalls).length === 0) {
    return {
      id: 'recall_relevance',
      title: 'Recall relevance to claim',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Recall provider data is unavailable.',
      evidence: [],
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  const recallCount = getOptionalNumber(recalls.count)
  if (recallCount === null) {
    return {
      id: 'recall_relevance',
      title: 'Recall relevance to claim',
      status: 'insufficient_data',
      score: null,
      explanation: 'Recall payload exists but recall count is missing.',
      evidence: withEvidence([{ label: 'recalls_payload_present', value: true }]),
      sourceType: 'provider',
      providerStatus: 'available'
    }
  }

  const score = recallCount === 0 ? 85 : recallCount <= 2 ? 55 : 25

  return {
    id: 'recall_relevance',
    title: 'Recall relevance to claim',
    status: 'scored',
    score,
    explanation:
      recallCount === 0
        ? 'No active recalls were reported.'
        : recallCount <= 2
          ? 'A limited number of recalls were reported and may need manual relevance review.'
          : 'Multiple recalls were reported, increasing potential claim relevance risk.',
    evidence: withEvidence([{ label: 'recall_count', value: recallCount }]),
    sourceType: 'provider',
    providerStatus: 'available'
  }
}

function scoreValuationContext(vinDataResult: unknown): AdjudicationQuestionResult {
  const providerResult = asRecord(vinDataResult)
  const valuation = asRecord(providerResult.valuation)

  if (Object.keys(valuation).length === 0) {
    return {
      id: 'valuation_context',
      title: 'Valuation context',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Valuation provider data is unavailable.',
      evidence: [],
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  const estimatedValue = getOptionalNumber(valuation.estimatedValue)
  const retailValue = getOptionalNumber(valuation.retailValue)
  const tradeInValue = getOptionalNumber(valuation.tradeInValue)
  const confidence = getOptionalNumber(valuation.confidence)

  if (estimatedValue === null && retailValue === null && tradeInValue === null) {
    return {
      id: 'valuation_context',
      title: 'Valuation context',
      status: 'insufficient_data',
      score: null,
      explanation: 'Valuation payload exists but contains no numeric valuation values for scoring.',
      evidence: withEvidence([{ label: 'valuation_payload_present', value: true }]),
      sourceType: 'provider',
      providerStatus: 'available'
    }
  }

  const score = confidence !== null ? (confidence >= 80 ? 78 : confidence >= 50 ? 63 : 48) : 58

  return {
    id: 'valuation_context',
    title: 'Valuation context',
    status: 'scored',
    score,
    explanation:
      confidence !== null
        ? `Valuation confidence (${confidence}) was used for deterministic scoring.`
        : 'Valuation amounts are present but confidence is missing; baseline valuation score applied.',
    evidence: withEvidence([
      { label: 'estimated_value', value: estimatedValue },
      { label: 'retail_value', value: retailValue },
      { label: 'trade_in_value', value: tradeInValue },
      { label: 'confidence', value: confidence }
    ]),
    sourceType: 'provider',
    providerStatus: 'available'
  }
}

export function buildDeterministicQuestionScores(input: {
  evaluationInput: ClaimEvaluationInput
  vinDataResult: unknown
}): DeterministicQuestionMap {
  return {
    miles_since_purchase: scoreMilesSincePurchase(),
    days_since_purchase: scoreDaysSincePurchase(),
    maintenance_history: scoreMaintenanceHistory(input.vinDataResult),
    branded_title: scoreBrandedTitle(input.vinDataResult),
    recall_relevance: scoreRecallRelevance(input.vinDataResult),
    valuation_context: scoreValuationContext(input.vinDataResult)
  }
}

export function computeDeterministicTotalScore(questions: AdjudicationQuestionResult[]): number {
  const scored = questions.filter((question) => question.status === 'scored' && question.score !== null)

  if (scored.length === 0) {
    return 0
  }

  const average = scored.reduce((sum, question) => sum + (question.score ?? 0), 0) / scored.length
  return Math.round(average)
}

export function mapRecommendationFromScore(totalScore: number, scoredCount: number): AdjudicationRecommendation {
  if (scoredCount === 0) {
    return 'manual_review'
  }

  if (totalScore >= 75) {
    return 'approve'
  }

  if (totalScore >= 55) {
    return 'manual_review'
  }

  if (totalScore >= 40) {
    return 'partial'
  }

  return 'deny'
}

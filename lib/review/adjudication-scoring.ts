import type { ClaimEvaluationInput } from './claim-evaluation-input'
import type {
  AdjudicationEvidenceEntry,
  AdjudicationQuestionResult,
  AdjudicationRecommendation
} from './adjudication-result'

type DeterministicQuestionId =
  | 'miles_since_purchase'
  | 'days_since_purchase'
  | 'obd_codes'
  | 'warranty_support'
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

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isStubOrNotConfigured(input: Record<string, unknown>): boolean {
  const source = getOptionalString(input.source)
  const message = getOptionalString(input.message)

  if (source && /stub/i.test(source)) {
    return true
  }

  if (message && /(stub|unconfigured|not configured|disabled|missing config)/i.test(message)) {
    return true
  }

  return false
}

function isProviderError(input: Record<string, unknown>): boolean {
  const message = getOptionalString(input.message)
  if (!message) {
    return false
  }

  return /(error|failed|timeout|exception)/i.test(message)
}

function withEvidence(evidence: AdjudicationEvidenceEntry[]): AdjudicationEvidenceEntry[] {
  return evidence.filter((entry) => entry.label.trim().length > 0)
}

function getSubmission(input: ClaimEvaluationInput): Record<string, unknown> {
  const snapshot = asRecord(input.snapshot)
  return asRecord(snapshot.submission)
}

function getDocumentContract(vinDataResult: unknown): Record<string, unknown> {
  const vinData = asRecord(vinDataResult)
  const documentEvidence = asRecord(vinData.documentEvidence)
  return asRecord(documentEvidence.contract)
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function scoreMilesSincePurchase(input: { evaluationInput: ClaimEvaluationInput; vinDataResult: unknown }): AdjudicationQuestionResult {
  const submission = getSubmission(input.evaluationInput)
  const contract = getDocumentContract(input.vinDataResult)
  const vinData = asRecord(input.vinDataResult)
  const serviceHistory = asRecord(vinData.serviceHistory)

  const currentMileage =
    getOptionalNumber(submission.mileage) ??
    getOptionalNumber(serviceHistory.latestMileage) ??
    getOptionalNumber(contract.currentMileage)
  const purchaseMileage = getOptionalNumber(submission.purchaseMileage) ?? getOptionalNumber(contract.mileageAtSale)

  if (currentMileage === null || purchaseMileage === null) {
    return {
      id: 'miles_since_purchase',
      title: 'Miles since purchase',
      status: 'insufficient_data',
      score: null,
      explanation: 'Current or purchase mileage baseline is incomplete for deterministic scoring.',
      evidence: withEvidence([
        {
          label: 'current_mileage_available',
          value: currentMileage !== null
        },
        {
          label: 'purchase_mileage_available',
          value: purchaseMileage !== null
        }
      ]),
      sourceType: 'claim',
      providerStatus: 'available'
    }
  }

  const milesSincePurchase = Math.max(0, currentMileage - purchaseMileage)
  const score =
    milesSincePurchase <= 1_000 ? 84 : milesSincePurchase <= 5_000 ? 74 : milesSincePurchase <= 15_000 ? 62 : 48

  return {
    id: 'miles_since_purchase',
    title: 'Miles since purchase',
    status: 'scored',
    score,
    explanation:
      milesSincePurchase <= 1_000
        ? 'Low mileage since purchase indicates limited post-purchase exposure.'
        : milesSincePurchase <= 5_000
          ? 'Moderate mileage since purchase provides baseline usage context.'
          : milesSincePurchase <= 15_000
            ? 'Elevated mileage since purchase suggests moderate exposure and review risk.'
            : 'High mileage since purchase indicates significant exposure and may warrant closer review.',
    evidence: withEvidence([
      { label: 'current_mileage', value: currentMileage },
      { label: 'purchase_mileage', value: purchaseMileage },
      { label: 'miles_since_purchase', value: milesSincePurchase }
    ]),
    sourceType: 'claim',
    providerStatus: 'available'
  }
}

function scoreDaysSincePurchase(input: { evaluationInput: ClaimEvaluationInput; vinDataResult: unknown }): AdjudicationQuestionResult {
  const submission = getSubmission(input.evaluationInput)
  const contract = getDocumentContract(input.vinDataResult)
  const purchaseDate =
    parseDate(submission.purchaseDate) ??
    parseDate(contract.vehiclePurchaseDate) ??
    parseDate(contract.agreementPurchaseDate)

  if (!purchaseDate) {
    return {
      id: 'days_since_purchase',
      title: 'Days since purchase',
      status: 'insufficient_data',
      score: null,
      explanation: 'Purchase date is missing from submission and contract evidence.',
      evidence: withEvidence([{ label: 'purchase_date_available', value: false }]),
      sourceType: 'claim',
      providerStatus: 'available'
    }
  }

  const generatedAt = parseDate(input.evaluationInput.generatedAt) ?? new Date()
  const elapsedMs = generatedAt.getTime() - purchaseDate.getTime()
  const daysSincePurchase = Math.max(0, Math.floor(elapsedMs / 86_400_000))
  const score = daysSincePurchase <= 30 ? 82 : daysSincePurchase <= 90 ? 70 : daysSincePurchase <= 180 ? 60 : 52

  return {
    id: 'days_since_purchase',
    title: 'Days since purchase',
    status: 'scored',
    score,
    explanation:
      daysSincePurchase <= 30
        ? 'Recent purchase date provides stronger recency confidence for claim context.'
        : daysSincePurchase <= 90
          ? 'Purchase date indicates moderate recency and stable context for adjudication.'
          : daysSincePurchase <= 180
            ? 'Purchase date is older but still useful for adjudication context.'
            : 'Older purchase date context may reduce recency certainty for this claim.',
    evidence: withEvidence([
      { label: 'purchase_date', value: purchaseDate.toISOString().slice(0, 10) },
      { label: 'days_since_purchase', value: daysSincePurchase }
    ]),
    sourceType: 'claim',
    providerStatus: 'available'
  }
}

function scoreObdCodes(vinDataResult: unknown): AdjudicationQuestionResult {
  const contract = getDocumentContract(vinDataResult)
  const rawCodes = contract.obdCodes

  const codes = Array.isArray(rawCodes)
    ? rawCodes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : typeof rawCodes === 'string' && rawCodes.trim().length > 0
      ? rawCodes
          .split(/[\n,;\s]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : []

  if (codes.length === 0) {
    return {
      id: 'obd_codes',
      title: 'OBD diagnostic codes',
      status: 'insufficient_data',
      score: null,
      explanation: 'No OBD diagnostic codes were present in contract/manual evidence.',
      evidence: withEvidence([{ label: 'obd_codes_available', value: false }]),
      sourceType: 'documents',
      providerStatus: 'available'
    }
  }

  return {
    id: 'obd_codes',
    title: 'OBD diagnostic codes',
    status: 'scored',
    score: 58,
    explanation: 'OBD diagnostic codes are present and can inform adjudication context.',
    evidence: withEvidence([
      { label: 'obd_codes_count', value: codes.length },
      { label: 'obd_codes', value: codes.slice(0, 8).join(', ') }
    ]),
    sourceType: 'documents',
    providerStatus: 'available'
  }
}

function scoreWarrantySupport(vinDataResult: unknown): AdjudicationQuestionResult {
  const contract = getDocumentContract(vinDataResult)

  const supportedFields: Array<[string, unknown]> = [
    ['agreement_number', contract.agreementNumber],
    ['coverage_level', contract.coverageLevel],
    ['plan_name', contract.planName],
    ['coverage_summary', contract.warrantyCoverageSummary],
    ['deductible', contract.deductible],
    ['term_months', contract.termMonths],
    ['term_miles', contract.termMiles]
  ]

  const presentEvidence: AdjudicationEvidenceEntry[] = []
  for (const [label, value] of supportedFields) {
    if (typeof value === 'string' && value.trim().length > 0) {
      presentEvidence.push({ label, value: value.trim() })
      continue
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      presentEvidence.push({ label, value })
    }
  }

  if (presentEvidence.length === 0) {
    return {
      id: 'warranty_support',
      title: 'Warranty support evidence',
      status: 'insufficient_data',
      score: null,
      explanation: 'No contract warranty-support fields were present for adjudication.',
      evidence: withEvidence([{ label: 'warranty_fields_present', value: 0 }]),
      sourceType: 'documents',
      providerStatus: 'available'
    }
  }

  const score = presentEvidence.length >= 5 ? 74 : presentEvidence.length >= 3 ? 66 : 58

  return {
    id: 'warranty_support',
    title: 'Warranty support evidence',
    status: 'scored',
    score,
    explanation:
      presentEvidence.length >= 5
        ? 'Strong contract warranty evidence is present for adjudication support.'
        : presentEvidence.length >= 3
          ? 'Moderate contract warranty evidence is present for adjudication support.'
          : 'Limited contract warranty evidence is present for adjudication support.',
    evidence: withEvidence([
      { label: 'warranty_fields_present', value: presentEvidence.length },
      ...presentEvidence.slice(0, 8)
    ]),
    sourceType: 'documents',
    providerStatus: 'available'
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

  if (isStubOrNotConfigured(serviceHistory)) {
    return {
      id: 'maintenance_history',
      title: 'Maintenance history consistency',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Service history provider is not configured; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'service_history_source', value: serviceHistory.source as string | null }]),
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  if (isProviderError(serviceHistory)) {
    return {
      id: 'maintenance_history',
      title: 'Maintenance history consistency',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Service history provider returned an error; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'service_history_message', value: serviceHistory.message as string | null }]),
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

  if (isStubOrNotConfigured(titleHistory)) {
    return {
      id: 'branded_title',
      title: 'Branded title risk',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Title history provider is not configured; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'title_history_source', value: titleHistory.source as string | null }]),
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  if (isProviderError(titleHistory)) {
    return {
      id: 'branded_title',
      title: 'Branded title risk',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Title history provider returned an error; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'title_history_message', value: titleHistory.message as string | null }]),
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

  if (isStubOrNotConfigured(valuation)) {
    return {
      id: 'valuation_context',
      title: 'Valuation context',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Valuation provider is not configured; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'valuation_source', value: valuation.source as string | null }]),
      sourceType: 'provider',
      providerStatus: 'unavailable'
    }
  }

  if (isProviderError(valuation)) {
    return {
      id: 'valuation_context',
      title: 'Valuation context',
      status: 'provider_unavailable',
      score: null,
      explanation: 'Valuation provider returned an error; deterministic scoring skipped.',
      evidence: withEvidence([{ label: 'valuation_message', value: valuation.message as string | null }]),
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
    miles_since_purchase: scoreMilesSincePurchase(input),
    days_since_purchase: scoreDaysSincePurchase(input),
    obd_codes: scoreObdCodes(input.vinDataResult),
    warranty_support: scoreWarrantySupport(input.vinDataResult),
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

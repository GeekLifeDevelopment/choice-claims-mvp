import type { DecisionRecommendation } from './adjudication-recommendation'

function toSentenceFragment(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

function joinReasons(reasons: string[]): string {
  if (reasons.length === 0) {
    return ''
  }

  if (reasons.length === 1) {
    return toSentenceFragment(reasons[0])
  }

  if (reasons.length === 2) {
    return `${toSentenceFragment(reasons[0])} and ${toSentenceFragment(reasons[1])}`
  }

  return `${toSentenceFragment(reasons[0])}, ${toSentenceFragment(reasons[1])}, and ${toSentenceFragment(reasons[2])}`
}

export function buildDecisionExplanation(input: {
  recommendation: DecisionRecommendation
  reasons: string[]
  overallCompleteness: number
  overallConfidence: number
}): string {
  const keyReasons = input.reasons.slice(0, 3)
  const reasonsText = joinReasons(keyReasons)
  const hasSparseSignalsReason = input.reasons.some((reason) => /too few reliable scored questions/i.test(reason))
  const hasNoResultReason = input.reasons.some((reason) => /no-result/i.test(reason))
  const hasProviderGapReason = input.reasons.some((reason) => /provider gap|missing providers/i.test(reason))

  if (input.recommendation === 'manual_review') {
    if (hasSparseSignalsReason || input.overallCompleteness < 0.45) {
      return 'Manual review recommended because adjudication evidence is too sparse for a trustworthy automated decision.'
    }

    if (hasProviderGapReason || hasNoResultReason) {
      return 'Manual review recommended because provider coverage is incomplete and available evidence is not sufficient for a confident decision.'
    }

    if (reasonsText) {
      return `Manual review recommended due to ${reasonsText}.`
    }

    return 'Manual review recommended due to limited adjudication certainty.'
  }

  if (input.recommendation === 'approve') {
    if (reasonsText) {
      return `Approval recommended with supporting signals: ${reasonsText}.`
    }

    return 'Approval recommended based on strong adjudication signals.'
  }

  if (input.recommendation === 'partial') {
    if (hasProviderGapReason || hasNoResultReason) {
      return 'Partial approval recommended with caution because only part of the expected provider evidence is available.'
    }

    if (reasonsText) {
      return `Partial approval recommended due to mixed evidence: ${reasonsText}.`
    }

    return 'Partial approval recommended due to mixed adjudication signals.'
  }

  if (reasonsText) {
    return `Denial recommended due to ${reasonsText}.`
  }

  if (input.overallConfidence < 0.4 || input.overallCompleteness < 0.4) {
    return 'Denial recommended with low confidence and incomplete adjudication inputs.'
  }

  return 'Denial recommended based on adjudication score and supporting evidence.'
}

export type DecisionRecommendation = 'approve' | 'deny' | 'partial' | 'manual_review'

type QuestionForDecision = {
  status: 'scored' | 'insufficient_data' | 'not_applicable' | 'provider_unavailable'
  providerStatus?: string
  missing?: string[]
}

type RecommendationInput = {
  totalScore: number
  overallCompleteness: number
  overallConfidence: number
  questions: QuestionForDecision[]
}

function hasRequiredProviderGap(questions: QuestionForDecision[]): boolean {
  return questions.some((question) => {
    const providerStatus = question.providerStatus ?? ''
    return providerStatus === 'not_configured' || providerStatus === 'error'
  })
}

export function calculateRecommendation(input: RecommendationInput): DecisionRecommendation {
  const scoredCount = input.questions.filter((question) => question.status === 'scored').length
  if (scoredCount === 0) {
    return 'manual_review'
  }

  if (input.overallCompleteness < 0.4) {
    return 'manual_review'
  }

  if (input.overallConfidence < 0.4) {
    return 'manual_review'
  }

  if (hasRequiredProviderGap(input.questions) && input.totalScore >= 75) {
    return 'manual_review'
  }

  if (input.totalScore >= 75 && input.overallCompleteness >= 0.6) {
    return 'approve'
  }

  if (input.totalScore >= 55) {
    return 'manual_review'
  }

  if (input.totalScore >= 40) {
    return 'partial'
  }

  return 'deny'
}

export function buildOverrideSuggestion(input: {
  recommendation: DecisionRecommendation
  overallCompleteness: number
  overallConfidence: number
  questions: QuestionForDecision[]
}): string {
  const hasTitleProviderGap = input.questions.some(
    (question) =>
      question.providerStatus !== 'ok' &&
      question.providerStatus !== 'available' &&
      Array.isArray(question.missing) &&
      question.missing.some((item) => item.includes('titleHistory'))
  )

  if (hasTitleProviderGap) {
    return 'Do not approve without title history.'
  }

  if (input.overallConfidence < 0.4 || input.overallCompleteness < 0.4) {
    return 'Requires manual inspection.'
  }

  if (input.recommendation === 'approve' && input.overallConfidence >= 0.7) {
    return 'Safe to approve if documentation verified.'
  }

  if (input.recommendation === 'partial') {
    return 'Low confidence decision; verify missing evidence before final approval.'
  }

  return 'Low confidence decision.'
}

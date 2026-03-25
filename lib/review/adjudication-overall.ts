type QuestionForOverall = {
  status: 'scored' | 'insufficient_data' | 'not_applicable' | 'provider_unavailable'
  providerStatus?: string
  completeness?: number
  confidence?: number
}

type OverallInput = {
  questions: QuestionForOverall[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function getUnavailableProviderRatio(questions: QuestionForOverall[]): number {
  if (questions.length === 0) {
    return 1
  }

  const unavailableCount = questions.filter((question) => {
    if (question.status === 'provider_unavailable') {
      return true
    }

    const providerStatus = question.providerStatus ?? ''
    return (
      providerStatus === 'not_configured' ||
      providerStatus === 'error' ||
      providerStatus === 'no_result' ||
      providerStatus === 'unavailable'
    )
  }).length

  return unavailableCount / questions.length
}

export function calculateOverallCompleteness(input: OverallInput): number {
  if (input.questions.length === 0) {
    return 0
  }

  const averageCompleteness =
    input.questions.reduce((sum, question) => sum + clamp(question.completeness ?? 0, 0, 1), 0) /
    input.questions.length

  const unavailableRatio = getUnavailableProviderRatio(input.questions)
  const providerPenalty = unavailableRatio * 0.18
  let adjusted = averageCompleteness - providerPenalty

  const scoredCount = input.questions.filter((question) => question.status === 'scored').length
  if (scoredCount >= 3 && averageCompleteness >= 0.4) {
    adjusted = Math.max(adjusted, 0.3)
  }

  return round(clamp(adjusted, 0, 1))
}

export function calculateOverallConfidence(input: OverallInput & { overallCompleteness: number }): number {
  if (input.questions.length === 0) {
    return 0
  }

  const averageConfidence =
    input.questions.reduce((sum, question) => sum + clamp(question.confidence ?? 0, 0, 1), 0) /
    input.questions.length

  const unavailableRatio = getUnavailableProviderRatio(input.questions)
  const completenessFactor = 0.7 + clamp(input.overallCompleteness, 0, 1) * 0.3
  const providerFactor = 1 - unavailableRatio * 0.25
  let adjusted = averageConfidence * completenessFactor * providerFactor

  const scoredCount = input.questions.filter((question) => question.status === 'scored').length
  if (scoredCount >= 3 && input.overallCompleteness >= 0.35) {
    adjusted = Math.max(adjusted, 0.25)
  }

  return round(clamp(adjusted, 0, 1))
}

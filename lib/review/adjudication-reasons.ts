type QuestionForReasons = {
  id: string
  status: 'scored' | 'insufficient_data' | 'not_applicable' | 'provider_unavailable'
  score: number | null
  sourceType: 'provider' | 'claim' | 'documents' | 'system'
  providerStatus?: string
  explanation: string
  missing?: string[]
}

type ReasonInput = {
  questions: QuestionForReasons[]
  overallCompleteness: number
  overallConfidence: number
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)))
}

export function buildDecisionReasons(input: ReasonInput): string[] {
  const reasons: string[] = []

  for (const question of input.questions) {
    if (question.id === 'branded_title' && question.score !== null && question.score <= 40) {
      reasons.push('Multiple branded title flags')
    }

    if (question.id === 'maintenance_history' && question.score !== null && question.score <= 55) {
      reasons.push('Low service history')
    }

    if (question.id === 'recall_relevance' && question.score !== null && question.score <= 35) {
      reasons.push('Recall count high')
    }

    if (
      question.id === 'branded_title' &&
      (question.providerStatus === 'not_configured' ||
        question.providerStatus === 'error' ||
        question.providerStatus === 'no_result' ||
        question.status === 'provider_unavailable')
    ) {
      reasons.push('Missing title history provider')
    }

    if (
      (question.id === 'document_match' || question.id === 'image_modifications') &&
      Array.isArray(question.missing) &&
      question.missing.some((value) => value === 'claim.attachments')
    ) {
      reasons.push('Attachments incomplete')
    }

    if (
      question.id === 'document_match' &&
      /mismatch|does not match|conflict/i.test(question.explanation)
    ) {
      reasons.push('AI detected document mismatch')
    }

    if (
      question.id === 'image_modifications' &&
      /modified|edited|tamper|forensic/i.test(question.explanation)
    ) {
      reasons.push('AI detected image modification risk')
    }
  }

  const missingProviderCount = input.questions.filter((question) => {
    const providerStatus = question.providerStatus ?? ''
    return (
      question.status === 'provider_unavailable' ||
      providerStatus === 'not_configured' ||
      providerStatus === 'error' ||
      providerStatus === 'no_result'
    )
  }).length

  if (missingProviderCount >= 2 || input.overallConfidence < 0.4) {
    reasons.push('Low confidence due to missing providers')
  }

  if (input.overallCompleteness < 0.4) {
    reasons.push('Decision completeness is low due to missing adjudication data')
  }

  return unique(reasons)
}

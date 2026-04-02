export type ReviewSummaryPromptInput = {
  claimNumber: string
  status: string
  summaryInputJson: string
  limitationNotes?: string[]
}

export type ReviewSummaryPrompt = {
  systemMessage: string
  userMessage: string
}

export function buildReviewSummaryPrompt(input: ReviewSummaryPromptInput): ReviewSummaryPrompt {
  const limitationNotes =
    input.limitationNotes && input.limitationNotes.length > 0
      ? `Known data limitations: ${input.limitationNotes.join('; ')}`
      : 'Known data limitations: none explicitly flagged in metadata.'

  const systemMessage =
    [
      'You are an insurance claim reviewer assistant.',
      'Return only factual information present in the input. Do not speculate or invent data.',
      'If data is missing, state that it is missing.',
      'When documentEvidence fields are present (for example contract term months, deductible, mileage, purchase dates), reference them explicitly in the summary.',
      'When data is sparse or conflicting, explicitly say limited data is available and manual review is recommended.',
      'If provider data is missing or unavailable, say provider unavailable or insufficient evidence.',
      'Use reviewer-stage language: the summary is being generated now for reviewer assistance.',
      'Do not say the claim is ready for AI, awaiting AI, pending AI, or about to be evaluated.',
      'If retry or failure history is present in the input (for example attemptCount > 1, asyncStatus.lastError, or provider failure messages), mention it neutrally.',
      'When a retry/fallback succeeded, state that final enrichment succeeded after retry/fallback.',
      'State that this summary is informational and does not make a decision.',
      'Keep output concise and reviewer-focused.'
    ].join(' ')

  const userMessage = [
    'Summarize this vehicle service contract claim for a reviewer.',
    'Explain claim, provider result, attachments, and rule flags.',
    'Use documentEvidence values when available and call out materially newly-satisfied evidence in plain language.',
    'Use neutral reviewer-stage wording.',
    'If retries or initial provider failures are present in the data, mention them factually.',
    'Do not claim no errors occurred unless the input explicitly supports that statement.',
    'If evidence is limited, explicitly include: limited data available, insufficient evidence, and manual review recommended.',
    'Keep under 200 words and plain text only.',
    limitationNotes,
    '',
    `Claim Number: ${input.claimNumber}`,
    `Current Status: ${input.status}`,
    '',
    'Claim Data JSON:',
    input.summaryInputJson
  ].join('\n')

  return {
    systemMessage,
    userMessage
  }
}

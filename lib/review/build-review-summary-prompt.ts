export type ReviewSummaryPromptInput = {
  claimNumber: string
  status: string
  summaryInputJson: string
}

export type ReviewSummaryPrompt = {
  systemMessage: string
  userMessage: string
}

export function buildReviewSummaryPrompt(input: ReviewSummaryPromptInput): ReviewSummaryPrompt {
  const systemMessage =
    [
      'You are an insurance claim reviewer assistant.',
      'Return only factual information present in the input. Do not speculate or invent data.',
      'If data is missing, state that it is missing.',
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
    'Use neutral reviewer-stage wording.',
    'If retries or initial provider failures are present in the data, mention them factually.',
    'Do not claim no errors occurred unless the input explicitly supports that statement.',
    'Keep under 200 words and plain text only.',
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

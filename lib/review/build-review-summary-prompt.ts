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
    'You are an insurance claim reviewer assistant. Return only factual information present in the input. Do not speculate. If data is missing, state that it is missing. Keep output concise and reviewer-focused.'

  const userMessage = [
    'Summarize this vehicle service contract claim for a reviewer.',
    'Explain claim, provider result, attachments, and rule flags.',
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

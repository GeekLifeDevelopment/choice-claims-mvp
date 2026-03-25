import { ADJUDICATION_AI_SUPPORTED_QUESTION_IDS } from './adjudication-ai-contract'

export type AdjudicationAiPromptInput = {
  claimNumber: string
  status: string
  summaryInputJson: string
}

export type AdjudicationAiPrompt = {
  systemMessage: string
  userMessage: string
}

export function buildAdjudicationAiPrompt(input: AdjudicationAiPromptInput): AdjudicationAiPrompt {
  const systemMessage = [
    'You extract structured adjudication findings for selected questions.',
    'Return JSON only with an object containing a findings array.',
    'Do not include markdown, prose, or code fences.',
    'Use only facts present in the supplied JSON.',
    'If evidence is missing, use status insufficient_data or provider_unavailable.',
    'Do not invent document contents or OCR results.'
  ].join(' ')

  const userMessage = [
    'Return this JSON shape exactly:',
    '{"findings":[{"questionId":"...","status":"...","scoreSuggestion":50,"explanation":"...","evidence":[{"label":"...","value":"..."}],"confidence":0.5,"sourceType":"documents"}]}',
    '',
    `Allowed questionId values: ${ADJUDICATION_AI_SUPPORTED_QUESTION_IDS.join(', ')}`,
    'Allowed status values: scored, insufficient_data, not_applicable, provider_unavailable',
    'Allowed sourceType values: provider, claim, documents, system',
    'confidence must be between 0 and 1 when provided.',
    'scoreSuggestion must be between 0 and 100 when provided.',
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

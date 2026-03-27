import type { ProviderStatus } from './provider-status'

type QuestionStatus =
  | 'scored'
  | 'insufficient_data'
  | 'provider_unavailable'
  | 'not_applicable'

type ConfidenceInput = {
  status: QuestionStatus
  providerStatus: ProviderStatus
  completeness: number
  aiConfidence?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function calculateQuestionConfidence(input: ConfidenceInput): number {
  let confidence = clamp(input.completeness, 0, 1)

  if (input.providerStatus === 'not_configured' || input.providerStatus === 'error') {
    confidence *= 0.6
  }

  if (input.providerStatus === 'no_result') {
    confidence *= 0.72
  }

  if (typeof input.aiConfidence === 'number' && Number.isFinite(input.aiConfidence)) {
    confidence = confidence * 0.6 + clamp(input.aiConfidence, 0, 1) * 0.4
  }

  if (input.status === 'insufficient_data' || input.status === 'provider_unavailable') {
    confidence = Math.min(confidence, 0.55)
  }

  if (input.status === 'not_applicable') {
    confidence = Math.min(Math.max(confidence, 0.3), 0.45)
  }

  return round(clamp(confidence, 0, 1))
}

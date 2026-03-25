import type { ProviderStatus } from './provider-status'

type CompletenessInput = {
  providerStatus: ProviderStatus
  evidence: string[]
  missing: string[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function calculateQuestionCompleteness(input: CompletenessInput): number {
  const evidenceCount = input.evidence.length
  const missingCount = input.missing.length
  const denominator = evidenceCount + missingCount

  let completeness = denominator > 0 ? evidenceCount / denominator : 0

  if (input.providerStatus === 'not_configured' || input.providerStatus === 'error') {
    completeness = Math.min(completeness, 0.2)
  }

  if (input.providerStatus === 'no_result') {
    completeness = Math.min(completeness, 0.5)
  }

  return round(clamp(completeness, 0, 1))
}

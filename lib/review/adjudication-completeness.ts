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

  if (evidenceCount > 0 && completeness < 0.25) {
    completeness = 0.25
  }

  if (input.providerStatus === 'not_configured' || input.providerStatus === 'error') {
    completeness = Math.min(completeness, 0.35)
  }

  if (input.providerStatus === 'no_result') {
    completeness = Math.min(completeness, 0.65)
  }

  return round(clamp(completeness, 0, 1))
}

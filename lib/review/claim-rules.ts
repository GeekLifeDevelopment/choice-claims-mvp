import type { ClaimEvaluationInput } from './claim-evaluation-input'

export type ClaimRuleFlag = {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export type ClaimRuleResult = {
  flags: ClaimRuleFlag[]
}

const HIGH_EVENT_COUNT_THRESHOLD = 5

function pushFlag(
  flags: ClaimRuleFlag[],
  code: string,
  severity: ClaimRuleFlag['severity'],
  message: string
): void {
  flags.push({ code, severity, message })
}

function hasProviderData(snapshot: ClaimEvaluationInput['snapshot']): boolean {
  const provider = snapshot.provider

  if (!provider) {
    return false
  }

  if (provider.providerName || provider.fetchedAt) {
    return true
  }

  if (typeof provider.eventCount === 'number' && Number.isFinite(provider.eventCount)) {
    return true
  }

  return Boolean(provider.enrichmentSummary)
}

function isTruthySignal(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value > 0
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === 'present' || normalized === 'found'
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.present === 'boolean') {
      return record.present
    }
    if (typeof record.found === 'boolean') {
      return record.found
    }
    if (typeof record.hasIssue === 'boolean') {
      return record.hasIssue
    }
    if (typeof record.count === 'number') {
      return record.count > 0
    }
  }

  return false
}

// Usage example for the next pipeline ticket:
// const input = await getClaimEvaluationInput(id)
// const result = runClaimRules(input)
// result.flags
export function runClaimRules(input: ClaimEvaluationInput): ClaimRuleResult {
  const flags: ClaimRuleFlag[] = []
  const snapshot = input.snapshot
  const enrichment = snapshot.provider?.enrichmentSummary

  if (!input.readiness.isReadyForAI) {
    pushFlag(flags, 'claim_not_ready_for_ai', 'warning', 'Claim is not in ReadyForAI status yet.')
  }

  if (!snapshot.vehicle?.vin) {
    pushFlag(flags, 'missing_vin', 'error', 'VIN is missing from the claim snapshot.')
  }

  if (!hasProviderData(snapshot)) {
    pushFlag(flags, 'provider_data_missing', 'warning', 'No provider data is available for this claim.')
  }

  if (snapshot.status === 'ProviderFailed') {
    pushFlag(flags, 'provider_failed', 'error', 'VIN provider lookup failed for this claim.')
  }

  const attachmentCount = snapshot.attachments?.count ?? 0
  if (attachmentCount === 0) {
    pushFlag(flags, 'no_attachments', 'warning', 'Claim has no attachments.')
  }

  if (snapshot.attachments?.hasPhotos === false) {
    pushFlag(flags, 'no_photos', 'info', 'Claim has no photo attachments.')
  }

  if (isTruthySignal(enrichment?.titleProblem)) {
    pushFlag(flags, 'title_problem_present', 'error', 'Provider enrichment indicates a possible title problem.')
  }

  if (isTruthySignal(enrichment?.accident)) {
    pushFlag(flags, 'accident_present', 'warning', 'Provider enrichment indicates accident history.')
  }

  if (isTruthySignal(enrichment?.recall)) {
    pushFlag(flags, 'recall_present', 'warning', 'Provider enrichment indicates recall history.')
  }

  const eventCount = snapshot.provider?.eventCount
  if (typeof eventCount === 'number' && Number.isFinite(eventCount) && eventCount > HIGH_EVENT_COUNT_THRESHOLD) {
    pushFlag(
      flags,
      'high_event_count',
      'warning',
      `Provider reported high event count (${eventCount}, threshold ${HIGH_EVENT_COUNT_THRESHOLD}).`
    )
  }

  return { flags }
}

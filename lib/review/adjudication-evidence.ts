import type { ProviderStatus } from './provider-status'

type EvidenceContext = {
  questionId: string
  existingEvidence: EvidenceEntry[]
  providerStatus: ProviderStatus
  vinDataResult: Record<string, unknown>
  claimSnapshot: Record<string, unknown>
  hasAiFinding: boolean
}

type EvidenceEntry = {
  label: string
  value: string | number | boolean | null
}

type EvidenceMapping = {
  evidence: EvidenceEntry[]
  missing: string[]
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)))
}

function uniqueEvidence(entries: EvidenceEntry[]): EvidenceEntry[] {
  const byLabel = new Map<string, EvidenceEntry>()
  for (const entry of entries) {
    if (!entry.label || entry.label.trim().length === 0) {
      continue
    }

    byLabel.set(entry.label, entry)
  }

  return Array.from(byLabel.values())
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getSubmission(claimSnapshot: Record<string, unknown>): Record<string, unknown> {
  return asRecord(claimSnapshot.submission)
}

function hasAttachments(claimSnapshot: Record<string, unknown>): boolean {
  const attachments = asRecord(claimSnapshot.attachments)
  const count = attachments.count
  if (typeof count === 'number' && Number.isFinite(count)) {
    return count > 0
  }

  const rawList = attachments.raw
  return Array.isArray(rawList) && rawList.length > 0
}

function hasKnownNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

export function buildQuestionEvidenceAndMissing(context: EvidenceContext): EvidenceMapping {
  const evidence = [...context.existingEvidence]
  const missing: string[] = []

  const pushEvidence = (label: string, value: string | number | boolean | null = true) => {
    evidence.push({ label, value })
  }

  if (context.providerStatus === 'not_configured') {
    missing.push('provider_not_configured')
  }

  if (context.providerStatus === 'error') {
    missing.push('provider_error')
  }

  if (context.providerStatus === 'no_result') {
    missing.push('provider_no_result')
  }

  const submission = getSubmission(context.claimSnapshot)
  const titleHistory = asRecord(context.vinDataResult.titleHistory)
  const serviceHistory = asRecord(context.vinDataResult.serviceHistory)
  const recalls = asRecord(context.vinDataResult.nhtsaRecalls)
  const valuation = asRecord(context.vinDataResult.valuation)

  if (context.questionId === 'miles_since_purchase') {
    if (hasKnownNumber(submission.mileage)) {
      pushEvidence('submission.mileage', Number(submission.mileage))
    } else {
      missing.push('submission.mileage')
    }

    if (hasKnownNumber(submission.purchaseMileage)) {
      pushEvidence('submission.purchaseMileage', Number(submission.purchaseMileage))
    } else {
      missing.push('submission.purchaseMileage')
    }
  }

  if (context.questionId === 'days_since_purchase') {
    if (typeof submission.purchaseDate === 'string' && submission.purchaseDate.trim().length > 0) {
      pushEvidence('submission.purchaseDate', submission.purchaseDate)
    } else {
      missing.push('submission.purchaseDate')
    }
  }

  if (context.questionId === 'document_match') {
    if (hasAttachments(context.claimSnapshot)) {
      pushEvidence('claim.attachments', true)
    } else {
      missing.push('claim.attachments')
    }

    if (context.hasAiFinding) {
      pushEvidence('ai.findings.document_match', true)
    } else {
      missing.push('ai.findings.document_match')
    }
  }

  if (context.questionId === 'image_modifications') {
    if (hasAttachments(context.claimSnapshot)) {
      pushEvidence('claim.attachments', true)
    } else {
      missing.push('claim.attachments')
    }

    if (context.hasAiFinding) {
      pushEvidence('ai.findings.image_modifications', true)
    } else {
      missing.push('ai.findings.image_modifications')
    }
  }

  if (context.questionId === 'obd_codes') {
    pushEvidence('rule.placeholder', true)
    missing.push('vehicle.obdCodes')
  }

  if (context.questionId === 'prior_repairs' || context.questionId === 'maintenance_history') {
    const eventCount = typeof serviceHistory.eventCount === 'number' ? serviceHistory.eventCount : null
    if (eventCount !== null) {
      pushEvidence('serviceHistory.eventCount', eventCount)
    } else {
      missing.push('serviceHistory.eventCount')
    }
  }

  if (context.questionId === 'warranty_support') {
    pushEvidence('rule.placeholder', true)
    missing.push('warranty.coverageData')
  }

  if (context.questionId === 'branded_title') {
    const brandFlags = Array.isArray(titleHistory.brandFlags) ? titleHistory.brandFlags.length : null
    if (brandFlags !== null) {
      pushEvidence('titleHistory.brandFlags', brandFlags)
    } else {
      missing.push('titleHistory.brandFlags')
    }
  }

  if (context.questionId === 'recall_relevance') {
    if (hasKnownNumber(recalls.count)) {
      pushEvidence('nhtsaRecalls.count', Number(recalls.count))
    } else {
      missing.push('nhtsaRecalls.count')
    }
  }

  if (context.questionId === 'valuation_context') {
    if (hasKnownNumber(valuation.estimatedValue) || hasKnownNumber(valuation.retailValue)) {
      const value = hasKnownNumber(valuation.estimatedValue)
        ? Number(valuation.estimatedValue)
        : Number(valuation.retailValue)
      pushEvidence('valuation.estimatedValue', value)
    } else {
      missing.push('valuation.estimatedValue')
    }
  }

  return {
    evidence: uniqueEvidence(evidence),
    missing: unique(missing),
  }
}

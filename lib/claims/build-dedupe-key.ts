import { createHash } from 'crypto'
import type { CreateClaimFromIntakeInput } from '../domain/claims'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord
  }

  return undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return undefined
}

function extractCognitoIdentifiers(rawSubmissionPayload: unknown) {
  const topLevel = asRecord(rawSubmissionPayload)
  const entry = asRecord(topLevel?.Entry)

  return {
    cognitoId: asString(topLevel?.Id),
    entryNumber: asString(entry?.Number),
    entryDateSubmitted: asString(entry?.DateSubmitted)
  }
}

export function buildDedupeKey(input: CreateClaimFromIntakeInput): string {
  const identifiers = extractCognitoIdentifiers(input.rawSubmissionPayload)

  const attachmentSummary = input.attachments
    .map((attachment) => `${attachment.filename}|${attachment.externalId || ''}`)
    .sort()

  const canonicalObject = {
    source: input.source,
    submittedAt: input.submittedAt.toISOString(),
    vin: input.vin || '',
    claimantName: input.claimantName || '',
    claimantEmail: input.claimantEmail || '',
    claimantPhone: input.claimantPhone || '',
    attachmentSummary,
    identifiers
  }

  const payload = JSON.stringify(canonicalObject)

  return createHash('sha256').update(payload).digest('hex')
}

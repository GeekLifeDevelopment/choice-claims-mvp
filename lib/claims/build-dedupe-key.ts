import { createHash } from 'crypto'
import type { CreateClaimFromIntakeInput } from '../domain/claims'

type UnknownRecord = Record<string, unknown>

export type DedupeSource =
  | 'entry_number'
  | 'cognito_submission_id'
  | 'entry_date_submitted'
  | 'fallback_canonical_hash'

export type DedupeKeyDetails = {
  dedupeKey: string
  dedupeSource: DedupeSource
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord
  }

  return undefined
}

function asIdentifierString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  return undefined
}

function extractCognitoIdentifiers(rawSubmissionPayload: unknown) {
  const topLevel = asRecord(rawSubmissionPayload)
  const entry = asRecord(topLevel?.Entry)

  return {
    cognitoId: asIdentifierString(topLevel?.Id),
    entryNumber: asIdentifierString(entry?.Number),
    entryDateSubmitted: asIdentifierString(entry?.DateSubmitted)
  }
}

function hashObject(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function buildCanonicalFallbackObject(input: CreateClaimFromIntakeInput) {
  const attachmentSummary = input.attachments
    .map((attachment) => `${attachment.filename}|${attachment.externalId || ''}`)
    .sort()

  return {
    source: input.source,
    submittedAt: input.submittedAt.toISOString(),
    vin: input.vin || '',
    claimantName: input.claimantName || '',
    claimantEmail: input.claimantEmail || '',
    claimantPhone: input.claimantPhone || '',
    attachmentSummary
  }
}

function buildIdentifierDedupeKey(input: {
  source: string
  dedupeSource: Exclude<DedupeSource, 'fallback_canonical_hash'>
  identifierValue: string
}): string {
  return hashObject({
    source: input.source,
    dedupeSource: input.dedupeSource,
    identifierValue: input.identifierValue
  })
}

export function buildDedupeKeyDetails(input: CreateClaimFromIntakeInput): DedupeKeyDetails {
  if (input.source.toLowerCase() === 'cognito') {
    const identifiers = extractCognitoIdentifiers(input.rawSubmissionPayload)

    if (identifiers.entryNumber) {
      return {
        dedupeKey: buildIdentifierDedupeKey({
          source: input.source,
          dedupeSource: 'entry_number',
          identifierValue: identifiers.entryNumber
        }),
        dedupeSource: 'entry_number'
      }
    }

    if (identifiers.cognitoId) {
      return {
        dedupeKey: buildIdentifierDedupeKey({
          source: input.source,
          dedupeSource: 'cognito_submission_id',
          identifierValue: identifiers.cognitoId
        }),
        dedupeSource: 'cognito_submission_id'
      }
    }

    if (identifiers.entryDateSubmitted) {
      return {
        dedupeKey: buildIdentifierDedupeKey({
          source: input.source,
          dedupeSource: 'entry_date_submitted',
          identifierValue: identifiers.entryDateSubmitted
        }),
        dedupeSource: 'entry_date_submitted'
      }
    }
  }

  return {
    dedupeKey: hashObject(buildCanonicalFallbackObject(input)),
    dedupeSource: 'fallback_canonical_hash'
  }
}

export function buildDedupeKey(input: CreateClaimFromIntakeInput): string {
  return buildDedupeKeyDetails(input).dedupeKey
}

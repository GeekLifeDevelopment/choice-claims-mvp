import type { NormalizedIntakePayload } from '../domain/claims'
import { extractCognitoAttachments } from './extract-cognito-attachments'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function getNestedObjects(input: unknown): UnknownRecord[] {
  const queue: unknown[] = [input]
  const visited = new Set<unknown>()
  const nested: UnknownRecord[] = []
  const maxNodes = 1000

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift()

    if (!current || visited.has(current)) {
      continue
    }

    visited.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    if (!isRecord(current)) {
      continue
    }

    nested.push(current)
    queue.push(...Object.values(current))
  }

  return nested
}

function findFirstString(raw: unknown, candidateKeys: string[]): string | undefined {
  const keySet = new Set(candidateKeys.map((key) => normalizeKey(key)))

  for (const record of getNestedObjects(raw)) {
    for (const [key, value] of Object.entries(record)) {
      if (!keySet.has(normalizeKey(key))) {
        continue
      }

      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
  }

  for (const record of getNestedObjects(raw)) {
    const label = record.label
    const value = record.value

    if (typeof label !== 'string' || !value) {
      continue
    }

    if (!keySet.has(normalizeKey(label))) {
      continue
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

function normalizeSubmittedAt(raw: unknown): string {
  const extracted = findFirstString(raw, [
    'submittedAt',
    'submitted_at',
    'submitted on',
    'submissionDate',
    'dateSubmitted',
    'createdAt',
    'timestamp'
  ])

  if (extracted && !Number.isNaN(Date.parse(extracted))) {
    return new Date(extracted).toISOString()
  }

  return new Date().toISOString()
}

export function normalizeCognitoPayload(rawPayload: unknown): NormalizedIntakePayload {
  const vin = findFirstString(rawPayload, ['full vin #', 'vin', 'full vin', 'vehicle vin'])
  const claimantName = findFirstString(rawPayload, [
    'customer name',
    'customerName',
    'name',
    'signed name',
    'signature name'
  ])
  const claimantEmail = findFirstString(rawPayload, ['customer email', 'customerEmail', 'email'])
  const claimantPhone = findFirstString(rawPayload, ['customer phone', 'customerPhone', 'phone', 'phone number'])
  const attachments = extractCognitoAttachments(rawPayload)

  return {
    source: 'cognito',
    submittedAt: normalizeSubmittedAt(rawPayload),
    vin,
    claimantName,
    claimantEmail,
    claimantPhone,
    attachments,
    rawSubmissionPayload: rawPayload
  }
}

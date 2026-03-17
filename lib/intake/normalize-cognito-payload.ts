import type { NormalizedIntakePayload } from '../domain/claims'
import { extractCognitoAttachments } from './extract-cognito-attachments'
import {
  asRecord,
  getCognitoEntryTimestamp,
  getCognitoNameValue,
  getCognitoTopLevelString
} from './cognito-field-helpers'

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
  const topLevel = asRecord(raw)
  const entryTimestamp = getCognitoEntryTimestamp(topLevel?.Entry)

  if (entryTimestamp) {
    return entryTimestamp
  }

  const extracted = findFirstString(raw, ['DateSubmitted', 'Timestamp', 'submittedAt', 'submitted_at'])

  if (extracted && !Number.isNaN(Date.parse(extracted))) {
    return new Date(extracted).toISOString()
  }

  return new Date().toISOString()
}

export function normalizeCognitoPayload(rawPayload: unknown): NormalizedIntakePayload {
  const topLevel = asRecord(rawPayload)

  const vin =
    getCognitoTopLevelString(rawPayload, 'FullVIN') ||
    getCognitoTopLevelString(rawPayload, 'VIN') ||
    findFirstString(rawPayload, ['FullVIN', 'VIN', 'vin'])

  const claimantName =
    getCognitoNameValue(topLevel?.CustomerName) ||
    findFirstString(rawPayload, ['CustomerName', 'customerName', 'name'])

  const claimantEmail =
    getCognitoTopLevelString(rawPayload, 'CustomerEmail') ||
    findFirstString(rawPayload, ['CustomerEmail', 'customerEmail', 'email'])

  const claimantPhone =
    getCognitoTopLevelString(rawPayload, 'CustomerPhone') ||
    findFirstString(rawPayload, ['CustomerPhone', 'customerPhone', 'phone'])

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

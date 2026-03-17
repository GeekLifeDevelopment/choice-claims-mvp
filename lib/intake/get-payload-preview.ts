import {
  asRecord,
  getCognitoEntryTimestamp,
  getCognitoNameValue,
  getCognitoTopLevelString
} from './cognito-field-helpers'
import { KNOWN_COGNITO_UPLOAD_FIELDS } from './extract-cognito-attachments'

type PayloadPreview = {
  topLevelKeys: string[]
  formName?: string
  entryId?: string
  entryNumber?: string
  submittedAt?: string
  vin?: string
  claimantName?: string
  claimantEmail?: string
  claimantPhone?: string
  attachmentFieldNamesDetected: string[]
  attachmentCountEstimate: number
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function findFirstString(raw: unknown, candidateKeys: string[]): string | undefined {
  const queue: unknown[] = [raw]
  const visited = new Set<unknown>()
  const normalizedCandidates = new Set(candidateKeys.map(normalizeKey))
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

    const record = asRecord(current)
    if (!record) {
      continue
    }

    for (const [key, value] of Object.entries(record)) {
      if (normalizedCandidates.has(normalizeKey(key)) && typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }

    queue.push(...Object.values(record))
  }

  return undefined
}

export function getPayloadPreview(rawPayload: unknown): PayloadPreview {
  const topLevel = asRecord(rawPayload)
  const topLevelKeys = topLevel ? Object.keys(topLevel).slice(0, 20) : []

  const attachmentFieldNamesDetected: string[] = []
  let attachmentCountEstimate = 0

  if (topLevel) {
    for (const fieldName of KNOWN_COGNITO_UPLOAD_FIELDS) {
      const value = topLevel[fieldName]
      if (!value) {
        continue
      }

      attachmentFieldNamesDetected.push(fieldName)
      if (Array.isArray(value)) {
        attachmentCountEstimate += value.length
      } else {
        attachmentCountEstimate += 1
      }
    }

    if (topLevel.Signature) {
      attachmentFieldNamesDetected.push('Signature')
      attachmentCountEstimate += Array.isArray(topLevel.Signature) ? topLevel.Signature.length : 1
    }
  }

  const entry = topLevel?.Entry
  const entryRecord = asRecord(entry)

  return {
    topLevelKeys,
    formName: getCognitoTopLevelString(rawPayload, 'Form'),
    entryId: getCognitoTopLevelString(rawPayload, 'Id') || getCognitoTopLevelString(rawPayload, 'EntryId'),
    entryNumber:
      (entryRecord && typeof entryRecord.Number === 'string' ? entryRecord.Number : undefined) ||
      getCognitoTopLevelString(rawPayload, 'EntryNumber'),
    submittedAt: getCognitoEntryTimestamp(entry),
    vin: getCognitoTopLevelString(rawPayload, 'FullVIN') || findFirstString(rawPayload, ['vin', 'full vin #']),
    claimantName: getCognitoNameValue(topLevel?.CustomerName),
    claimantEmail: getCognitoTopLevelString(rawPayload, 'CustomerEmail'),
    claimantPhone: getCognitoTopLevelString(rawPayload, 'CustomerPhone'),
    attachmentFieldNamesDetected,
    attachmentCountEstimate
  }
}

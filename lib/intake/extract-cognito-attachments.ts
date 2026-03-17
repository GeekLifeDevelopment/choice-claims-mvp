import type { IntakeAttachmentMetadata } from '../domain/claims'
import { asRecord } from './cognito-field-helpers'

type UnknownRecord = Record<string, unknown>

export const KNOWN_COGNITO_UPLOAD_FIELDS = [
  'CopyOfRepairOrder',
  'CopyOfRepairEstimate',
  'PhotosOfFailedParts',
  'DriverSideProfilePictureOfVehicle',
  'PictureUnderTheHood',
  'UnderCarriagePicture',
  'PictureOfOdometer',
  'RearProfilePictureOfVehicle'
] as const

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function normalizeKnownFileObject(value: unknown): IntakeAttachmentMetadata | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const filename = typeof record.Name === 'string' && record.Name.trim() ? record.Name.trim() : undefined
  if (!filename) {
    return null
  }

  const mimeType = typeof record.ContentType === 'string' ? record.ContentType : undefined
  const fileSize = toNumber(record.Size)
  const sourceUrl = typeof record.File === 'string' ? record.File : undefined
  const externalId = typeof record.Id === 'string' ? record.Id : undefined

  return {
    filename,
    mimeType,
    fileSize,
    sourceUrl,
    externalId
  }
}

function normalizeKnownFileFieldValue(value: unknown): IntakeAttachmentMetadata[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeKnownFileObject(item))
      .filter((item): item is IntakeAttachmentMetadata => item !== null)
  }

  const single = normalizeKnownFileObject(value)
  return single ? [single] : []
}

export function extractCognitoAttachments(rawPayload: unknown): IntakeAttachmentMetadata[] {
  const topLevel = asRecord(rawPayload)
  if (!topLevel) {
    return []
  }

  const results: IntakeAttachmentMetadata[] = []

  for (const fieldName of KNOWN_COGNITO_UPLOAD_FIELDS) {
    const fieldValue = topLevel[fieldName]
    results.push(...normalizeKnownFileFieldValue(fieldValue))
  }

  results.push(...normalizeKnownFileFieldValue(topLevel.Signature))

  const deduped = new Map<string, IntakeAttachmentMetadata>()

  for (const item of results) {
    const key = `${item.filename}|${item.sourceUrl || ''}|${item.storageKey || ''}`
    if (!deduped.has(key)) {
      deduped.set(key, item)
    }
  }

  return Array.from(deduped.values())
}

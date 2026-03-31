import type { IntakeAttachmentMetadata } from '../domain/claims'
import { asRecord } from './cognito-field-helpers'

type UnknownRecord = Record<string, unknown>

export const KNOWN_COGNITO_UPLOAD_FIELDS = [
  'CopyOfRepairOrder',
  'CopyOfRepairEstimate',
  'PhotosOfFailedParts',
  'DriverSideProfilePictureOfVehicle',
  'PassengerSideProfilePictureOfVehicle',
  'PictureUnderTheHood',
  'UnderCarriagePicture',
  'PictureOfOdometer',
  'FrontProfilePictureOfVehicle',
  'RearProfilePictureOfVehicle'
] as const

const COGNITO_UPLOAD_FIELD_LABELS: Record<string, string> = {
  CopyOfRepairOrder: 'Copy of Repair Order',
  CopyOfRepairEstimate: 'Copy of Repair Estimate',
  PhotosOfFailedParts: 'Photos of Failed Part/s',
  DriverSideProfilePictureOfVehicle: 'Photo of Driver Side of Vehicle',
  PassengerSideProfilePictureOfVehicle: 'Photo of Passenger Side Profile',
  PictureUnderTheHood: 'Photo Under the Hood',
  UnderCarriagePicture: 'Photo of Under Carriage',
  PictureOfOdometer: 'Photo of Odometer',
  FrontProfilePictureOfVehicle: 'Photo of Front of Vehicle',
  RearProfilePictureOfVehicle: 'Photo of Rear-end of Vehicle',
  Signature: 'Signature'
}

const COGNITO_UPLOAD_FIELD_LABEL_ALIASES: Record<string, string> = {
  copyofrepairorder: 'Copy of Repair Order',
  copyofrepairestimate: 'Copy of Repair Estimate',
  photosoffailedparts: 'Photos of Failed Part/s',
  photooffailedparts: 'Photos of Failed Part/s',
  photooffailedpartsrequired: 'Photos of Failed Part/s',
  driversideprofilepictureofvehicle: 'Photo of Driver Side of Vehicle',
  photoofdriversideofvehicle: 'Photo of Driver Side of Vehicle',
  photoofdriversidevehicle: 'Photo of Driver Side of Vehicle',
  passengersideprofilepictureofvehicle: 'Photo of Passenger Side Profile',
  photoofpassengersideprofile: 'Photo of Passenger Side Profile',
  photoofpassengersideofvehicle: 'Photo of Passenger Side Profile',
  pictureunderthehood: 'Photo Under the Hood',
  photounderthehood: 'Photo Under the Hood',
  undercarriagepicture: 'Photo of Under Carriage',
  photoofundercarriage: 'Photo of Under Carriage',
  pictureofodometer: 'Photo of Odometer',
  photoofodometer: 'Photo of Odometer',
  frontprofilepictureofvehicle: 'Photo of Front of Vehicle',
  photooffrontofvehicle: 'Photo of Front of Vehicle',
  rearprofilepictureofvehicle: 'Photo of Rear-end of Vehicle',
  photoofrearendofvehicle: 'Photo of Rear-end of Vehicle',
  signature: 'Signature'
}

function normalizeFieldKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function toTitleCaseLabel(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!spaced) {
    return ''
  }

  return spaced
    .split(' ')
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ')
}

function resolveCognitoAttachmentFieldLabel(fieldName: string | null | undefined): string | undefined {
  if (!fieldName) {
    return undefined
  }

  if (COGNITO_UPLOAD_FIELD_LABELS[fieldName]) {
    return COGNITO_UPLOAD_FIELD_LABELS[fieldName]
  }

  const byAlias = COGNITO_UPLOAD_FIELD_LABEL_ALIASES[normalizeFieldKey(fieldName)]
  if (byAlias) {
    return byAlias
  }

  return toTitleCaseLabel(fieldName) || undefined
}

export function getCognitoAttachmentFieldLabel(fieldName: string | null | undefined): string | undefined {
  return resolveCognitoAttachmentFieldLabel(fieldName)
}

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

function normalizeKnownFileObject(
  value: unknown,
  fieldName?: string,
  sourceFieldLabel?: string
): IntakeAttachmentMetadata | null {
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
  const storageKey =
    typeof record.StorageKey === 'string'
      ? record.StorageKey
      : typeof record.Key === 'string'
        ? record.Key
        : undefined

  return {
    filename,
    mimeType,
    fileSize,
    sourceUrl,
    externalId,
    storageKey,
    sourceFieldName: fieldName,
    sourceFieldLabel: sourceFieldLabel || getCognitoAttachmentFieldLabel(fieldName)
  }
}

function normalizeKnownFileFieldValue(
  value: unknown,
  fieldName?: string,
  sourceFieldLabel?: string
): IntakeAttachmentMetadata[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeKnownFileObject(item, fieldName, sourceFieldLabel))
      .filter((item): item is IntakeAttachmentMetadata => item !== null)
  }

  const asLabeledContainer = asRecord(value)
  if (asLabeledContainer && asLabeledContainer.value !== undefined) {
    const nestedLabel =
      typeof asLabeledContainer.label === 'string' && asLabeledContainer.label.trim().length > 0
        ? asLabeledContainer.label.trim()
        : sourceFieldLabel

    return normalizeKnownFileFieldValue(asLabeledContainer.value, fieldName, nestedLabel)
  }

  const single = normalizeKnownFileObject(value, fieldName, sourceFieldLabel)
  return single ? [single] : []
}

function collectNestedAttachmentCandidates(rawPayload: unknown): Array<{
  fieldName: string
  fieldValue: unknown
  sourceFieldLabel?: string
}> {
  const queue: unknown[] = [rawPayload]
  const seen = new Set<unknown>()
  const candidates: Array<{ fieldName: string; fieldValue: unknown; sourceFieldLabel?: string }> = []

  while (queue.length > 0 && seen.size < 1500) {
    const current = queue.shift()

    if (!current || seen.has(current)) {
      continue
    }

    seen.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    const record = asRecord(current)
    if (!record) {
      continue
    }

    const containerLabel =
      typeof record.label === 'string' && record.label.trim().length > 0 ? record.label.trim() : undefined

    for (const [fieldName, fieldValue] of Object.entries(record)) {
      if (fieldName === 'label' || fieldName === 'value') {
        continue
      }

      const nestedValueLabel =
        typeof fieldValue === 'object' && fieldValue !== null && !Array.isArray(fieldValue)
          ? typeof (fieldValue as Record<string, unknown>).label === 'string'
            ? ((fieldValue as Record<string, unknown>).label as string)
            : undefined
          : undefined

      const inferredLabel =
        getCognitoAttachmentFieldLabel(fieldName) ||
        nestedValueLabel ||
        (containerLabel && (fieldName === 'files' || fieldName === 'file' || fieldName === 'attachments')
          ? containerLabel
          : undefined)

      candidates.push({ fieldName, fieldValue, sourceFieldLabel: inferredLabel })
      queue.push(fieldValue)
    }

    if (record.value !== undefined) {
      queue.push(record.value)
    }
  }

  return candidates
}

export function extractCognitoAttachments(rawPayload: unknown): IntakeAttachmentMetadata[] {
  const topLevel = asRecord(rawPayload)
  if (!topLevel) {
    return []
  }

  const results: IntakeAttachmentMetadata[] = []

  for (const fieldName of KNOWN_COGNITO_UPLOAD_FIELDS) {
    const fieldValue = topLevel[fieldName]
    results.push(...normalizeKnownFileFieldValue(fieldValue, fieldName, getCognitoAttachmentFieldLabel(fieldName)))
  }

  // Some Cognito exports use different field keys than our known list.
  for (const [fieldName, fieldValue] of Object.entries(topLevel)) {
    if (KNOWN_COGNITO_UPLOAD_FIELDS.includes(fieldName as (typeof KNOWN_COGNITO_UPLOAD_FIELDS)[number])) {
      continue
    }

    const inferredLabel = getCognitoAttachmentFieldLabel(fieldName)
    results.push(...normalizeKnownFileFieldValue(fieldValue, fieldName, inferredLabel))
  }

  for (const candidate of collectNestedAttachmentCandidates(rawPayload)) {
    results.push(
      ...normalizeKnownFileFieldValue(candidate.fieldValue, candidate.fieldName, candidate.sourceFieldLabel)
    )
  }

  results.push(...normalizeKnownFileFieldValue(topLevel.Signature, 'Signature', 'Signature'))

  const deduped = new Map<string, IntakeAttachmentMetadata>()

  for (const item of results) {
    const key = `${item.filename}|${item.sourceUrl || ''}|${item.storageKey || ''}`
    if (!deduped.has(key)) {
      deduped.set(key, item)
    }
  }

  return Array.from(deduped.values())
}

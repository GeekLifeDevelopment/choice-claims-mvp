import type { IntakeAttachmentMetadata } from '../domain/claims'

type UnknownRecord = Record<string, unknown>

const ATTACHMENT_CATEGORY_HINTS = [
  'repair order',
  'repair estimate',
  'under hood',
  'odometer',
  'driver side profile',
  'under carriage',
  'rear profile',
  'failed parts'
]

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLikelyUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function findString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeKey(rawKey)
    if (keys.includes(key) && typeof rawValue === 'string' && rawValue.trim()) {
      return rawValue.trim()
    }
  }

  return undefined
}

function findNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeKey(rawKey)
    if (!keys.includes(key)) {
      continue
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return rawValue
    }

    if (typeof rawValue === 'string') {
      const parsed = Number(rawValue)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return undefined
}

function inferFilenameFromUrl(url?: string): string | undefined {
  if (!url) {
    return undefined
  }

  try {
    const parsed = new URL(url)
    const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1)
    return lastSegment || undefined
  } catch {
    return undefined
  }
}

function normalizeAttachmentCandidate(record: UnknownRecord): IntakeAttachmentMetadata | null {
  const sourceUrl = findString(record, ['sourceurl', 'url', 'fileurl', 'downloadurl', 'href'])
  const filename =
    findString(record, ['filename', 'name', 'title', 'originalfilename']) ||
    inferFilenameFromUrl(sourceUrl)

  if (!filename) {
    return null
  }

  const mimeType = findString(record, ['mimetype', 'mime', 'contenttype', 'type'])
  const storageKey = findString(record, ['storagekey', 'key', 'objectkey', 'path'])
  const externalId = findString(record, ['externalid', 'id', 'fileid', 'assetid'])
  const fileSize = findNumber(record, ['filesize', 'size', 'bytes'])

  return {
    filename,
    mimeType,
    fileSize,
    sourceUrl,
    storageKey,
    externalId
  }
}

function collectPrimitiveUrlAttachments(record: UnknownRecord): IntakeAttachmentMetadata[] {
  const attachments: IntakeAttachmentMetadata[] = []

  for (const [key, value] of Object.entries(record)) {
    if (!isLikelyUrl(value)) {
      continue
    }

    const keyLabel = key.toLowerCase()
    const isHinted = ATTACHMENT_CATEGORY_HINTS.some((hint) => keyLabel.includes(hint))
    const looksLikeUploadField = keyLabel.includes('upload') || keyLabel.includes('photo') || keyLabel.includes('file')

    if (!isHinted && !looksLikeUploadField) {
      continue
    }

    attachments.push({
      filename: inferFilenameFromUrl(value) || `${keyLabel.replace(/\s+/g, '_')}.bin`,
      sourceUrl: value
    })
  }

  return attachments
}

export function extractCognitoAttachments(rawPayload: unknown): IntakeAttachmentMetadata[] {
  const results: IntakeAttachmentMetadata[] = []
  const queue: unknown[] = [rawPayload]
  const visited = new Set<unknown>()
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

    const normalized = normalizeAttachmentCandidate(current)
    if (normalized) {
      results.push(normalized)
    }

    results.push(...collectPrimitiveUrlAttachments(current))

    queue.push(...Object.values(current))
  }

  const deduped = new Map<string, IntakeAttachmentMetadata>()

  for (const item of results) {
    const key = `${item.filename}|${item.sourceUrl || ''}|${item.storageKey || ''}`
    if (!deduped.has(key)) {
      deduped.set(key, item)
    }
  }

  return Array.from(deduped.values())
}

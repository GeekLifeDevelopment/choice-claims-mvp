import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_BASE_DIR = join(tmpdir(), 'choice-claims-mvp', 'claim-documents')

function getBaseDir(): string {
  const configured = process.env.CLAIM_DOCUMENTS_STORAGE_DIR?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_BASE_DIR
}

function sanitizeFileName(input: string): string {
  const base = basename(input).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base.length > 0 ? base : 'document.pdf'
}

function normalizePdfFileName(input: string): string {
  const safeName = sanitizeFileName(input)
  return extname(safeName).toLowerCase() === '.pdf' ? safeName : `${safeName}.pdf`
}

function buildStorageKey(claimId: string, fileName: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const unique = randomUUID().slice(0, 8)
  return `${claimId}/${timestamp}-${unique}-${normalizePdfFileName(fileName)}`
}

function resolveStoragePath(storageKey: string): string {
  const baseDir = getBaseDir()
  const normalizedKey = normalize(storageKey).replace(/^\/+/, '')
  const fullPath = join(baseDir, normalizedKey)

  if (!fullPath.startsWith(baseDir)) {
    throw new Error('Invalid claim document storage key.')
  }

  return fullPath
}

export async function saveClaimDocumentFile(input: {
  claimId: string
  fileName: string
  content: Buffer
}): Promise<{ storageKey: string }> {
  const storageKey = buildStorageKey(input.claimId, input.fileName)
  const fullPath = resolveStoragePath(storageKey)

  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, input.content)

  return { storageKey }
}

export async function removeClaimDocumentFile(storageKey: string): Promise<void> {
  const fullPath = resolveStoragePath(storageKey)

  try {
    await unlink(fullPath)
  } catch {
    // Best-effort cleanup to avoid masking primary errors.
  }
}

export async function readClaimDocumentFile(storageKey: string): Promise<Buffer> {
  const fullPath = resolveStoragePath(storageKey)
  return readFile(fullPath)
}

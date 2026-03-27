import { NextResponse } from 'next/server'
import { logClaimDocumentUploadedAudit } from '../../../../../../../lib/audit/intake-audit-log'
import { removeClaimDocumentFile, saveClaimDocumentFile } from '../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../lib/prisma'

type RouteContext = {
  params: Promise<{ id: string }>
}

const MAX_DOCUMENT_SIZE_BYTES = 15 * 1024 * 1024
const ALLOWED_PDF_MIME_TYPES = new Set(['application/pdf'])

function buildClaimDetailUrl(requestUrl: string, claimId: string, documentUpload: string, count?: number): URL {
  const url = new URL(`/admin/claims/${claimId}`, requestUrl)
  url.searchParams.set('documentUpload', documentUpload)

  if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
    url.searchParams.set('documentUploadCount', String(count))
  }

  return url
}

function isPdfFilename(value: string): boolean {
  return value.trim().toLowerCase().endsWith('.pdf')
}

function getUploadedBy(formData: FormData): string | null {
  const value = formData.get('uploadedBy')
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params

  console.info('[claim_document] upload request received', {
    claimId: id
  })

  const claim = await prisma.claim.findUnique({
    where: { id },
    select: {
      id: true,
      claimNumber: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, id, 'not-found'), { status: 303 })
  }

  const formData = await request.formData()
  const uploadedBy = getUploadedBy(formData)
  const files = formData.getAll('documents')

  if (files.length === 0) {
    return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'missing-file'), { status: 303 })
  }

  const parsedFiles: Array<{ fileName: string; mimeType: string; size: number; bytes: Buffer }> = []

  for (const entry of files) {
    if (!(entry instanceof File)) {
      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'invalid-file'), { status: 303 })
    }

    const fileName = entry.name || 'document.pdf'
    const mimeType = entry.type.trim().toLowerCase()
    const size = entry.size

    if (size <= 0) {
      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'empty-file'), { status: 303 })
    }

    if (size > MAX_DOCUMENT_SIZE_BYTES) {
      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'file-too-large'), { status: 303 })
    }

    if (!ALLOWED_PDF_MIME_TYPES.has(mimeType) || !isPdfFilename(fileName)) {
      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'invalid-file-type'), { status: 303 })
    }

    const bytes = Buffer.from(await entry.arrayBuffer())
    parsedFiles.push({
      fileName,
      mimeType,
      size,
      bytes
    })
  }

  let uploadedCount = 0

  for (const file of parsedFiles) {
    const savedFile = await saveClaimDocumentFile({
      claimId: claim.id,
      fileName: file.fileName,
      content: file.bytes
    })

    try {
      const document = await prisma.claimDocument.create({
        data: {
          claimId: claim.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          storageKey: savedFile.storageKey,
          fileSize: file.size,
          uploadedBy,
          processingStatus: 'uploaded',
          documentType: null,
          matchStatus: null
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          fileSize: true,
          processingStatus: true,
          documentType: true,
          matchStatus: true
        }
      })

      await logClaimDocumentUploadedAudit({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: document.id,
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
        uploadedBy,
        processingStatus: document.processingStatus,
        documentType: document.documentType,
        matchStatus: document.matchStatus
      })

      uploadedCount += 1
    } catch (error) {
      await removeClaimDocumentFile(savedFile.storageKey)

      console.error('[claim_document] upload failed', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        fileName: file.fileName,
        error: error instanceof Error ? error.message : 'unknown_error'
      })

      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'upload-failed'), {
        status: 303
      })
    }
  }

  console.info('[claim_document] upload success', {
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    uploadedCount
  })

  return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'uploaded', uploadedCount), {
    status: 303
  })
}

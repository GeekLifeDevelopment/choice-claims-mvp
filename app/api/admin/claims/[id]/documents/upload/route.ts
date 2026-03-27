import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import {
  logClaimDocumentExtractionAttemptedAudit,
  logClaimDocumentExtractionFailedAudit,
  logClaimDocumentExtractionPartialAudit,
  logClaimDocumentExtractionSkippedAudit,
  logClaimDocumentExtractionSucceededAudit,
  logClaimDocumentClassifiedAudit,
  logClaimDocumentMatchEvaluatedAudit,
  logClaimDocumentUploadedAudit
} from '../../../../../../../lib/audit/intake-audit-log'
import { removeClaimDocumentFile, saveClaimDocumentFile } from '../../../../../../../lib/claims/claim-document-storage'
import {
  detectAndMatchUploadedDocument,
  type DocumentDetectionResult
} from '../../../../../../../lib/claims/detect-uploaded-document'
import { extractUploadedDocumentData } from '../../../../../../../lib/claims/extract-uploaded-document'
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
      claimNumber: true,
      vin: true,
      claimantName: true
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

    let createdDocument: {
      id: string
      fileName: string
      mimeType: string
      fileSize: number
      uploadedBy: string | null
      processingStatus: string
      documentType: string | null
      matchStatus: string | null
      matchNotes: string | null
      parsedAnchors: Prisma.JsonValue | null
      extractionStatus: string
      extractedAt: Date | null
      extractedData: Prisma.JsonValue | null
      extractionWarnings: Prisma.JsonValue | null
    } | null = null

    try {
      createdDocument = await prisma.claimDocument.create({
        data: {
          claimId: claim.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          storageKey: savedFile.storageKey,
          fileSize: file.size,
          uploadedBy,
          processingStatus: 'uploaded',
          documentType: null,
          matchStatus: null,
          matchNotes: null,
          parsedAnchors: Prisma.JsonNull,
          extractionStatus: 'pending',
          extractedAt: null,
          extractedData: Prisma.JsonNull,
          extractionWarnings: Prisma.JsonNull
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          fileSize: true,
          uploadedBy: true,
          processingStatus: true,
          documentType: true,
          matchStatus: true,
          matchNotes: true,
          parsedAnchors: true,
          extractionStatus: true,
          extractedAt: true,
          extractedData: true,
          extractionWarnings: true
        }
      })
    } catch (error) {
      await removeClaimDocumentFile(savedFile.storageKey)

      console.error('[claim_document] upload failed before document create', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        fileName: file.fileName,
        error: error instanceof Error ? error.message : 'unknown_error'
      })

      return NextResponse.redirect(buildClaimDetailUrl(request.url, claim.id, 'upload-failed'), {
        status: 303
      })
    }

    let updatedDocument = createdDocument

    try {
      const document = createdDocument

      let detectionResult: DocumentDetectionResult

      try {
        detectionResult = await detectAndMatchUploadedDocument({
          fileName: file.fileName,
          pdfBytes: file.bytes,
          claimVin: claim.vin,
          claimantName: claim.claimantName
        })
      } catch (error) {
        console.warn('[claim_document] detection failed, marking pending', {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: document.id,
          fileName: file.fileName,
          error: error instanceof Error ? error.message : 'unknown_error'
        })

        detectionResult = {
          documentType: 'unknown',
          matchStatus: 'pending',
          matchNotes: 'Document parsing failed. Match verification is pending.',
          anchors: {
            vin: null,
            claimantName: null,
            mileage: null,
            contractDate: null,
            purchaseDate: null,
            agreementDate: null
          },
          processingStatus: 'pending'
        }
      }

      const extractionResult = await extractUploadedDocumentData({
        documentType: detectionResult.documentType,
        pdfBytes: file.bytes
      })

      updatedDocument = await prisma.claimDocument.update({
        where: { id: document.id },
        data: {
          documentType: detectionResult.documentType,
          matchStatus: detectionResult.matchStatus,
          matchNotes: detectionResult.matchNotes,
          parsedAnchors: detectionResult.anchors,
          processingStatus: detectionResult.processingStatus,
          extractionStatus: extractionResult.status,
          extractedAt: new Date(extractionResult.extractedAt),
          extractedData:
            extractionResult.extractedData === null
              ? Prisma.JsonNull
              : (extractionResult.extractedData as Prisma.InputJsonValue),
          extractionWarnings:
            extractionResult.warnings.length > 0
              ? (extractionResult.warnings as Prisma.InputJsonValue)
              : Prisma.JsonNull
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          fileSize: true,
          uploadedBy: true,
          processingStatus: true,
          documentType: true,
          matchStatus: true,
          matchNotes: true,
          parsedAnchors: true,
          extractionStatus: true,
          extractedAt: true,
          extractedData: true,
          extractionWarnings: true
        }
      })
    } catch (error) {
      const extractionWarning = error instanceof Error ? error.message : 'Extraction pipeline error.'

      console.error('[claim_document] processing failed after upload; preserving document', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: createdDocument.id,
        fileName: file.fileName,
        error: extractionWarning
      })

      try {
        updatedDocument = await prisma.claimDocument.update({
          where: { id: createdDocument.id },
          data: {
            documentType: createdDocument.documentType ?? 'unknown',
            matchStatus: createdDocument.matchStatus ?? 'pending',
            matchNotes: createdDocument.matchNotes ?? 'Document processing failed after upload.',
            parsedAnchors: createdDocument.parsedAnchors ?? Prisma.JsonNull,
            processingStatus: createdDocument.processingStatus || 'pending',
            extractionStatus: 'failed',
            extractedAt: new Date(),
            extractionWarnings: [extractionWarning] as Prisma.InputJsonValue
          },
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            fileSize: true,
            uploadedBy: true,
            processingStatus: true,
            documentType: true,
            matchStatus: true,
            matchNotes: true,
            parsedAnchors: true,
            extractionStatus: true,
            extractedAt: true,
            extractedData: true,
            extractionWarnings: true
          }
        })
      } catch (fallbackUpdateError) {
        console.error('[claim_document] failed to persist processing failure status', {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: createdDocument.id,
          error: fallbackUpdateError instanceof Error ? fallbackUpdateError.message : 'unknown_error'
        })
      }
    }

    try {
      const documentForAudit = updatedDocument || createdDocument

      await logClaimDocumentUploadedAudit({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: documentForAudit.id,
        fileName: documentForAudit.fileName,
        mimeType: documentForAudit.mimeType,
        fileSize: documentForAudit.fileSize,
        uploadedBy,
        processingStatus: documentForAudit.processingStatus,
        documentType: documentForAudit.documentType,
        matchStatus: documentForAudit.matchStatus
      })

      await logClaimDocumentClassifiedAudit({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: documentForAudit.id,
        fileName: documentForAudit.fileName,
        documentType: documentForAudit.documentType || 'unknown',
        processingStatus: documentForAudit.processingStatus
      })

      await logClaimDocumentMatchEvaluatedAudit({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: documentForAudit.id,
        fileName: documentForAudit.fileName,
        matchStatus: documentForAudit.matchStatus || 'pending',
        matchNotes: documentForAudit.matchNotes,
        anchors: documentForAudit.parsedAnchors ?? undefined
      })

      await logClaimDocumentExtractionAttemptedAudit({
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: documentForAudit.id,
        fileName: documentForAudit.fileName,
        documentType: documentForAudit.documentType || 'unknown'
      })

      if (documentForAudit.extractionStatus === 'extracted') {
        await logClaimDocumentExtractionSucceededAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          extractionStatus: documentForAudit.extractionStatus,
          extractedAt: documentForAudit.extractedAt,
          extractedData: documentForAudit.extractedData ?? undefined,
          extractionWarnings: documentForAudit.extractionWarnings ?? undefined
        })
      } else if (documentForAudit.extractionStatus === 'partial') {
        await logClaimDocumentExtractionPartialAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          extractionStatus: documentForAudit.extractionStatus,
          extractedAt: documentForAudit.extractedAt,
          extractedData: documentForAudit.extractedData ?? undefined,
          extractionWarnings: documentForAudit.extractionWarnings ?? undefined
        })
      } else if (documentForAudit.extractionStatus === 'failed') {
        await logClaimDocumentExtractionFailedAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          extractionStatus: documentForAudit.extractionStatus,
          extractedAt: documentForAudit.extractedAt,
          extractionWarnings: documentForAudit.extractionWarnings ?? undefined
        })
      } else if (documentForAudit.extractionStatus === 'skipped') {
        await logClaimDocumentExtractionSkippedAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          extractionStatus: documentForAudit.extractionStatus,
          extractedAt: documentForAudit.extractedAt,
          extractionWarnings: documentForAudit.extractionWarnings ?? undefined
        })
      }
    } catch (error) {
      console.warn('[claim_document] audit logging failed after upload', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: createdDocument.id,
        fileName: file.fileName,
        error: error instanceof Error ? error.message : 'unknown_error'
      })
    }

    uploadedCount += 1
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

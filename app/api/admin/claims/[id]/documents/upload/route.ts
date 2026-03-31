import '../../../../../../../lib/config/ensure-database-url'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import {
  logClaimDocumentChoiceFallbackAttemptedAudit,
  logClaimDocumentChoiceFallbackFailedAudit,
  logClaimDocumentChoiceFallbackPartialAudit,
  logClaimDocumentChoiceFallbackSucceededAudit,
  logClaimDocumentEvidenceAppliedAudit,
  logClaimDocumentEvidenceConflictDetectedAudit,
  logClaimDocumentEvidencePartiallyAppliedAudit,
  logClaimDocumentEvidenceSkippedAudit,
  logClaimDocumentEvidenceTriggeredRefreshAudit,
  logClaimDocumentExtractionAttemptedAudit,
  logClaimDocumentExtractionFailedAudit,
  logClaimDocumentExtractionPartialAudit,
  logClaimDocumentExtractionSkippedAudit,
  logClaimDocumentExtractionSucceededAudit,
  logClaimDocumentClassifiedAudit,
  logClaimDocumentMatchEvaluatedAudit,
  logClaimDocumentReuploadedAudit,
  logClaimDocumentUploadedAudit
} from '../../../../../../../lib/audit/intake-audit-log'
import { removeClaimDocumentFile, saveClaimDocumentFile } from '../../../../../../../lib/claims/claim-document-storage'
import {
  detectAndMatchUploadedDocument,
  resolveChoiceMatchAfterExtraction,
  type DocumentDetectionResult
} from '../../../../../../../lib/claims/detect-uploaded-document'
import { extractUploadedDocumentData } from '../../../../../../../lib/claims/extract-uploaded-document'
import {
  applyUploadedDocumentEvidence,
  mergeExtractedDataWithEvidenceApply
} from '../../../../../../../lib/claims/apply-uploaded-document-evidence'
import { prisma } from '../../../../../../../lib/prisma'
import { enqueueReviewSummaryForClaim } from '../../../../../../../lib/review/enqueue-review-summary'

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

function getAuditMetadataFileName(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const fileName = (value as Record<string, unknown>).fileName
  if (typeof fileName !== 'string') {
    return null
  }

  const trimmed = fileName.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getExtractedDataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getExtractedFieldCount(value: unknown): number {
  const record = getExtractedDataRecord(value)
  const keys = Object.keys(record).filter((entry) => !entry.startsWith('__'))
  return keys.length
}

function normalizeVinForLog(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
  return normalized.length === 17 ? normalized : null
}

function normalizeComparableDateForLog(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString().slice(0, 10)
}

function normalizeMileageForLog(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[\s,]/g, ''), 10)
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed)
    }
  }

  return null
}

function getChoiceResolutionDebugFields(claimVin: string | null, extractedData: unknown) {
  const extracted = getExtractedDataRecord(extractedData)

  const extractedVinRaw = typeof extracted.vin === 'string' ? extracted.vin : null
  const vehiclePurchaseDateRaw =
    typeof extracted.vehiclePurchaseDate === 'string' ? extracted.vehiclePurchaseDate : null
  const agreementPurchaseDateRaw =
    typeof extracted.agreementPurchaseDate === 'string' ? extracted.agreementPurchaseDate : null

  return {
    claimVinRaw: claimVin,
    claimVinNormalized: normalizeVinForLog(claimVin),
    extractedVinRaw,
    extractedVinNormalized: normalizeVinForLog(extractedVinRaw),
    vehiclePurchaseDateRaw,
    vehiclePurchaseDateNormalized: normalizeComparableDateForLog(vehiclePurchaseDateRaw),
    agreementPurchaseDateRaw,
    agreementPurchaseDateNormalized: normalizeComparableDateForLog(agreementPurchaseDateRaw),
    mileageAtSaleRaw: extracted.mileageAtSale ?? null,
    mileageAtSaleNormalized: normalizeMileageForLog(extracted.mileageAtSale),
    agreementNumber: typeof extracted.agreementNumber === 'string' ? extracted.agreementNumber : null
  }
}

function toChoiceFallbackAuditInput(input: {
  claimId: string
  claimNumber: string
  documentId: string
  fileName: string
  documentType: string
  choiceFallback: NonNullable<Awaited<ReturnType<typeof extractUploadedDocumentData>>['choiceContractFallback']>
}) {
  return {
    claimId: input.claimId,
    claimNumber: input.claimNumber,
    documentId: input.documentId,
    fileName: input.fileName,
    documentType: input.documentType,
    fallbackStatus: input.choiceFallback.status,
    attempted: input.choiceFallback.attempted,
    used: input.choiceFallback.used,
    method: input.choiceFallback.method,
    extractedAt: input.choiceFallback.extractedAt,
    filledFields: input.choiceFallback.filledFields,
    triggerReasons: input.choiceFallback.triggerReasons,
    confidence: input.choiceFallback.confidence,
    warnings: input.choiceFallback.warnings,
    failureReason: input.choiceFallback.failureReason
  } as const
}

async function wasDocumentPreviouslyRemoved(claimId: string, fileName: string): Promise<boolean> {
  const lowered = fileName.trim().toLowerCase()
  if (!lowered) {
    return false
  }

  const recentRemovalEvents = await prisma.auditLog.findMany({
    where: {
      claimId,
      action: 'claim_document_removed'
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      metadata: true
    }
  })

  return recentRemovalEvents.some((entry) => {
    const loggedFileName = getAuditMetadataFileName(entry.metadata)
    return Boolean(loggedFileName && loggedFileName.toLowerCase() === lowered)
  })
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
      claimantName: true,
      vinDataResult: true
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
    const isReupload = await wasDocumentPreviouslyRemoved(claim.id, file.fileName)

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
    let extractionResult: Awaited<ReturnType<typeof extractUploadedDocumentData>> | null = null

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

      extractionResult = await extractUploadedDocumentData({
        documentType: detectionResult.documentType,
        pdfBytes: file.bytes,
        fileName: file.fileName,
        documentId: document.id,
        storageKey: savedFile.storageKey
      })

      const effectiveDocumentType = extractionResult.resolvedDocumentType
      let finalMatchStatus = detectionResult.matchStatus
      let finalMatchNotes = detectionResult.matchNotes
      let finalProcessingStatus = detectionResult.processingStatus
      let finalAnchors = detectionResult.anchors
      const shouldRunChoiceResolver =
        effectiveDocumentType === 'choice_contract' &&
        (detectionResult.matchStatus === 'pending' ||
          detectionResult.matchStatus === 'possible_match' ||
          detectionResult.matchStatus === 'no_match')
      const choiceResolutionDebug = getChoiceResolutionDebugFields(claim.vin, extractionResult.extractedData)

      if (effectiveDocumentType === 'choice_contract') {
        console.info('[claim_document] choice match resolver gate', {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: document.id,
          fileName: file.fileName,
          documentType: effectiveDocumentType,
          initialMatchStatus: detectionResult.matchStatus,
          extractionStatus: extractionResult.status,
          resolverRan: shouldRunChoiceResolver,
          ...choiceResolutionDebug
        })
      }

      if (shouldRunChoiceResolver) {
        const choiceResolution = resolveChoiceMatchAfterExtraction({
          initial: {
            matchStatus: detectionResult.matchStatus,
            matchNotes: detectionResult.matchNotes,
            processingStatus: detectionResult.processingStatus,
            anchors: detectionResult.anchors
          },
          extractionStatus: extractionResult.status,
          extractedData: extractionResult.extractedData,
          claimVin: claim.vin
        })

        finalMatchStatus = choiceResolution.matchStatus
        finalMatchNotes = choiceResolution.matchNotes
        finalProcessingStatus = choiceResolution.processingStatus
        finalAnchors = choiceResolution.anchors

        console.info('[claim_document] choice match resolution', {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: document.id,
          fileName: file.fileName,
          documentType: effectiveDocumentType,
          initialMatchStatus: detectionResult.matchStatus,
          finalMatchStatus,
          resolutionReason: choiceResolution.resolutionReason,
          extractionStatus: extractionResult.status,
          resolverRan: true,
          finalResolutionReason: choiceResolution.resolutionReason,
          usedFallbackAnchors: choiceResolution.usedFallbackAnchors,
          availableAnchors: choiceResolution.availableAnchors,
          ...choiceResolutionDebug
        })
      }

      const evidenceApplyResult = applyUploadedDocumentEvidence({
        documentId: document.id,
        documentType: effectiveDocumentType,
        matchStatus: finalMatchStatus,
        extractionStatus: extractionResult.status,
        extractedData: extractionResult.extractedData,
        vinDataResult: claim.vinDataResult
      })

      const extractedDataWithApply = mergeExtractedDataWithEvidenceApply(
        extractionResult.extractedData,
        evidenceApplyResult
      )

      if (evidenceApplyResult.didMutateClaimEvidence) {
        await prisma.claim.update({
          where: { id: claim.id },
          data: {
            vinDataResult: evidenceApplyResult.nextVinDataResult as Prisma.InputJsonValue
          }
        })

        claim.vinDataResult = evidenceApplyResult.nextVinDataResult as Prisma.JsonValue
      }

      updatedDocument = await prisma.claimDocument.update({
        where: { id: document.id },
        data: {
          documentType: effectiveDocumentType,
          matchStatus: finalMatchStatus,
          matchNotes: finalMatchNotes,
          parsedAnchors: finalAnchors,
          processingStatus: finalProcessingStatus,
          extractionStatus: extractionResult.status,
          extractedAt: new Date(extractionResult.extractedAt),
          extractedData: extractedDataWithApply as Prisma.InputJsonValue,
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

      console.info('[claim_document] upload persisted document state', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType,
        matchStatus: updatedDocument.matchStatus,
        extractionStatus: updatedDocument.extractionStatus,
        processingStatus: updatedDocument.processingStatus,
        extractedFieldCount: getExtractedFieldCount(updatedDocument.extractedData)
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

      if (isReupload) {
        await logClaimDocumentReuploadedAudit({
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
      }

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

      const choiceFallback = extractionResult?.choiceContractFallback
      if (choiceFallback?.attempted) {
        const fallbackAuditInput = toChoiceFallbackAuditInput({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          choiceFallback
        })

        await logClaimDocumentChoiceFallbackAttemptedAudit(fallbackAuditInput)

        if (choiceFallback.status === 'succeeded') {
          await logClaimDocumentChoiceFallbackSucceededAudit(fallbackAuditInput)
        } else if (choiceFallback.status === 'partial') {
          await logClaimDocumentChoiceFallbackPartialAudit(fallbackAuditInput)
        } else if (choiceFallback.status === 'failed') {
          await logClaimDocumentChoiceFallbackFailedAudit(fallbackAuditInput)
        }
      }

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

      const extractedDataRecord =
        documentForAudit.extractedData && typeof documentForAudit.extractedData === 'object' && !Array.isArray(documentForAudit.extractedData)
          ? (documentForAudit.extractedData as Record<string, unknown>)
          : {}
      const evidenceApply =
        extractedDataRecord.__evidenceApply &&
        typeof extractedDataRecord.__evidenceApply === 'object' &&
        !Array.isArray(extractedDataRecord.__evidenceApply)
          ? (extractedDataRecord.__evidenceApply as Record<string, unknown>)
          : null

      if (evidenceApply) {
        const applyStatus = typeof evidenceApply.applyStatus === 'string' ? evidenceApply.applyStatus : 'skipped'
        const appliedAt = typeof evidenceApply.appliedAt === 'string' ? evidenceApply.appliedAt : null
        const appliedFields = Array.isArray(evidenceApply.appliedFields)
          ? evidenceApply.appliedFields
              .map((entry) => (typeof entry === 'string' ? entry : null))
              .filter((entry): entry is string => Boolean(entry))
          : []
        const skippedFields = Array.isArray(evidenceApply.skippedFields)
          ? evidenceApply.skippedFields
              .map((entry) => (typeof entry === 'string' ? entry : null))
              .filter((entry): entry is string => Boolean(entry))
          : []
        const conflictFields = Array.isArray(evidenceApply.conflictFields)
          ? evidenceApply.conflictFields
              .map((entry) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                  return null
                }

                const field = (entry as Record<string, unknown>).field
                const reason = (entry as Record<string, unknown>).reason

                if (typeof field !== 'string') {
                  return null
                }

                return typeof reason === 'string' ? `${field}:${reason}` : field
              })
              .filter((entry): entry is string => Boolean(entry))
          : []

        const evidenceAuditInput = {
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: documentForAudit.id,
          fileName: documentForAudit.fileName,
          documentType: documentForAudit.documentType || 'unknown',
          applyStatus,
          appliedAt,
          appliedFields: appliedFields as Prisma.InputJsonValue,
          skippedFields: skippedFields as Prisma.InputJsonValue,
          conflictFields: conflictFields as Prisma.InputJsonValue
        }

        if (applyStatus === 'applied') {
          await logClaimDocumentEvidenceAppliedAudit(evidenceAuditInput)
        } else if (applyStatus === 'partial') {
          await logClaimDocumentEvidencePartiallyAppliedAudit(evidenceAuditInput)
        } else if (applyStatus === 'conflict') {
          await logClaimDocumentEvidenceConflictDetectedAudit(evidenceAuditInput)
        } else {
          await logClaimDocumentEvidenceSkippedAudit(evidenceAuditInput)
        }

        const shouldTriggerRefresh =
          (applyStatus === 'applied' || applyStatus === 'partial') && appliedFields.length > 0

        if (shouldTriggerRefresh) {
          const refreshResult = await enqueueReviewSummaryForClaim(claim.id, 'document_evidence')

          await logClaimDocumentEvidenceTriggeredRefreshAudit({
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            documentId: documentForAudit.id,
            fileName: documentForAudit.fileName,
            documentType: documentForAudit.documentType || 'unknown',
            applyStatus,
            queueEnqueued: refreshResult.enqueued,
            queueReason: refreshResult.reason,
            queueName: refreshResult.queueName,
            jobName: refreshResult.jobName,
            jobId: refreshResult.jobId
          })
        }
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

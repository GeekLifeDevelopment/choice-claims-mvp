import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import {
  logClaimDocumentChoiceFallbackAttemptedAudit,
  logClaimDocumentChoiceFallbackFailedAudit,
  logClaimDocumentChoiceFallbackPartialAudit,
  logClaimDocumentChoiceFallbackSucceededAudit,
  logClaimDocumentClassifiedAudit,
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
  logClaimDocumentMatchEvaluatedAudit,
  logClaimDocumentReprocessFailedAudit,
  logClaimDocumentReprocessedAudit,
  logClaimDocumentReprocessRequestedAudit
} from '../../../../../../../../lib/audit/intake-audit-log'
import {
  detectAndMatchUploadedDocument,
  resolveChoiceMatchAfterExtraction,
  type DocumentDetectionResult
} from '../../../../../../../../lib/claims/detect-uploaded-document'
import { extractUploadedDocumentData } from '../../../../../../../../lib/claims/extract-uploaded-document'
import {
  applyUploadedDocumentEvidence,
  mergeExtractedDataWithEvidenceApply
} from '../../../../../../../../lib/claims/apply-uploaded-document-evidence'
import { readClaimDocumentFile } from '../../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../../lib/prisma'
import { enqueueReviewSummaryForClaim } from '../../../../../../../../lib/review/enqueue-review-summary'

type RouteContext = {
  params: Promise<{ id: string; documentId: string }>
}

function resolveRequestOrigin(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()

  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.split(',')[0]?.trim()
  if (host) {
    const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'
    return `${proto}://${host}`
  }

  return new URL(request.url).origin
}

function buildClaimDetailUrl(request: Request, claimId: string, status: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, resolveRequestOrigin(request))
  url.searchParams.set('documentReprocess', status)
  return url
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

function getEvidenceApplyRecord(value: unknown): Record<string, unknown> {
  const extracted = getExtractedDataRecord(value)
  const apply = extracted.__evidenceApply
  return getExtractedDataRecord(apply)
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

function parseEvidenceApplyForAudit(value: unknown): {
  applyStatus: string
  appliedAt: string | null
  appliedFields: string[]
  skippedFields: string[]
  conflictFields: string[]
} {
  const record = getEvidenceApplyRecord(value)

  const applyStatus = typeof record.applyStatus === 'string' ? record.applyStatus : 'skipped'
  const appliedAt = typeof record.appliedAt === 'string' ? record.appliedAt : null
  const appliedFields = Array.isArray(record.appliedFields)
    ? record.appliedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const skippedFields = Array.isArray(record.skippedFields)
    ? record.skippedFields
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry))
    : []
  const conflictFields = Array.isArray(record.conflictFields)
    ? record.conflictFields
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

  return {
    applyStatus,
    appliedAt,
    appliedFields,
    skippedFields,
    conflictFields
  }
}

function shouldTriggerSummaryRefresh(input: { applyStatus: string; appliedFields: string[] }): boolean {
  return (input.applyStatus === 'applied' || input.applyStatus === 'partial') && input.appliedFields.length > 0
}

function parseDetectionFailure(error: unknown): DocumentDetectionResult {
  return {
    documentType: 'unknown',
    matchStatus: 'pending',
    matchNotes:
      'Document parsing failed during reprocess. Match verification remains pending.',
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

export async function POST(request: Request, context: RouteContext) {
  const { id: claimId, documentId } = await context.params

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      reviewDecision: true,
      vin: true,
      claimantName: true,
      vinDataResult: true
    }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(request, claimId, 'not-found'), { status: 303 })
  }

  const document = await prisma.claimDocument.findFirst({
    where: {
      id: documentId,
      claimId: claim.id
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      fileSize: true,
      storageKey: true,
      processingStatus: true,
      documentType: true,
      matchStatus: true,
      extractionStatus: true,
      extractionWarnings: true,
      extractedData: true
    }
  })

  if (!document) {
    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'missing-document'), { status: 303 })
  }

  await logClaimDocumentReprocessRequestedAudit({
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    documentId: document.id,
    fileName: document.fileName,
    requestedBy: 'admin_ui',
    previousProcessingStatus: document.processingStatus,
    previousDocumentType: document.documentType,
    previousMatchStatus: document.matchStatus,
    previousExtractionStatus: document.extractionStatus
  })

  let pdfBytes: Buffer

  try {
    const fileBuffer = await readClaimDocumentFile(document.storageKey)
    pdfBytes = Buffer.from(fileBuffer)

    const pdfHeader = pdfBytes.subarray(0, 5).toString('ascii')
    console.info('[claim_document] reprocess storage read diagnostics', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      storageKey: document.storageKey,
      storedFileSize: document.fileSize,
      readBytes: pdfBytes.length,
      pdfHeader,
      pdfHeaderLooksValid: pdfHeader.startsWith('%PDF-')
    })
  } catch {
    await logClaimDocumentReprocessFailedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      errorMessage: 'Document file not found in storage during reprocess.'
    })

    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'file-unavailable'), { status: 303 })
  }

  let detectionResult: DocumentDetectionResult

  try {
    detectionResult = await detectAndMatchUploadedDocument({
      fileName: document.fileName,
      pdfBytes,
      claimVin: claim.vin,
      claimantName: claim.claimantName
    })
  } catch (error) {
    console.warn('[claim_document] reprocess detection failed; marking pending', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      error: error instanceof Error ? error.message : 'unknown_error'
    })

    detectionResult = parseDetectionFailure(error)
  }

  const extractionResult = await extractUploadedDocumentData({
    documentType: detectionResult.documentType,
    fileBytes: pdfBytes,
    mimeType: document.mimeType,
    fileName: document.fileName,
    documentId: document.id,
    storageKey: document.storageKey
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
    console.info('[claim_document] reprocess choice match resolver gate', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
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

    console.info('[claim_document] reprocess choice match resolution', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
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

  const latestClaimForEvidence = await prisma.claim.findUnique({
    where: { id: claim.id },
    select: { vinDataResult: true }
  })

  const evidenceApplyResult = applyUploadedDocumentEvidence({
    documentId: document.id,
    source: 'uploaded_document',
    documentType: effectiveDocumentType,
    matchStatus: finalMatchStatus,
    extractionStatus: extractionResult.status,
    extractedData: extractionResult.extractedData,
    vinDataResult: latestClaimForEvidence?.vinDataResult ?? claim.vinDataResult
  })

  const extractedDataWithApply = mergeExtractedDataWithEvidenceApply(
    extractionResult.extractedData,
    evidenceApplyResult
  )

  let transactionResult:
    | {
        shouldQueueRefresh: boolean
        evidenceApplyStatus: string
        updatedSummary: {
          processingStatus: string
          documentType: string | null
          matchStatus: string | null
          extractionStatus: string
          extractedFieldCount: number
          fileName: string
          documentId: string
        }
      }
    | null = null

  try {
    transactionResult = await prisma.$transaction(async (tx) => {
      if (evidenceApplyResult.didMutateClaimEvidence) {
        await tx.claim.update({
          where: { id: claim.id },
          data: {
            vinDataResult: evidenceApplyResult.nextVinDataResult as Prisma.InputJsonValue
          }
        })
      }

      const updatedDocument = await tx.claimDocument.update({
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
          processingStatus: true,
          documentType: true,
          matchStatus: true,
          extractionStatus: true,
          extractionWarnings: true,
          extractedData: true
        }
      })

      console.info('[claim_document] reprocess persisted document state', {
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

      await logClaimDocumentClassifiedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown',
        processingStatus: updatedDocument.processingStatus
      })

      await logClaimDocumentMatchEvaluatedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        matchStatus: updatedDocument.matchStatus || 'pending',
        matchNotes: finalMatchNotes,
        anchors: finalAnchors
      })

      await logClaimDocumentExtractionAttemptedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown'
      })

      const choiceFallback = extractionResult.choiceContractFallback
      if (choiceFallback?.attempted) {
        const fallbackAuditInput = toChoiceFallbackAuditInput({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          choiceFallback
        })

        await logClaimDocumentChoiceFallbackAttemptedAudit({
          client: tx,
          ...fallbackAuditInput
        })

        if (choiceFallback.status === 'succeeded') {
          await logClaimDocumentChoiceFallbackSucceededAudit({
            client: tx,
            ...fallbackAuditInput
          })
        } else if (choiceFallback.status === 'partial') {
          await logClaimDocumentChoiceFallbackPartialAudit({
            client: tx,
            ...fallbackAuditInput
          })
        } else if (choiceFallback.status === 'failed') {
          await logClaimDocumentChoiceFallbackFailedAudit({
            client: tx,
            ...fallbackAuditInput
          })
        }
      }

      if (updatedDocument.extractionStatus === 'extracted') {
        await logClaimDocumentExtractionSucceededAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractedData: updatedDocument.extractedData as Prisma.InputJsonValue,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else if (updatedDocument.extractionStatus === 'partial') {
        await logClaimDocumentExtractionPartialAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractedData: updatedDocument.extractedData as Prisma.InputJsonValue,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else if (updatedDocument.extractionStatus === 'failed') {
        await logClaimDocumentExtractionFailedAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      } else {
        await logClaimDocumentExtractionSkippedAudit({
          client: tx,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          documentId: updatedDocument.id,
          fileName: updatedDocument.fileName,
          documentType: updatedDocument.documentType || 'unknown',
          extractionStatus: updatedDocument.extractionStatus,
          extractedAt: extractionResult.extractedAt,
          extractionWarnings: updatedDocument.extractionWarnings as Prisma.InputJsonValue
        })
      }

      const evidence = parseEvidenceApplyForAudit(updatedDocument.extractedData)

      const evidenceAuditInput = {
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedDocument.id,
        fileName: updatedDocument.fileName,
        documentType: updatedDocument.documentType || 'unknown',
        applyStatus: evidence.applyStatus,
        appliedAt: evidence.appliedAt,
        appliedFields: evidence.appliedFields as Prisma.InputJsonValue,
        skippedFields: evidence.skippedFields as Prisma.InputJsonValue,
        conflictFields: evidence.conflictFields as Prisma.InputJsonValue
      }

      if (evidence.applyStatus === 'applied') {
        await logClaimDocumentEvidenceAppliedAudit(evidenceAuditInput)
      } else if (evidence.applyStatus === 'partial') {
        await logClaimDocumentEvidencePartiallyAppliedAudit(evidenceAuditInput)
      } else if (evidence.applyStatus === 'conflict') {
        await logClaimDocumentEvidenceConflictDetectedAudit(evidenceAuditInput)
      } else {
        await logClaimDocumentEvidenceSkippedAudit(evidenceAuditInput)
      }

      return {
        shouldQueueRefresh: shouldTriggerSummaryRefresh(evidence),
        evidenceApplyStatus: evidence.applyStatus,
        updatedSummary: {
          processingStatus: updatedDocument.processingStatus,
          documentType: updatedDocument.documentType,
          matchStatus: updatedDocument.matchStatus,
          extractionStatus: updatedDocument.extractionStatus,
          extractedFieldCount: getExtractedFieldCount(updatedDocument.extractedData),
          fileName: updatedDocument.fileName,
          documentId: updatedDocument.id
        }
      }
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Document reprocess failed.'

    console.error('[claim_document] reprocess failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      error: errorMessage
    })

    await logClaimDocumentReprocessFailedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: document.id,
      fileName: document.fileName,
      errorMessage
    })

    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'failed'), { status: 303 })
  }

  if (!transactionResult) {
    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'failed'), { status: 303 })
  }

  const { shouldQueueRefresh, evidenceApplyStatus, updatedSummary } = transactionResult

  let refreshResult: Awaited<ReturnType<typeof enqueueReviewSummaryForClaim>> | null = null

  if (shouldQueueRefresh) {
    try {
      refreshResult = await enqueueReviewSummaryForClaim(claim.id, 'document_evidence', {
        allowLockedFinalDecision: true
      })
    } catch (error) {
      refreshResult = {
        enqueued: false,
        claimId: claim.id,
        reason: 'enqueue_failed'
      }

      console.error('[claim_document] reprocess refresh enqueue failed', {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: updatedSummary.documentId,
        error: error instanceof Error ? error.message : 'unknown_error'
      })
    }

    await logClaimDocumentEvidenceTriggeredRefreshAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId: updatedSummary.documentId,
      fileName: updatedSummary.fileName,
      documentType: updatedSummary.documentType || 'unknown',
      applyStatus: evidenceApplyStatus,
      queueEnqueued: refreshResult.enqueued,
      queueReason: refreshResult.reason,
      queueName: refreshResult.queueName,
      jobName: refreshResult.jobName,
      jobId: refreshResult.jobId,
      queueReusedInFlight: refreshResult.reusedInFlight ?? false
    })
  }

  await logClaimDocumentReprocessedAudit({
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    documentId: updatedSummary.documentId,
    fileName: updatedSummary.fileName,
    processingStatus: updatedSummary.processingStatus,
    documentType: updatedSummary.documentType,
    matchStatus: updatedSummary.matchStatus,
    extractionStatus: updatedSummary.extractionStatus,
    applyStatus: evidenceApplyStatus,
    extractedFieldCount: updatedSummary.extractedFieldCount,
    refreshQueued: refreshResult?.enqueued ?? false,
    refreshReason: refreshResult?.reason ?? null
  })

  return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'reprocessed'), { status: 303 })
}

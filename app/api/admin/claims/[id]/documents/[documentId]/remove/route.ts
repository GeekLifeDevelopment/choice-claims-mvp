import { NextResponse } from 'next/server'
import { logClaimDocumentRemovedAudit } from '../../../../../../../../lib/audit/intake-audit-log'
import { removeClaimDocumentFile } from '../../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../../lib/prisma'

type RouteContext = {
  params: Promise<{ id: string; documentId: string }>
}

function buildClaimDetailUrl(claimId: string, documentRemove: string): string {
  const params = new URLSearchParams()
  params.set('documentRemove', documentRemove)
  return `/admin/claims/${claimId}?${params.toString()}`
}

function getRemovedBy(formData: FormData): string | null {
  const value = formData.get('removedBy')
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function POST(request: Request, context: RouteContext) {
  const { id: claimId, documentId } = await context.params
  const formData = await request.formData()
  const removedBy = getRemovedBy(formData)

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: { id: true, claimNumber: true }
  })

  if (!claim) {
    return NextResponse.redirect(buildClaimDetailUrl(claimId, 'not-found'), { status: 303 })
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
      uploadedBy: true,
      processingStatus: true,
      documentType: true,
      matchStatus: true,
      extractionStatus: true
    }
  })

  if (!document) {
    return NextResponse.redirect(buildClaimDetailUrl(claim.id, 'missing-document'), { status: 303 })
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.claimDocument.delete({
        where: { id: document.id }
      })

      await logClaimDocumentRemovedAudit({
        client: tx,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        documentId: document.id,
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
        removedBy,
        uploadedBy: document.uploadedBy,
        processingStatus: document.processingStatus,
        documentType: document.documentType,
        matchStatus: document.matchStatus,
        extractionStatus: document.extractionStatus
      })
    })
  } catch (error) {
    console.error('[claim_document] remove failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      documentId,
      error: error instanceof Error ? error.message : 'unknown_error'
    })

    return NextResponse.redirect(buildClaimDetailUrl(claim.id, 'remove-failed'), { status: 303 })
  }

  await removeClaimDocumentFile(document.storageKey)

  return NextResponse.redirect(buildClaimDetailUrl(claim.id, 'removed'), { status: 303 })
}

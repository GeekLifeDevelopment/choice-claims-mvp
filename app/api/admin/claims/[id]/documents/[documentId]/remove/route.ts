import { NextResponse } from 'next/server'
import { logClaimDocumentRemovedAudit } from '../../../../../../../../lib/audit/intake-audit-log'
import { removeClaimDocumentFile } from '../../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../../lib/prisma'

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

function buildClaimDetailUrl(request: Request, claimId: string, documentRemove: string): URL {
  const url = new URL(`/admin/claims/${claimId}`, resolveRequestOrigin(request))
  url.searchParams.set('documentRemove', documentRemove)
  return url
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
      uploadedBy: true,
      processingStatus: true,
      documentType: true,
      matchStatus: true,
      extractionStatus: true
    }
  })

  if (!document) {
    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'missing-document'), { status: 303 })
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

    return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'remove-failed'), { status: 303 })
  }

  await removeClaimDocumentFile(document.storageKey)

  return NextResponse.redirect(buildClaimDetailUrl(request, claim.id, 'removed'), { status: 303 })
}

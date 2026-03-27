import { NextResponse } from 'next/server'
import { readClaimDocumentFile } from '../../../../../../../../lib/claims/claim-document-storage'
import { prisma } from '../../../../../../../../lib/prisma'

type RouteContext = {
  params: Promise<{ id: string; documentId: string }>
}

export async function GET(_request: Request, context: RouteContext) {
  const { id, documentId } = await context.params

  const document = await prisma.claimDocument.findFirst({
    where: {
      id: documentId,
      claimId: id
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      storageKey: true
    }
  })

  if (!document) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  try {
    const fileBuffer = await readClaimDocumentFile(document.storageKey)
    const body = new Uint8Array(fileBuffer)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': document.mimeType || 'application/pdf',
        'Content-Disposition': `inline; filename="${document.fileName}"`,
        'Cache-Control': 'private, max-age=60'
      }
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'file_unavailable' }, { status: 404 })
  }
}

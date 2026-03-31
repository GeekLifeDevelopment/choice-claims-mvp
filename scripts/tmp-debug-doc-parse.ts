import { PrismaClient } from '@prisma/client'
import { readClaimDocumentFile } from '../lib/claims/claim-document-storage'
import { readPdfTextConservatively } from '../lib/claims/read-pdf-text'

const prisma = new PrismaClient()
const documentId = process.argv[2]

if (!documentId) {
  console.error('Usage: tsx scripts/tmp-debug-doc-parse.ts <documentId>')
  process.exit(1)
}

async function main() {
  const document = await prisma.claimDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      claimId: true,
      fileName: true,
      storageKey: true,
      fileSize: true,
      mimeType: true,
      uploadedAt: true
    }
  })

  if (!document) {
    console.log(JSON.stringify({ documentId, found: false }, null, 2))
    return
  }

  const fileBytes = await readClaimDocumentFile(document.storageKey)
  const parsed = await readPdfTextConservatively(Buffer.from(fileBytes))
  const normalizedTextLength = parsed.text.replace(/\s+/g, '').length

  const snippet = parsed.text.slice(0, 500)

  console.log(
    JSON.stringify(
      {
        documentId: document.id,
        claimId: document.claimId,
        fileName: document.fileName,
        storageKey: document.storageKey,
        mimeType: document.mimeType,
        storedFileSize: document.fileSize,
        readBytes: fileBytes.length,
        parseFailed: parsed.parseFailed,
        parsedTextLength: parsed.text.length,
        normalizedTextLength,
        snippet
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

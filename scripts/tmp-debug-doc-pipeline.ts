import { PrismaClient } from '@prisma/client'
import { readClaimDocumentFile } from '../lib/claims/claim-document-storage'
import { detectAndMatchUploadedDocument } from '../lib/claims/detect-uploaded-document'
import { extractUploadedDocumentData } from '../lib/claims/extract-uploaded-document'

const prisma = new PrismaClient()
const claimId = process.argv[2]
const documentId = process.argv[3]

if (!claimId || !documentId) {
  console.error('Usage: tsx scripts/tmp-debug-doc-pipeline.ts <claimId> <documentId>')
  process.exit(1)
}

async function main() {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: { id: true, claimNumber: true, vin: true, claimantName: true }
  })

  if (!claim) {
    throw new Error(`claim not found: ${claimId}`)
  }

  const document = await prisma.claimDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      fileName: true,
      storageKey: true,
      documentType: true,
      matchStatus: true,
      extractionStatus: true
    }
  })

  if (!document) {
    throw new Error(`document not found: ${documentId}`)
  }

  const fileBytes = await readClaimDocumentFile(document.storageKey)
  const pdfBytes = Buffer.from(fileBytes)

  const detectionResult = await detectAndMatchUploadedDocument({
    fileName: document.fileName,
    pdfBytes,
    claimVin: claim.vin,
    claimantName: claim.claimantName
  })

  const extractionResult = await extractUploadedDocumentData({
    documentType: detectionResult.documentType,
    fileBytes: pdfBytes,
    fileName: document.fileName
  })

  console.log(
    JSON.stringify(
      {
        claim: {
          id: claim.id,
          claimNumber: claim.claimNumber,
          vin: claim.vin
        },
        document: {
          id: document.id,
          fileName: document.fileName,
          storageKey: document.storageKey,
          persistedDocumentType: document.documentType,
          persistedMatchStatus: document.matchStatus,
          persistedExtractionStatus: document.extractionStatus
        },
        detectionResult,
        extractionResult: {
          status: extractionResult.status,
          resolvedDocumentType: extractionResult.resolvedDocumentType,
          warnings: extractionResult.warnings,
          extractedKeys: extractionResult.extractedData
            ? Object.keys(extractionResult.extractedData).filter((key) => !key.startsWith('__'))
            : [],
          choiceFallback: extractionResult.choiceContractFallback ?? null
        }
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

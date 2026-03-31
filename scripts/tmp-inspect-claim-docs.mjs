import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const claimId = process.argv[2]

if (!claimId) {
  console.error('Usage: node scripts/tmp-inspect-claim-docs.mjs <claimId>')
  process.exit(1)
}

try {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      vin: true,
      status: true,
      source: true,
      createdAt: true
    }
  })

  if (!claim) {
    console.log(JSON.stringify({ claimId, found: false }, null, 2))
    process.exit(0)
  }

  const docs = await prisma.claimDocument.findMany({
    where: { claimId },
    orderBy: { uploadedAt: 'desc' },
    select: {
      id: true,
      claimId: true,
      fileName: true,
      documentType: true,
      matchStatus: true,
      matchNotes: true,
      extractionStatus: true,
      processingStatus: true,
      uploadedAt: true,
      extractedData: true,
      parsedAnchors: true
    }
  })

  const summary = docs.map((d) => {
    const extracted = d.extractedData && typeof d.extractedData === 'object' && !Array.isArray(d.extractedData)
      ? d.extractedData
      : {}
    const anchors = d.parsedAnchors && typeof d.parsedAnchors === 'object' && !Array.isArray(d.parsedAnchors)
      ? d.parsedAnchors
      : {}

    return {
      id: d.id,
      fileName: d.fileName,
      documentType: d.documentType,
      matchStatus: d.matchStatus,
      matchNotes: d.matchNotes,
      extractionStatus: d.extractionStatus,
      processingStatus: d.processingStatus,
      uploadedAt: d.uploadedAt,
      anchors: {
        vin: anchors.vin ?? null,
        contractDate: anchors.contractDate ?? null,
        purchaseDate: anchors.purchaseDate ?? null,
        agreementDate: anchors.agreementDate ?? null,
        mileage: anchors.mileage ?? null
      },
      extracted: {
        vin: extracted.vin ?? null,
        agreementNumber: extracted.agreementNumber ?? null,
        mileageAtSale: extracted.mileageAtSale ?? null,
        vehiclePurchaseDate: extracted.vehiclePurchaseDate ?? null,
        agreementPurchaseDate: extracted.agreementPurchaseDate ?? null,
        fallback: extracted.__choiceContractFallback ?? null,
        evidenceApply: extracted.__evidenceApply ?? null
      }
    }
  })

  console.log(JSON.stringify({ claim, documents: summary }, null, 2))
} finally {
  await prisma.$disconnect()
}

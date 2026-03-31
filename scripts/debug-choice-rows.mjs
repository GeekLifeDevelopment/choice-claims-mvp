import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const rows = await prisma.claimDocument.findMany({
    where: { documentType: 'choice_contract' },
    orderBy: { uploadedAt: 'desc' },
    take: 25,
    select: {
      id: true,
      claimId: true,
      fileName: true,
      matchStatus: true,
      matchNotes: true,
      extractionStatus: true,
      processingStatus: true,
      uploadedAt: true,
      extractedData: true
    }
  })

  const simplified = rows.map((row) => {
    const extracted =
      row.extractedData && typeof row.extractedData === 'object' && !Array.isArray(row.extractedData)
        ? row.extractedData
        : {}

    return {
      id: row.id,
      claimId: row.claimId,
      fileName: row.fileName,
      matchStatus: row.matchStatus,
      extractionStatus: row.extractionStatus,
      processingStatus: row.processingStatus,
      uploadedAt: row.uploadedAt,
      hasVin: Boolean(extracted.vin),
      hasAgreementNumber: Boolean(extracted.agreementNumber),
      hasMileageAtSale:
        extracted.mileageAtSale !== undefined &&
        extracted.mileageAtSale !== null &&
        String(extracted.mileageAtSale).trim().length > 0,
      hasVehiclePurchaseDate: Boolean(extracted.vehiclePurchaseDate),
      hasAgreementPurchaseDate: Boolean(extracted.agreementPurchaseDate),
      fallbackStatus:
        extracted.__choiceContractFallback && typeof extracted.__choiceContractFallback === 'object'
          ? extracted.__choiceContractFallback.status || null
          : null,
      fallbackUsed:
        extracted.__choiceContractFallback &&
        typeof extracted.__choiceContractFallback === 'object' &&
        extracted.__choiceContractFallback.used === true
    }
  })

  console.log(JSON.stringify(simplified, null, 2))
} finally {
  await prisma.$disconnect()
}

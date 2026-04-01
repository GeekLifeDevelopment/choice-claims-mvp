import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const claimId = process.argv[2]
const documentId = process.argv[3] ?? null

if (!claimId) {
  console.error('usage: node scripts/tmp-ticket1-inspect.mjs <claimId> [documentId]')
  process.exit(1)
}

const claim = await prisma.claim.findUnique({
  where: { id: claimId },
  select: {
    id: true,
    claimNumber: true,
    status: true,
    reviewSummaryStatus: true,
    reviewSummaryEnqueuedAt: true,
    reviewSummaryGeneratedAt: true,
    reviewSummaryLastError: true,
    reviewDecision: true,
    vinDataResult: true,
    claimDocuments: {
      where: documentId ? { id: documentId } : undefined,
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        uploadedBy: true,
        documentType: true,
        matchStatus: true,
        processingStatus: true,
        extractionStatus: true,
        extractedAt: true,
        uploadedAt: true,
        extractedData: true
      }
    }
  }
})

if (!claim) {
  console.error('claim_not_found')
  await prisma.$disconnect()
  process.exit(1)
}

const vin = claim.vinDataResult && typeof claim.vinDataResult === 'object' ? claim.vinDataResult : {}
const documentEvidence =
  vin.documentEvidence && typeof vin.documentEvidence === 'object' ? vin.documentEvidence : {}
const provenanceCount =
  documentEvidence.provenance && typeof documentEvidence.provenance === 'object'
    ? Object.keys(documentEvidence.provenance).length
    : 0
const hasAdjudicationResult = Boolean(
  vin.adjudicationResult && typeof vin.adjudicationResult === 'object'
)

const docs = claim.claimDocuments.map((doc) => {
  const apply =
    doc.extractedData &&
    typeof doc.extractedData === 'object' &&
    doc.extractedData.__evidenceApply &&
    typeof doc.extractedData.__evidenceApply === 'object'
      ? doc.extractedData.__evidenceApply
      : null

  return {
    id: doc.id,
    fileName: doc.fileName,
    uploadedBy: doc.uploadedBy,
    documentType: doc.documentType,
    matchStatus: doc.matchStatus,
    processingStatus: doc.processingStatus,
    extractionStatus: doc.extractionStatus,
    extractedAt: doc.extractedAt,
    uploadedAt: doc.uploadedAt,
    evidenceApply: apply
  }
})

console.log(
  JSON.stringify(
    {
      claim: {
        id: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        reviewDecision: claim.reviewDecision,
        reviewSummaryStatus: claim.reviewSummaryStatus,
        reviewSummaryEnqueuedAt: claim.reviewSummaryEnqueuedAt,
        reviewSummaryGeneratedAt: claim.reviewSummaryGeneratedAt,
        reviewSummaryLastError: claim.reviewSummaryLastError,
        hasAdjudicationResult,
        provenanceCount,
        lastAppliedAt: documentEvidence.lastAppliedAt ?? null
      },
      documents: docs
    },
    null,
    2
  )
)

await prisma.$disconnect()

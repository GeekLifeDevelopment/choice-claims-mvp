import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const claimIds = [
  'cmnexwmrq0000jr09m8c9cwqr',
  'cmng34pks0000lb09b5lefrkm',
  'cmnddo7yl000ljp091qf5aob8'
]

const rows = await prisma.claim.findMany({
  where: { id: { in: claimIds } },
  select: {
    id: true,
    claimNumber: true,
    reviewSummaryStatus: true,
    reviewSummaryGeneratedAt: true,
    reviewSummaryEnqueuedAt: true,
    updatedAt: true,
    vinDataResult: true
  }
})

for (const c of rows) {
  const vin = c.vinDataResult && typeof c.vinDataResult === 'object' ? c.vinDataResult : {}
  const adjudication =
    vin && typeof vin === 'object' && vin.adjudicationResult && typeof vin.adjudicationResult === 'object'
      ? vin.adjudicationResult
      : null
  const evidence =
    vin && typeof vin === 'object' && vin.documentEvidence && typeof vin.documentEvidence === 'object'
      ? vin.documentEvidence
      : {}
  const provenanceCount =
    evidence && typeof evidence === 'object' && evidence.provenance && typeof evidence.provenance === 'object'
      ? Object.keys(evidence.provenance).length
      : 0

  console.log(
    JSON.stringify(
      {
        id: c.id,
        claimNumber: c.claimNumber,
        reviewSummaryStatus: c.reviewSummaryStatus,
        reviewSummaryGeneratedAt: c.reviewSummaryGeneratedAt,
        reviewSummaryEnqueuedAt: c.reviewSummaryEnqueuedAt,
        updatedAt: c.updatedAt,
        hasAdjudicationResult: Boolean(adjudication),
        provenanceCount
      },
      null,
      2
    )
  )
}

await prisma.$disconnect()

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const claims = await prisma.claim.findMany({
    where: {
      reviewSummaryStatus: 'Generated'
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      claimNumber: true,
      reviewRuleFlags: true,
      vinDataResult: true,
      attachments: {
        select: { id: true }
      }
    }
  })

  const candidates = claims.map((claim) => ({
    id: claim.id,
    claimNumber: claim.claimNumber,
    hasRuleFlags: Array.isArray(claim.reviewRuleFlags) && claim.reviewRuleFlags.length > 0,
    hasProviderData: claim.vinDataResult !== null,
    attachmentCount: claim.attachments.length
  }))

  const match = candidates.find(
    (claim) => claim.hasRuleFlags && claim.hasProviderData && claim.attachmentCount > 0
  )

  console.log(JSON.stringify({ match, checked: candidates.length }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

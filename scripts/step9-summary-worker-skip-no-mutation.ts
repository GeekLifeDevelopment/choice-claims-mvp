import { prisma } from '../lib/prisma'
import { processReviewSummaryJob } from '../lib/review/process-review-summary-job'

const CLAIM_ID = 'cmmz9suwb0000fj49ssg0dawd'

async function main() {
  const before = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      status: true,
      reviewDecision: true,
      reviewSummaryStatus: true,
      reviewSummaryText: true,
      reviewSummaryGeneratedAt: true,
      reviewSummaryJobId: true,
      reviewSummaryVersion: true,
      reviewSummaryLastError: true,
      updatedAt: true
    }
  })

  if (!before) throw new Error('Claim not found before check')

  const result = await processReviewSummaryJob(CLAIM_ID)

  const after = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      status: true,
      reviewDecision: true,
      reviewSummaryStatus: true,
      reviewSummaryText: true,
      reviewSummaryGeneratedAt: true,
      reviewSummaryJobId: true,
      reviewSummaryVersion: true,
      reviewSummaryLastError: true,
      updatedAt: true
    }
  })

  if (!after) throw new Error('Claim not found after check')

  const changedKeys = Object.keys(before).filter((key) => {
    if (key === 'updatedAt') return false
    const a = (before as Record<string, unknown>)[key]
    const b = (after as Record<string, unknown>)[key]
    return JSON.stringify(a) !== JSON.stringify(b)
  })

  console.log(JSON.stringify({ result, before, after, changedKeys }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

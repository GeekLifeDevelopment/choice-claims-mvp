import { config as loadEnv } from 'dotenv'
import { prisma } from '../lib/prisma'

loadEnv({ path: '.env.local' })
loadEnv()

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function hasAnyAdjudication(vinDataResult: unknown): boolean {
  const vinData = asRecord(vinDataResult)
  const direct = asRecord(vinData.adjudicationResult)
  const reviewSummaryResult = asRecord(vinData.reviewSummaryResult)
  const reviewSummaryAdjudication = asRecord(reviewSummaryResult.adjudicationResult)
  const snapshot = asRecord(vinData.claimReviewSnapshot)
  const snapshotAdjudication = asRecord(snapshot.adjudicationResult)

  return (
    Object.keys(direct).length > 0 ||
    Object.keys(reviewSummaryAdjudication).length > 0 ||
    Object.keys(snapshotAdjudication).length > 0
  )
}

async function main() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const rows = await prisma.claim.findMany({
    where: {
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      claimNumber: true,
      createdAt: true,
      status: true,
      reviewDecision: true,
      reviewSummaryStatus: true,
      reviewSummaryText: true,
      reviewSummaryEnqueuedAt: true,
      reviewSummaryGeneratedAt: true,
      reviewSummaryLastError: true,
      vinDataResult: true
    }
  })

  const failing = rows
    .filter((claim) => !hasAnyAdjudication(claim.vinDataResult))
    .map((claim) => ({
      id: claim.id,
      claimNumber: claim.claimNumber,
      createdAt: claim.createdAt.toISOString(),
      status: claim.status,
      reviewDecision: claim.reviewDecision,
      reviewSummaryStatus: claim.reviewSummaryStatus,
      hasSummaryText: Boolean(claim.reviewSummaryText),
      reviewSummaryEnqueuedAt: claim.reviewSummaryEnqueuedAt
        ? claim.reviewSummaryEnqueuedAt.toISOString()
        : null,
      reviewSummaryGeneratedAt: claim.reviewSummaryGeneratedAt
        ? claim.reviewSummaryGeneratedAt.toISOString()
        : null,
      reviewSummaryLastError: claim.reviewSummaryLastError
    }))

  console.log(
    JSON.stringify(
      {
        scanned: rows.length,
        missingAdjudicationCount: failing.length,
        failing: failing.slice(0, 50)
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

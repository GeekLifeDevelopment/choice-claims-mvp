import { prisma } from '../lib/prisma'
import { processReviewSummaryJob } from '../lib/review/process-review-summary-job'

const CLAIM_ID = 'cmnevwwok0000l50916sj0gzd'

async function main() {
  const requestedAt = new Date().toISOString()

  const before = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      claimNumber: true,
      reviewSummaryStatus: true,
      reviewSummaryGeneratedAt: true,
      vinDataResult: true
    }
  })

  if (!before) {
    throw new Error('Claim not found')
  }

  await prisma.claim.update({
    where: { id: CLAIM_ID },
    data: {
      reviewSummaryStatus: 'Queued',
      reviewSummaryEnqueuedAt: new Date(requestedAt)
    }
  })

  const beforeAdjudication =
    before.vinDataResult && typeof before.vinDataResult === 'object'
      ? ((before.vinDataResult as Record<string, unknown>).adjudicationResult as Record<string, unknown> | undefined)
      : undefined

  const result = await processReviewSummaryJob(CLAIM_ID, {
    source: 'manual',
    persistFailureStatus: true,
    requestedAt
  })

  const after = await prisma.claim.findUnique({
    where: { id: CLAIM_ID },
    select: {
      id: true,
      claimNumber: true,
      reviewSummaryStatus: true,
      reviewSummaryGeneratedAt: true,
      vinDataResult: true
    }
  })

  const afterAdjudication =
    after?.vinDataResult && typeof after.vinDataResult === 'object'
      ? ((after.vinDataResult as Record<string, unknown>).adjudicationResult as Record<string, unknown> | undefined)
      : undefined

  const beforeQuestions = Array.isArray(beforeAdjudication?.questions)
    ? (beforeAdjudication?.questions as Array<Record<string, unknown>>)
    : []
  const afterQuestions = Array.isArray(afterAdjudication?.questions)
    ? (afterAdjudication?.questions as Array<Record<string, unknown>>)
    : []

  const summary = {
    result,
    before: {
      reviewSummaryStatus: before.reviewSummaryStatus,
      reviewSummaryGeneratedAt: before.reviewSummaryGeneratedAt,
      adjudicationGeneratedAt: beforeAdjudication?.generatedAt ?? null,
      totalScore: beforeAdjudication?.totalScore ?? null,
      overallCompleteness: beforeAdjudication?.overallCompleteness ?? null,
      overallConfidence: beforeAdjudication?.overallConfidence ?? null,
      warrantySupportCount: beforeQuestions.filter((q) => q.id === 'warranty_support').length,
      obdCodesCount: beforeQuestions.filter((q) => q.id === 'obd_codes').length
    },
    after: {
      reviewSummaryStatus: after?.reviewSummaryStatus ?? null,
      reviewSummaryGeneratedAt: after?.reviewSummaryGeneratedAt ?? null,
      adjudicationGeneratedAt: afterAdjudication?.generatedAt ?? null,
      totalScore: afterAdjudication?.totalScore ?? null,
      overallCompleteness: afterAdjudication?.overallCompleteness ?? null,
      overallConfidence: afterAdjudication?.overallConfidence ?? null,
      warrantySupportCount: afterQuestions.filter((q) => q.id === 'warranty_support').length,
      warrantySupport: afterQuestions.filter((q) => q.id === 'warranty_support'),
      obdCodesCount: afterQuestions.filter((q) => q.id === 'obd_codes').length,
      obdCodes: afterQuestions.filter((q) => q.id === 'obd_codes')
    }
  }

  console.log(JSON.stringify(summary, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { buildClaimEvaluationInput } from '../lib/review/claim-evaluation-input'
import { buildAdjudicationResult } from '../lib/review/adjudication-result'

loadEnv({ path: '.env.local' })
loadEnv()

const prisma = new PrismaClient()

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
  const candidates = await prisma.claim.findMany({
    where: {
      reviewSummaryStatus: 'Generated',
      reviewSummaryText: {
        not: null,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      vin: true,
      claimantName: true,
      claimantEmail: true,
      claimantPhone: true,
      vinDataResult: true,
      vinDataProvider: true,
      vinDataFetchedAt: true,
      vinLookupAttemptCount: true,
      vinLookupLastError: true,
      vinLookupLastFailedAt: true,
      reviewSummaryText: true,
      attachments: {
        select: {
          filename: true,
          mimeType: true,
        },
      },
    },
  })

  let scanned = 0
  let alreadyHad = 0
  let updated = 0
  let failed = 0
  const updatedClaims: string[] = []
  const failedClaims: Array<{ claimNumber: string; error: string }> = []

  for (const claim of candidates) {
    scanned += 1

    if (hasAnyAdjudication(claim.vinDataResult)) {
      alreadyHad += 1
      continue
    }

    try {
      const evaluationInput = buildClaimEvaluationInput({
        id: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        source: claim.source,
        vin: claim.vin,
        claimantName: claim.claimantName,
        claimantEmail: claim.claimantEmail,
        claimantPhone: claim.claimantPhone,
        vinDataResult: claim.vinDataResult,
        vinDataProvider: claim.vinDataProvider,
        vinDataFetchedAt: claim.vinDataFetchedAt,
        vinLookupAttemptCount: claim.vinLookupAttemptCount,
        vinLookupLastError: claim.vinLookupLastError,
        vinLookupLastFailedAt: claim.vinLookupLastFailedAt,
        attachments: claim.attachments,
      })

      const adjudicationResult = buildAdjudicationResult({
        evaluationInput,
        vinDataResult: claim.vinDataResult,
        reviewSummaryText: claim.reviewSummaryText ?? '',
        aiFindings: [],
      })

      const mergedVinDataResult = {
        ...asRecord(claim.vinDataResult),
        adjudicationResult,
      }

      await prisma.claim.update({
        where: { id: claim.id },
        data: {
          vinDataResult: mergedVinDataResult,
        },
      })

      updated += 1
      updatedClaims.push(claim.claimNumber)
    } catch (error) {
      failed += 1
      failedClaims.push({
        claimNumber: claim.claimNumber,
        error: error instanceof Error ? error.message : 'unknown_error',
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        scanned,
        alreadyHad,
        updated,
        failed,
        updatedClaims: updatedClaims.slice(0, 25),
        failedClaims: failedClaims.slice(0, 10),
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

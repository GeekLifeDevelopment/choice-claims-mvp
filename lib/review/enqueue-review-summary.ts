import { Prisma } from '@prisma/client'
import { ClaimStatus } from '../domain/claims'
import { prisma } from '../prisma'
import { buildReviewSummaryJobPayload } from '../queue/build-review-summary-job'
import { enqueueReviewSummaryJob } from '../queue/enqueue-review-summary-job'
import type { ReviewSummaryJobSource } from '../queue/job-payloads'
import { isClaimLockedForProcessing } from './claim-lock'

const REVIEW_SUMMARY_VERSION = 'sprint4-ticket5-v1'

export const REVIEW_SUMMARY_STATUS = {
  NotRequested: 'NotRequested',
  Queued: 'Queued',
  Generated: 'Generated',
  Failed: 'Failed'
} as const

export type ReviewSummaryStatus = (typeof REVIEW_SUMMARY_STATUS)[keyof typeof REVIEW_SUMMARY_STATUS]

export type EnqueueReviewSummaryIneligibleReason =
  | 'not_found'
  | 'locked_final_decision'
  | 'not_ready_for_ai'
  | 'missing_rule_evaluation'
  | 'already_queued'

export type EnqueueReviewSummaryForClaimResult = {
  enqueued: boolean
  claimId: string
  reason: EnqueueReviewSummaryIneligibleReason | 'enqueue_failed' | null
  queueName?: string
  jobName?: string
  jobId?: string
}

export async function enqueueReviewSummaryForClaim(
  claimId: string,
  source: ReviewSummaryJobSource = 'rules_ready'
): Promise<EnqueueReviewSummaryForClaimResult> {
  console.info('[summary] queue check start', {
    claimId,
    source
  })

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      reviewDecision: true,
      status: true,
      reviewRuleEvaluatedAt: true,
      reviewSummaryStatus: true
    }
  })

  if (!claim) {
    console.warn('[summary] queue skipped claim missing', {
      claimId,
      source
    })

    return {
      enqueued: false,
      claimId,
      reason: 'not_found'
    }
  }

  if (isClaimLockedForProcessing(claim)) {
    console.warn('[summary] queue skipped locked claim', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      reviewDecision: claim.reviewDecision
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'locked_final_decision'
    }
  }

  if (claim.status !== ClaimStatus.ReadyForAI) {
    console.warn('[summary] queue skipped not-ready status', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'not_ready_for_ai'
    }
  }

  if (!claim.reviewRuleEvaluatedAt) {
    console.warn('[summary] queue skipped missing rule evaluation', {
      claimId: claim.id,
      claimNumber: claim.claimNumber
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'missing_rule_evaluation'
    }
  }

  if (claim.reviewSummaryStatus === REVIEW_SUMMARY_STATUS.Queued) {
    console.info('[summary] queue skipped already queued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'already_queued'
    }
  }

  const queuedAt = new Date()
  const transitioned = await prisma.claim.updateMany({
    where: {
      id: claim.id,
      OR: [
        { reviewSummaryStatus: null },
        {
          reviewSummaryStatus: {
            not: REVIEW_SUMMARY_STATUS.Queued
          }
        }
      ]
    },
    data: {
      reviewSummaryStatus: REVIEW_SUMMARY_STATUS.Queued,
      reviewSummaryEnqueuedAt: queuedAt,
      reviewSummaryVersion: REVIEW_SUMMARY_VERSION,
      reviewSummaryLastError: null
    }
  })

  if (transitioned.count === 0) {
    console.info('[summary] queue skipped transition race', {
      claimId: claim.id,
      claimNumber: claim.claimNumber
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'already_queued'
    }
  }

  try {
    const payload = buildReviewSummaryJobPayload({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      source
    })

    const enqueued = await enqueueReviewSummaryJob(payload)

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        reviewSummaryJobId: enqueued.jobId ?? null
      }
    })

    console.info('[summary] queued', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId
    })

    return {
      enqueued: true,
      claimId: claim.id,
      reason: null,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to enqueue review summary generation job'

    console.error('[summary] queue failed', {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      error: message
    })

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        reviewSummaryStatus: REVIEW_SUMMARY_STATUS.Failed,
        reviewSummaryLastError: message,
        reviewSummaryVersion: REVIEW_SUMMARY_VERSION
      }
    })

    return {
      enqueued: false,
      claimId: claim.id,
      reason: 'enqueue_failed'
    }
  }
}

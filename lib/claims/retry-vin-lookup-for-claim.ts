import { ClaimStatus } from '../domain/claims'
import { prisma } from '../prisma'
import { enqueueVinLookupJob } from '../queue/enqueue-vin-lookup-job'
import { logVinLookupRequeuedAudit } from '../audit/intake-audit-log'

const RETRYABLE_STATUSES = new Set<string>([ClaimStatus.ProviderFailed, ClaimStatus.ProcessingError])

export type RetryVinLookupForClaimResult =
  | {
      ok: true
      claimId: string
      claimNumber: string
      previousStatus: ClaimStatus.ProviderFailed | ClaimStatus.ProcessingError
      newStatus: ClaimStatus.AwaitingVinData
      queueName: string
      jobName: string
      jobId?: string
    }
  | {
      ok: false
      code: 'claim_not_found' | 'status_not_retryable' | 'status_changed' | 'enqueue_failed'
      claimId?: string
      claimNumber?: string
      message: string
    }

export async function retryVinLookupForClaim(claimId: string): Promise<RetryVinLookupForClaimResult> {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      source: true,
      vin: true
    }
  })

  if (!claim) {
    return {
      ok: false,
      code: 'claim_not_found',
      message: 'Claim not found'
    }
  }

  if (!RETRYABLE_STATUSES.has(claim.status)) {
    return {
      ok: false,
      code: 'status_not_retryable',
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      message: `Claim status ${claim.status} is not retryable`
    }
  }

  const previousStatus = claim.status as ClaimStatus.ProviderFailed | ClaimStatus.ProcessingError

  const updated = await prisma.claim.updateMany({
    where: {
      id: claim.id,
      status: previousStatus
    },
    data: {
      status: ClaimStatus.AwaitingVinData,
      vinLookupRetryRequestedAt: new Date()
    }
  })

  if (updated.count !== 1) {
    return {
      ok: false,
      code: 'status_changed',
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      message: 'Claim status changed during retry request; enqueue skipped'
    }
  }

  try {
    const enqueued = await enqueueVinLookupJob({
      claimId: claim.id,
      vin: claim.vin ?? null,
      source: claim.source || 'admin_manual_retry',
      requestedAt: new Date().toISOString(),
      claimNumber: claim.claimNumber
    })

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        vinLookupLastError: null,
        vinLookupLastFailedAt: null
      }
    })

    await logVinLookupRequeuedAudit({
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId,
      source: claim.source || 'admin_manual_retry',
      vin: claim.vin,
      previousStatus,
      newStatus: ClaimStatus.AwaitingVinData,
      reason: 'manual_retry'
    })

    return {
      ok: true,
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      previousStatus,
      newStatus: ClaimStatus.AwaitingVinData,
      queueName: enqueued.queueName,
      jobName: enqueued.jobName,
      jobId: enqueued.jobId
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown retry enqueue error'

    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        status: previousStatus,
        vinLookupLastError: `Manual retry enqueue failed: ${errorMessage}`,
        vinLookupLastFailedAt: new Date()
      }
    })

    return {
      ok: false,
      code: 'enqueue_failed',
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      message: errorMessage
    }
  }
}

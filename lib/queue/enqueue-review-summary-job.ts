import { JOB_NAMES } from './job-names'
import type { ReviewSummaryJobPayload } from './job-payloads'
import { getQueueNameForJob } from './contracts'
import { getQueue } from './get-queue'

const REVIEW_SUMMARY_JOB_ATTEMPTS = 3
const REVIEW_SUMMARY_JOB_BACKOFF_MS = 5_000

export type EnqueueReviewSummaryJobResult = {
  queueName: string
  jobName: string
  jobId: string | undefined
}

export async function enqueueReviewSummaryJob(
  payload: ReviewSummaryJobPayload
): Promise<EnqueueReviewSummaryJobResult> {
  const jobName = JOB_NAMES.GENERATE_REVIEW_SUMMARY
  const queueName = getQueueNameForJob(jobName)
  const queue = getQueue(queueName)

  console.info('[summary] enqueue start', {
    queueName,
    jobName,
    claimId: payload.claimId,
    claimNumber: payload.claimNumber
  })

  try {
    const job = await queue.add(jobName, payload, {
      attempts: REVIEW_SUMMARY_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: REVIEW_SUMMARY_JOB_BACKOFF_MS
      }
    })

    console.info('[summary] enqueue success', {
      queueName,
      jobName,
      jobId: job.id?.toString(),
      claimId: payload.claimId,
      claimNumber: payload.claimNumber
    })

    return {
      queueName,
      jobName,
      jobId: job.id?.toString()
    }
  } catch (error) {
    console.error('[summary] enqueue failed', {
      queueName,
      jobName,
      claimId: payload.claimId,
      claimNumber: payload.claimNumber,
      error
    })

    throw error
  } finally {
    await queue.close()
  }
}

import { JOB_NAMES } from './job-names'
import type { ReviewSummaryJobPayload } from './job-payloads'
import { getQueueNameForJob } from './contracts'
import { getQueue } from './get-queue'

const REVIEW_SUMMARY_JOB_ATTEMPTS = 3

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

  try {
    const job = await queue.add(jobName, payload, {
      attempts: REVIEW_SUMMARY_JOB_ATTEMPTS
    })

    return {
      queueName,
      jobName,
      jobId: job.id?.toString()
    }
  } finally {
    await queue.close()
  }
}

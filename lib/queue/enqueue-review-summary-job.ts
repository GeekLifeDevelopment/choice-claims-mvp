import { JOB_NAMES } from './job-names'
import type { ReviewSummaryJobPayload } from './job-payloads'
import { getQueueNameForJob } from './contracts'
import { getQueue } from './get-queue'

const REVIEW_SUMMARY_JOB_ATTEMPTS = 3
const REVIEW_SUMMARY_JOB_BACKOFF_MS = 5_000
const REVIEW_SUMMARY_IN_FLIGHT_JOB_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children'
])

function buildReviewSummaryJobId(payload: ReviewSummaryJobPayload): string {
  return `${JOB_NAMES.GENERATE_REVIEW_SUMMARY}__${payload.claimId}`
}

export type EnqueueReviewSummaryJobResult = {
  queueName: string
  jobName: string
  jobId: string | undefined
  reusedInFlight?: boolean
}

export async function enqueueReviewSummaryJob(
  payload: ReviewSummaryJobPayload
): Promise<EnqueueReviewSummaryJobResult> {
  const jobName = JOB_NAMES.GENERATE_REVIEW_SUMMARY
  const queueName = getQueueNameForJob(jobName)
  const queue = getQueue(queueName)
  const jobId = buildReviewSummaryJobId(payload)

  console.info('[queue_enqueue] start', {
    stage: 'enqueue',
    action: 'start',
    queueName,
    jobName,
    jobId,
    claimId: payload.claimId,
    claimNumber: payload.claimNumber
  })

  try {
    const existingJob = await queue.getJob(jobId)
    if (existingJob) {
      const existingState = await existingJob.getState()

      if (REVIEW_SUMMARY_IN_FLIGHT_JOB_STATES.has(existingState)) {
        await existingJob.updateData(payload)

        console.info('[queue_enqueue] duplicate_in_flight', {
          stage: 'enqueue',
          action: 'skip',
          queueName,
          jobName,
          jobId,
          existingState,
          claimId: payload.claimId,
          claimNumber: payload.claimNumber
        })

        return {
          queueName,
          jobName,
          jobId: existingJob.id?.toString(),
          reusedInFlight: true
        }
      }

      // Replace stale completed/failed jobs so meaningful refreshes can enqueue a new run.
      await existingJob.remove()

      console.info('[queue_enqueue] replaced_stale_job', {
        stage: 'enqueue',
        action: 'replace',
        queueName,
        jobName,
        jobId,
        existingState,
        claimId: payload.claimId,
        claimNumber: payload.claimNumber
      })
    }

    const job = await queue.add(jobName, payload, {
      jobId,
      attempts: REVIEW_SUMMARY_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: REVIEW_SUMMARY_JOB_BACKOFF_MS
      }
    })

    console.info('[queue_enqueue] success', {
      stage: 'enqueue',
      action: 'add_job',
      queueName,
      jobName,
      jobId: job.id?.toString(),
      claimId: payload.claimId,
      claimNumber: payload.claimNumber
    })

    return {
      queueName,
      jobName,
      jobId: job.id?.toString(),
      reusedInFlight: false
    }
  } catch (error) {
    console.error('[queue_enqueue] failed', {
      stage: 'enqueue',
      action: 'add_job',
      queueName,
      jobName,
      jobId,
      claimId: payload.claimId,
      claimNumber: payload.claimNumber,
      error
    })

    throw error
  } finally {
    await queue.close()
  }
}

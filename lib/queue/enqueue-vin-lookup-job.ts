import { JOB_NAMES } from './job-names'
import type { VinLookupJobPayload } from './job-payloads'
import { getQueueNameForJob } from './contracts'
import { getQueue } from './get-queue'
import {
  VIN_LOOKUP_BACKOFF_MS,
  VIN_LOOKUP_BACKOFF_TYPE,
  VIN_LOOKUP_MAX_ATTEMPTS
} from './vin-lookup-job-options'

const VIN_LOOKUP_IN_FLIGHT_JOB_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children'
])

function buildVinLookupJobId(payload: VinLookupJobPayload): string {
  return `${JOB_NAMES.LOOKUP_VIN_DATA}__${payload.claimId}`
}

export type EnqueueVinLookupJobResult = {
  queueName: string
  jobName: string
  jobId: string | undefined
}

export async function enqueueVinLookupJob(payload: VinLookupJobPayload): Promise<EnqueueVinLookupJobResult> {
  const jobName = JOB_NAMES.LOOKUP_VIN_DATA
  const queueName = getQueueNameForJob(jobName)
  const queue = getQueue(queueName)
  const jobId = buildVinLookupJobId(payload)

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

      if (VIN_LOOKUP_IN_FLIGHT_JOB_STATES.has(existingState)) {
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
          jobId: existingJob.id?.toString()
        }
      }

      await existingJob.remove()

      console.info('[queue_enqueue] removed_terminal_job', {
        stage: 'enqueue',
        action: 'replace_job',
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
      attempts: VIN_LOOKUP_MAX_ATTEMPTS,
      backoff: {
        type: VIN_LOOKUP_BACKOFF_TYPE,
        delay: VIN_LOOKUP_BACKOFF_MS
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
      jobId: job.id?.toString()
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

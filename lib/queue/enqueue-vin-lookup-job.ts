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
  return `${JOB_NAMES.LOOKUP_VIN_DATA}:${payload.claimId}`
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

  console.info('[enqueue] vin lookup enqueue start', {
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
        console.info('[enqueue] vin lookup enqueue skipped duplicate in-flight job', {
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
    }

    const job = await queue.add(jobName, payload, {
      jobId,
      attempts: VIN_LOOKUP_MAX_ATTEMPTS,
      backoff: {
        type: VIN_LOOKUP_BACKOFF_TYPE,
        delay: VIN_LOOKUP_BACKOFF_MS
      }
    })

    console.info('[enqueue] vin lookup enqueue success', {
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
    console.error('[enqueue] vin lookup enqueue failed', {
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

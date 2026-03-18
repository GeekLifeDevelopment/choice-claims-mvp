import { JOB_NAMES } from './job-names'
import type { VinLookupJobPayload } from './job-payloads'
import { getQueueNameForJob } from './contracts'
import { getQueue } from './get-queue'
import { VIN_LOOKUP_BACKOFF_MS, VIN_LOOKUP_MAX_ATTEMPTS } from './vin-lookup-job-options'

export type EnqueueVinLookupJobResult = {
  queueName: string
  jobName: string
  jobId: string | undefined
}

export async function enqueueVinLookupJob(payload: VinLookupJobPayload): Promise<EnqueueVinLookupJobResult> {
  const jobName = JOB_NAMES.LOOKUP_VIN_DATA
  const queueName = getQueueNameForJob(jobName)
  const queue = getQueue(queueName)

  try {
    const job = await queue.add(jobName, payload, {
      attempts: VIN_LOOKUP_MAX_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: VIN_LOOKUP_BACKOFF_MS
      }
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

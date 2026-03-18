import { config as loadEnv } from 'dotenv'
import { Worker, type Job } from 'bullmq'
import { getQueueRuntimeConfig } from '../lib/queue/config'
import { JOB_NAMES } from '../lib/queue/job-names'
import type { VinLookupJobPayload } from '../lib/queue/job-payloads'
import { QUEUE_NAMES } from '../lib/queue/queue-names'
import { getVinDataProvider } from '../lib/providers/get-vin-provider'

// Standalone worker does not get Next.js env loading, so load local env explicitly.
loadEnv({ path: '.env.local' })
loadEnv()

function log(message: string, details?: unknown) {
  if (details !== undefined) {
    console.info(`[WORKER] ${message}`, details)
    return
  }

  console.info(`[WORKER] ${message}`)
}

function logError(message: string, details?: unknown) {
  if (details !== undefined) {
    console.error(`[WORKER] ${message}`, details)
    return
  }

  console.error(`[WORKER] ${message}`)
}

async function run() {
  const { connection, prefix } = getQueueRuntimeConfig()

  log('starting', {
    queueName: QUEUE_NAMES.VIN_DATA,
    prefix
  })

  const worker = new Worker(
    QUEUE_NAMES.VIN_DATA,
    async (job: Job) => {
      log('job received', {
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job.name,
        jobId: job.id,
        payload: job.data
      })

      if (job.name === JOB_NAMES.LOOKUP_VIN_DATA) {
        const payload = job.data as VinLookupJobPayload

        if (!payload.vin) {
          log('vin missing; skipping provider lookup', {
            jobName: job.name,
            jobId: job.id,
            claimId: payload.claimId,
            claimNumber: payload.claimNumber
          })
        } else {
          const provider = getVinDataProvider()

          log('provider selected', {
            provider: provider.name,
            jobName: job.name,
            jobId: job.id,
            claimId: payload.claimId,
            claimNumber: payload.claimNumber,
            vin: payload.vin
          })

          const providerResult = await provider.lookupVinData(payload.vin)

          log('provider result', {
            provider: provider.name,
            jobName: job.name,
            jobId: job.id,
            claimId: payload.claimId,
            claimNumber: payload.claimNumber,
            result: providerResult
          })
        }
      }

      return {
        ok: true
      }
    },
    {
      connection,
      prefix
    }
  )

  worker.on('ready', () => {
    log('connected to redis', {
      queueName: QUEUE_NAMES.VIN_DATA,
      prefix
    })
  })

  worker.on('completed', (job) => {
    log('job completed', {
      jobName: job.name,
      jobId: job.id
    })
  })

  worker.on('failed', (job, error) => {
    logError('job failed', {
      jobName: job?.name,
      jobId: job?.id,
      error: error.message
    })
  })

  const shutdown = async (signal: string) => {
    log(`shutdown requested (${signal})`)

    try {
      await worker.close()
      log('worker closed')
      process.exit(0)
    } catch (error) {
      logError('worker close failed', error)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

void run().catch((error) => {
  logError('startup failed', error)
  process.exit(1)
})

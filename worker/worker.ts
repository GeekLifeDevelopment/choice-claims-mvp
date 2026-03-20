import { config as loadEnv } from 'dotenv'
import { Prisma } from '@prisma/client'
import { Worker, type Job } from 'bullmq'
import {
  logVinDataFetchedAudit,
  logVinDataFetchFailedAudit
} from '../lib/audit/intake-audit-log'
import { ClaimStatus } from '../lib/domain/claims'
import { prisma } from '../lib/prisma'
import { getQueueRuntimeConfig } from '../lib/queue/config'
import { JOB_NAMES } from '../lib/queue/job-names'
import type { VinLookupJobPayload } from '../lib/queue/job-payloads'
import { QUEUE_NAMES } from '../lib/queue/queue-names'
import { evaluateAndStoreClaimRules } from '../lib/review/evaluate-and-store-claim-rules'
import {
  getAutoCheck429RetryDelayMs,
  isAutoCheckSandboxRateLimitMitigationEnabled,
  isRateLimitedProviderFailure,
  resolveVinLookupBackoffStrategyDelay
} from '../lib/queue/vin-lookup-job-options'
import { getVinDataProvider } from '../lib/providers/get-vin-provider'
import { isProviderLookupError } from '../lib/providers/provider-error'

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

function asOptionalJsonField(
  key: string,
  value: Prisma.InputJsonValue | null | undefined
): Record<string, Prisma.InputJsonValue> {
  if (value === null || value === undefined) {
    return {}
  }

  return {
    [key]: value
  }
}

function isRateLimitedProviderLookupError(error: unknown): boolean {
  return isProviderLookupError(error) && error.status === 429 && error.reason === 'http_429_rate_limited'
}

async function evaluateClaimRulesBestEffort(claimId: string, context: string): Promise<void> {
  try {
    const evaluation = await evaluateAndStoreClaimRules(claimId)

    if (!evaluation) {
      logError('rule evaluation skipped; claim not found', {
        claimId,
        context
      })
      return
    }

    log('rule evaluation persisted', {
      claimId,
      context,
      evaluatedAt: evaluation.evaluatedAt,
      flagCount: evaluation.result.flags.length,
      error: evaluation.error
    })
  } catch (error) {
    logError('rule evaluation failed', {
      claimId,
      context,
      error
    })
  }
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
      const attemptsAllowed =
        typeof job.opts.attempts === 'number' && Number.isFinite(job.opts.attempts) && job.opts.attempts > 0
          ? job.opts.attempts
          : 1
      const attemptsMade = job.attemptsMade + 1

      log('job received', {
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job.name,
        jobId: job.id,
        payload: job.data,
        attemptsMade,
        attemptsAllowed
      })

      if (job.name !== JOB_NAMES.LOOKUP_VIN_DATA) {
        const message = `Unsupported job name: ${job.name}`
        logError(message, {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobId: job.id,
          payload: job.data
        })

        throw new Error(message)
      }

      const payload = job.data as VinLookupJobPayload
      const claim = await prisma.claim.findUnique({
        where: { id: payload.claimId },
        select: {
          id: true,
          claimNumber: true,
          status: true,
          source: true,
          vin: true
        }
      })

      if (!claim) {
        logError('claim not found for job', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: payload.claimId,
          claimNumber: payload.claimNumber,
          attemptsMade,
          attemptsAllowed
        })

        throw new Error(`Claim not found for claimId=${payload.claimId}`)
      }

      await prisma.claim.update({
        where: { id: claim.id },
        data: {
          vinLookupAttemptCount: attemptsMade,
          vinLookupLastJobId: job.id?.toString(),
          vinLookupLastJobName: job.name,
          vinLookupLastQueueName: QUEUE_NAMES.VIN_DATA
        }
      })

      log('claim loaded', {
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job.name,
        jobId: job.id,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        attemptsMade,
        attemptsAllowed
      })

      const vinFromPayload = payload.vin?.trim() || null
      const vinFromClaim = claim.vin?.trim() || null
      const vin = vinFromPayload ?? vinFromClaim

      if (!vin) {
        const errorMessage = 'VIN missing from job payload and claim record'

        await prisma.claim.update({
          where: { id: claim.id },
          data: {
            status: ClaimStatus.ProviderFailed,
            vinLookupLastError: errorMessage,
            vinLookupLastFailedAt: new Date()
          }
        })

        log('claim status updated for missing vin', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: ClaimStatus.ProviderFailed,
          attemptsMade,
          attemptsAllowed
        })

        await evaluateClaimRulesBestEffort(claim.id, 'worker_missing_vin_failed')

        const failedAuditResult = await logVinDataFetchFailedAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id?.toString(),
          attemptsMade,
          attemptsAllowed,
          source: claim.source ?? payload.source,
          vin,
          reason: 'vin_missing',
          errorMessage
        })

        if (failedAuditResult.ok) {
          log('audit log written', {
            action: 'vin_data_fetch_failed',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            auditLogId: failedAuditResult.auditLogId
          })
        } else {
          logError('audit log failed', {
            action: 'vin_data_fetch_failed',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            error: failedAuditResult.error
          })
        }

        log('vin missing; skipping provider lookup', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          attemptsMade,
          attemptsAllowed
        })

        return {
          ok: true,
          skipped: true
        }
      }

      let providerName: string | undefined

      try {
        const provider = getVinDataProvider()
        providerName = provider.name

        log('provider selected', {
          provider: provider.name,
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          vin,
          attemptsMade,
          attemptsAllowed
        })

        const providerResult = await provider.lookupVinData(vin)

        const persistedVinDataResult: Prisma.InputJsonObject = {
          vin: providerResult.vin,
          provider: providerResult.provider,
          ...asOptionalJsonField('year', providerResult.year),
          ...asOptionalJsonField('make', providerResult.make),
          ...asOptionalJsonField('model', providerResult.model),
          ...asOptionalJsonField('trim', providerResult.trim),
          ...asOptionalJsonField('vehicleClass', providerResult.vehicleClass),
          ...asOptionalJsonField('country', providerResult.country),
          ...asOptionalJsonField('bodyStyle', providerResult.bodyStyle),
          ...asOptionalJsonField('doors', providerResult.doors),
          ...asOptionalJsonField('drivetrain', providerResult.drivetrain),
          ...asOptionalJsonField('transmissionType', providerResult.transmissionType),
          ...asOptionalJsonField('wheelSize', providerResult.wheelSize),
          ...asOptionalJsonField('engineSize', providerResult.engineSize),
          ...asOptionalJsonField('cylinders', providerResult.cylinders),
          ...asOptionalJsonField('horsepower', providerResult.horsepower),
          ...asOptionalJsonField('eventCount', providerResult.eventCount),
          ...asOptionalJsonField('providerResultCode', providerResult.providerResultCode),
          ...asOptionalJsonField('providerResultMessage', providerResult.providerResultMessage),
          ...asOptionalJsonField('quickCheck', providerResult.quickCheck as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('ownershipHistory', providerResult.ownershipHistory as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('accident', providerResult.accident as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('mileage', providerResult.mileage as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('recall', providerResult.recall as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('titleProblem', providerResult.titleProblem as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('titleBrand', providerResult.titleBrand as Prisma.InputJsonValue | null | undefined)
        }

        await prisma.claim.update({
          where: { id: claim.id },
          data: {
            vinDataResult: persistedVinDataResult,
            vinDataRawPayload:
              providerResult.raw !== undefined
                ? (providerResult.raw as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            vinDataProvider: provider.name,
            vinDataFetchedAt: new Date(),
            vinDataProviderResultCode: providerResult.providerResultCode ?? null,
            vinDataProviderResultMessage: providerResult.providerResultMessage ?? null,
            status: ClaimStatus.ReadyForAI,
            vinLookupLastError: null,
            vinLookupLastFailedAt: null
          }
        })

        log('claim updated', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: ClaimStatus.ReadyForAI,
          provider: provider.name,
          attemptsMade,
          attemptsAllowed
        })

        await evaluateClaimRulesBestEffort(claim.id, 'worker_provider_data_saved_ready_for_ai')

        const fetchedAuditResult = await logVinDataFetchedAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id?.toString(),
          attemptsMade,
          attemptsAllowed,
          source: claim.source ?? payload.source,
          vin,
          provider: provider.name,
          year: providerResult.year,
          make: providerResult.make,
          model: providerResult.model
        })

        if (fetchedAuditResult.ok) {
          log('audit log written', {
            action: 'vin_data_fetched',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            auditLogId: fetchedAuditResult.auditLogId
          })
        } else {
          logError('audit log failed', {
            action: 'vin_data_fetched',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            error: fetchedAuditResult.error
          })
        }

        log('provider result', {
          provider: provider.name,
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          result: providerResult
        })

        log('status moved to ReadyForAI', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: ClaimStatus.ReadyForAI
        })
      } catch (error) {
        const providerLookupError = isProviderLookupError(error) ? error : null
        const errorMessage =
          error instanceof Error
            ? error.message
            : providerLookupError?.message ?? 'Unknown VIN lookup processing error'
        const providerFailureReason = providerLookupError?.reason ?? providerLookupError?.code ?? 'provider_lookup_failed'
        const failureStatus = providerName ? ClaimStatus.ProviderFailed : ClaimStatus.ProcessingError

        if (providerLookupError && isRateLimitedProviderLookupError(providerLookupError)) {
          const rateLimitedError = providerLookupError

          log('autocheck rate limit detected; retry backoff mitigation active', {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            status: rateLimitedError.status,
            reason: rateLimitedError.reason,
            attemptsMade,
            attemptsAllowed,
            sandboxRateLimitMode: isAutoCheckSandboxRateLimitMitigationEnabled(),
            retryDelayMs: getAutoCheck429RetryDelayMs()
          })
        }

        try {
          await prisma.claim.update({
            where: { id: claim.id },
            data: {
              status: failureStatus,
              vinLookupLastError: errorMessage,
              vinLookupLastFailedAt: new Date(),
              vinLookupAttemptCount: attemptsMade,
              vinLookupLastJobId: job.id?.toString(),
              vinLookupLastJobName: job.name,
              vinLookupLastQueueName: QUEUE_NAMES.VIN_DATA
            }
          })

          log('claim failure state updated', {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            status: failureStatus,
            errorMessage,
            providerErrorCode: providerLookupError?.code,
            providerErrorStatus: providerLookupError?.status,
            attemptsMade,
            attemptsAllowed
          })

          await evaluateClaimRulesBestEffort(claim.id, 'worker_provider_lookup_failed')
        } catch (updateError) {
          logError('failed to persist claim failure state', {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            updateError,
            errorMessage,
            attemptsMade,
            attemptsAllowed
          })
        }

        const failedAuditResult = await logVinDataFetchFailedAudit({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id?.toString(),
          attemptsMade,
          attemptsAllowed,
          source: claim.source ?? payload.source,
          vin,
          provider: providerName,
          reason: providerName ? providerFailureReason : 'processing_error',
          errorMessage
        })

        if (failedAuditResult.ok) {
          log('audit log written', {
            action: 'vin_data_fetch_failed',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            auditLogId: failedAuditResult.auditLogId
          })
        } else {
          logError('audit log failed', {
            action: 'vin_data_fetch_failed',
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            error: failedAuditResult.error
          })
        }

        logError('vin lookup attempt failed', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: failureStatus,
          providerErrorCode: providerLookupError?.code,
          providerErrorStatus: providerLookupError?.status,
          attemptsMade,
          attemptsAllowed,
          errorMessage
        })

        throw error instanceof Error ? error : new Error(errorMessage)
      }

      return {
        ok: true
      }
    },
    {
      connection,
      prefix,
      settings: {
        backoffStrategy(attemptsMade, type, error) {
          return resolveVinLookupBackoffStrategyDelay(attemptsMade, type, error)
        }
      }
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
    if (isRateLimitedProviderFailure(error)) {
      const attemptsAllowed =
        typeof job?.opts?.attempts === 'number' && Number.isFinite(job.opts.attempts) && job.opts.attempts > 0
          ? job.opts.attempts
          : 1
      const attemptsMade = (job?.attemptsMade ?? 0) + 1
      const retriesRemaining = Math.max(0, attemptsAllowed - attemptsMade)

      log('rate limit failure captured by worker failed handler', {
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job?.name,
        jobId: job?.id,
        attemptsMade,
        attemptsAllowed,
        retriesRemaining,
        sandboxRateLimitMode: isAutoCheckSandboxRateLimitMitigationEnabled(),
        retryDelayMs: getAutoCheck429RetryDelayMs()
      })
    }

    logError('job failed', {
      jobName: job?.name,
      jobId: job?.id,
      error: error.message
    })

    const payload = (job?.data ?? {}) as Partial<VinLookupJobPayload>
    const claimId = typeof payload.claimId === 'string' ? payload.claimId : null

    if (!claimId) {
      return
    }

    const attemptsAllowed =
      typeof job?.opts?.attempts === 'number' && Number.isFinite(job.opts.attempts) && job.opts.attempts > 0
        ? job.opts.attempts
        : 1
    const attemptsMade = (job?.attemptsMade ?? 0) + 1

    void (async () => {
      const existingClaim = await prisma.claim.findUnique({
        where: { id: claimId },
        select: {
          id: true,
          claimNumber: true,
          status: true,
          source: true,
          vin: true
        }
      })

      if (!existingClaim || existingClaim.status === ClaimStatus.ProviderFailed) {
        return
      }

      await prisma.claim.update({
        where: { id: existingClaim.id },
        data: {
          status: ClaimStatus.ProcessingError,
          vinLookupAttemptCount: attemptsMade,
          vinLookupLastError: error.message,
          vinLookupLastFailedAt: new Date(),
          vinLookupLastJobId: job?.id?.toString(),
          vinLookupLastJobName: job?.name,
          vinLookupLastQueueName: QUEUE_NAMES.VIN_DATA
        }
      })

      await evaluateClaimRulesBestEffort(existingClaim.id, 'worker_failed_handler_processing_error')

      const failedAuditResult = await logVinDataFetchFailedAudit({
        claimId: existingClaim.id,
        claimNumber: existingClaim.claimNumber,
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job?.name ?? JOB_NAMES.LOOKUP_VIN_DATA,
        jobId: job?.id?.toString(),
        attemptsMade,
        attemptsAllowed,
        source: existingClaim.source ?? payload.source,
        vin: payload.vin ?? existingClaim.vin,
        reason: 'processing_error',
        errorMessage: error.message
      })

      if (failedAuditResult.ok) {
        log('audit log written', {
          action: 'vin_data_fetch_failed',
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber,
          auditLogId: failedAuditResult.auditLogId
        })
      } else {
        logError('audit log failed', {
          action: 'vin_data_fetch_failed',
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber,
          error: failedAuditResult.error
        })
      }

      log('claim status updated in failed handler', {
        queueName: QUEUE_NAMES.VIN_DATA,
        jobName: job?.name,
        jobId: job?.id,
        claimId: existingClaim.id,
        claimNumber: existingClaim.claimNumber,
        status: ClaimStatus.ProcessingError,
        attemptsMade,
        attemptsAllowed
      })
    })().catch((failedHandlerError) => {
      logError('failed handler persistence error', {
        claimId,
        jobName: job?.name,
        jobId: job?.id,
        error: failedHandlerError
      })
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

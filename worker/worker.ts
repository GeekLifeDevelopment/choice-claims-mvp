import { config as loadEnv } from 'dotenv'
import { Prisma } from '@prisma/client'
import { Worker, type Job } from 'bullmq'
import {
  logVinDataFetchedAudit,
  logVinDataFetchFailedAudit
} from '../lib/audit/intake-audit-log'
import { ClaimStatus } from '../lib/domain/claims'
import { ensureEnvConfigValidated } from '../lib/config/validate-env'
import { prisma } from '../lib/prisma'
import { getQueueRuntimeConfig } from '../lib/queue/config'
import { JOB_NAMES } from '../lib/queue/job-names'
import type { ReviewSummaryJobPayload, VinLookupJobPayload } from '../lib/queue/job-payloads'
import { QUEUE_NAMES } from '../lib/queue/queue-names'
import { processReviewSummaryJob } from '../lib/review/process-review-summary-job'
import { enqueueReviewSummaryForClaim } from '../lib/review/enqueue-review-summary'
import { evaluateAndStoreClaimRules } from '../lib/review/evaluate-and-store-claim-rules'
import { isClaimLockedForProcessing } from '../lib/review/claim-lock'
import {
  getAutoCheck429RetryDelayMs,
  isAutoCheckSandboxRateLimitMitigationEnabled,
  isRateLimitedProviderFailure,
  resolveVinLookupBackoffStrategyDelay
} from '../lib/queue/vin-lookup-job-options'
import { isFeatureEnabled } from '../lib/config/feature-flags'
import { getVinDataProvider } from '../lib/providers/get-vin-provider'
import { NhtsaRecallsProvider } from '../lib/providers/nhtsa-recalls-provider'
import { ServiceHistoryProvider } from '../lib/providers/service-history-provider'
import { TitleHistoryProvider } from '../lib/providers/title-history-provider'
import { ValuationProvider } from '../lib/providers/valuation-provider'
import { VinSpecFallbackProvider } from '../lib/providers/vin-spec-fallback-provider'
import { classifyExternalFailure } from '../lib/providers/failure-classification'
import { isProviderLookupError } from '../lib/providers/provider-error'
import type {
  NhtsaRecallsResult,
  ServiceHistoryResult,
  TitleHistoryResult,
  ValuationResult,
  VinDataResult,
  VinSpecFallbackResult
} from '../lib/providers/types'

const FINAL_REVIEW_DECISIONS = ['Approved', 'Denied']
const STALE_JOB_GRACE_MS = 5_000

function parseJobRequestedAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isJobStaleComparedToClaim(requestedAt: Date | null, claimUpdatedAt: Date): boolean {
  if (!requestedAt) {
    return false
  }

  return claimUpdatedAt.getTime() > requestedAt.getTime() + STALE_JOB_GRACE_MS
}

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

function hasMinimumVinSpecFields(input: {
  year?: number | null
  make?: string | null
  model?: string | null
}): boolean {
  return Boolean(input.year && input.make && input.model)
}

function shouldRunVinSpecFallback(providerResult: VinDataResult): boolean {
  return !hasMinimumVinSpecFields(providerResult)
}

function mergePrimaryWithFallbackSpecs(
  providerResult: VinDataResult,
  fallbackSpecs: VinSpecFallbackResult | null
): VinDataResult {
  if (!fallbackSpecs) {
    return providerResult
  }

  return {
    ...providerResult,
    year: providerResult.year ?? fallbackSpecs.year ?? null,
    make: providerResult.make ?? fallbackSpecs.make ?? null,
    model: providerResult.model ?? fallbackSpecs.model ?? null,
    trim: providerResult.trim ?? fallbackSpecs.trim ?? null,
    bodyStyle: providerResult.bodyStyle ?? fallbackSpecs.bodyStyle ?? null,
    drivetrain: providerResult.drivetrain ?? fallbackSpecs.drivetrain ?? null,
    transmissionType: providerResult.transmissionType ?? fallbackSpecs.transmissionType ?? null,
    engineSize: providerResult.engineSize ?? fallbackSpecs.engineSize ?? null,
    cylinders: providerResult.cylinders ?? fallbackSpecs.cylinders ?? null,
    fuelType: providerResult.fuelType ?? fallbackSpecs.fuelType ?? null,
    manufacturer: providerResult.manufacturer ?? fallbackSpecs.manufacturer ?? null
  }
}

async function lookupVinSpecsFallbackBestEffort(
  vin: string,
  context: {
    queueName: string
    jobName: string
    jobId: string | number | undefined
    claimId: string
    claimNumber: string
  }
): Promise<VinSpecFallbackResult | null> {
  try {
    const fallbackProvider = new VinSpecFallbackProvider()
    const fallbackSpecs = await fallbackProvider.lookupVinSpecs(vin)

    if (!fallbackSpecs) {
      log('vin spec fallback returned no usable specs', {
        ...context,
        vin
      })
      return null
    }

    log('vin spec fallback fetched', {
      ...context,
      vin,
      source: fallbackSpecs.source,
      year: fallbackSpecs.year,
      make: fallbackSpecs.make,
      model: fallbackSpecs.model
    })

    return fallbackSpecs
  } catch (error) {
    logError('vin spec fallback failed', {
      ...context,
      vin,
      error
    })
    return null
  }
}

async function lookupTitleHistoryBestEffort(
  vin: string,
  context: {
    queueName: string
    jobName: string
    jobId: string | number | undefined
    claimId: string
    claimNumber: string
  }
): Promise<TitleHistoryResult | null> {
  if (!isFeatureEnabled('enrichment')) {
    console.info('[feature] enrichment disabled')
    return null
  }

  if (!isFeatureEnabled('title_history')) {
    console.info('[feature] title history disabled')
    return null
  }

  try {
    const provider = new TitleHistoryProvider()
    const result = await provider.lookupTitleHistory(vin)

    log('title history enrichment fetched', {
      ...context,
      vin,
      source: result.source,
      titleStatus: result.titleStatus,
      brandFlagCount: result.brandFlags.length,
      odometerFlagCount: result.odometerFlags.length,
      eventCount: result.events.length
    })

    return result
  } catch (error) {
    logError('title history enrichment failed; continuing vin processing', {
      ...context,
      vin,
      error
    })
    return null
  }
}

async function lookupServiceHistoryBestEffort(
  vin: string,
  context: {
    queueName: string
    jobName: string
    jobId: string | number | undefined
    claimId: string
    claimNumber: string
  }
): Promise<ServiceHistoryResult | null> {
  if (!isFeatureEnabled('enrichment')) {
    console.info('[feature] enrichment disabled')
    return null
  }

  if (!isFeatureEnabled('service_history')) {
    console.info('[feature] service history disabled')
    return null
  }

  try {
    const provider = new ServiceHistoryProvider()
    const result = await provider.lookupServiceHistory(vin)

    log('service history enrichment fetched', {
      ...context,
      vin,
      source: result.source,
      eventCount: result.eventCount,
      latestMileage: result.latestMileage
    })

    return result
  } catch (error) {
    logError('service history enrichment failed; continuing vin processing', {
      ...context,
      vin,
      error
    })
    return null
  }
}

async function lookupValuationBestEffort(
  vin: string,
  context: {
    queueName: string
    jobName: string
    jobId: string | number | undefined
    claimId: string
    claimNumber: string
  }
): Promise<ValuationResult | null> {
  if (!isFeatureEnabled('enrichment')) {
    console.info('[feature] enrichment disabled')
    return null
  }

  if (!isFeatureEnabled('valuation')) {
    console.info('[feature] valuation disabled')
    return null
  }

  try {
    const provider = new ValuationProvider()
    const result = await provider.lookupValuation(vin)

    log('valuation enrichment fetched', {
      ...context,
      vin,
      source: result.source,
      estimatedValue: result.estimatedValue,
      retailValue: result.retailValue,
      tradeInValue: result.tradeInValue,
      currency: result.currency
    })

    return result
  } catch (error) {
    logError('valuation enrichment failed; continuing vin processing', {
      ...context,
      vin,
      error
    })
    return null
  }
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

async function enqueueReviewSummaryBestEffort(claimId: string, context: string): Promise<void> {
  try {
    const result = await enqueueReviewSummaryForClaim(claimId, 'rules_ready')

    log('review summary enqueue attempted', {
      claimId,
      context,
      enqueued: result.enqueued,
      reason: result.reason,
      queueName: result.queueName,
      jobName: result.jobName,
      jobId: result.jobId
    })
  } catch (error) {
    logError('review summary enqueue failed unexpectedly', {
      claimId,
      context,
      error
    })
  }
}

async function run() {
  ensureEnvConfigValidated('worker')

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
      const requestedAt = parseJobRequestedAt(payload.requestedAt)
      const claim = await prisma.claim.findUnique({
        where: { id: payload.claimId },
        select: {
          id: true,
          claimNumber: true,
          reviewDecision: true,
          status: true,
          source: true,
          vin: true,
          updatedAt: true
        }
      })

      if (!claim) {
        log('vin lookup job skipped because claim is missing', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: payload.claimId,
          claimNumber: payload.claimNumber,
          attemptsMade,
          attemptsAllowed
        })

        return {
          ok: true,
          skipped: true,
          reason: 'missing_claim'
        }
      }

      if (isClaimLockedForProcessing(claim)) {
        log('vin lookup job skipped because claim is locked by final reviewer decision', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          reviewDecision: claim.reviewDecision
        })

        return {
          ok: true,
          skipped: true,
          reason: 'locked_final_decision'
        }
      }

      if (claim.status !== ClaimStatus.AwaitingVinData) {
        log('vin lookup job skipped because claim status is no longer eligible', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          status: claim.status
        })

        return {
          ok: true,
          skipped: true,
          reason: 'obsolete_claim_status'
        }
      }

      if (isJobStaleComparedToClaim(requestedAt, claim.updatedAt)) {
        log('vin lookup job skipped because job is stale relative to claim state', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          claimUpdatedAt: claim.updatedAt,
          requestedAt
        })

        return {
          ok: true,
          skipped: true,
          reason: 'stale_job'
        }
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

        const transitioned = await prisma.claim.updateMany({
          where: {
            id: claim.id,
            status: ClaimStatus.AwaitingVinData,
            OR: [
              { reviewDecision: null },
              {
                reviewDecision: {
                  notIn: FINAL_REVIEW_DECISIONS
                }
              }
            ]
          },
          data: {
            status: ClaimStatus.ProviderFailed,
            vinLookupLastError: errorMessage,
            vinLookupLastFailedAt: new Date()
          }
        })

        if (transitioned.count === 0) {
          log('vin missing update skipped due claim state change', {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber
          })

          return {
            ok: true,
            skipped: true,
            reason: 'obsolete_claim_state'
          }
        }

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
        if (!isFeatureEnabled('enrichment')) {
          console.info('[feature] enrichment disabled')

          const persistedVinDataResult: Prisma.InputJsonObject = {
            vin,
            providerResultMessage: 'enrichment_disabled'
          }

          const transitioned = await prisma.claim.updateMany({
            where: {
              id: claim.id,
              status: ClaimStatus.AwaitingVinData,
              OR: [
                { reviewDecision: null },
                {
                  reviewDecision: {
                    notIn: FINAL_REVIEW_DECISIONS
                  }
                }
              ]
            },
            data: {
              vinDataResult: persistedVinDataResult,
              vinDataRawPayload: Prisma.JsonNull,
              vinDataProvider: null,
              vinDataFetchedAt: new Date(),
              vinDataProviderResultCode: null,
              vinDataProviderResultMessage: 'enrichment_disabled',
              status: ClaimStatus.ReadyForAI,
              vinLookupLastError: null,
              vinLookupLastFailedAt: null
            }
          })

          if (transitioned.count === 0) {
            log('vin enrichment-disabled persistence skipped due claim state change', {
              queueName: QUEUE_NAMES.VIN_DATA,
              jobName: job.name,
              jobId: job.id,
              claimId: claim.id,
              claimNumber: claim.claimNumber,
              status: claim.status
            })

            return {
              ok: true,
              skipped: true,
              reason: 'obsolete_claim_state'
            }
          }

          await evaluateClaimRulesBestEffort(claim.id, 'worker_enrichment_disabled_ready_for_ai')
          await enqueueReviewSummaryBestEffort(claim.id, 'worker_enrichment_disabled_ready_for_ai')

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
            provider: 'feature_disabled'
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

          return {
            ok: true,
            skipped: true,
            reason: 'enrichment_disabled'
          }
        }

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
        let fallbackSpecs: VinSpecFallbackResult | null = null

        if (shouldRunVinSpecFallback(providerResult)) {
          fallbackSpecs = await lookupVinSpecsFallbackBestEffort(vin, {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber
          })
        }

        const enrichedProviderResult = mergePrimaryWithFallbackSpecs(providerResult, fallbackSpecs)
        let nhtsaRecalls: NhtsaRecallsResult | null = null
        let titleHistory: TitleHistoryResult | null = null
        let serviceHistory: ServiceHistoryResult | null = null
        let valuation: ValuationResult | null = null

        if (!isFeatureEnabled('recalls')) {
          console.info('[feature] recalls disabled')
        } else {
          try {
            const recallsProvider = new NhtsaRecallsProvider()
            nhtsaRecalls = await recallsProvider.lookupRecalls(enrichedProviderResult.vin || vin)

            log('nhtsa recalls enrichment fetched', {
              queueName: QUEUE_NAMES.VIN_DATA,
              jobName: job.name,
              jobId: job.id,
              claimId: claim.id,
              claimNumber: claim.claimNumber,
              vin,
              recallCount: nhtsaRecalls.count
            })
          } catch (nhtsaError) {
            logError('nhtsa recalls enrichment failed; continuing vin processing', {
              queueName: QUEUE_NAMES.VIN_DATA,
              jobName: job.name,
              jobId: job.id,
              claimId: claim.id,
              claimNumber: claim.claimNumber,
              vin,
              error: nhtsaError
            })
          }
        }

        titleHistory = await lookupTitleHistoryBestEffort(vin, {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber
        })

        serviceHistory = await lookupServiceHistoryBestEffort(vin, {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber
        })

        valuation = await lookupValuationBestEffort(vin, {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber
        })

        const persistedVinDataResult: Prisma.InputJsonObject = {
          vin: enrichedProviderResult.vin,
          provider: enrichedProviderResult.provider,
          ...asOptionalJsonField('year', enrichedProviderResult.year),
          ...asOptionalJsonField('make', enrichedProviderResult.make),
          ...asOptionalJsonField('model', enrichedProviderResult.model),
          ...asOptionalJsonField('trim', enrichedProviderResult.trim),
          ...asOptionalJsonField('vehicleClass', enrichedProviderResult.vehicleClass),
          ...asOptionalJsonField('country', enrichedProviderResult.country),
          ...asOptionalJsonField('bodyStyle', enrichedProviderResult.bodyStyle),
          ...asOptionalJsonField('doors', enrichedProviderResult.doors),
          ...asOptionalJsonField('drivetrain', enrichedProviderResult.drivetrain),
          ...asOptionalJsonField('transmissionType', enrichedProviderResult.transmissionType),
          ...asOptionalJsonField('wheelSize', enrichedProviderResult.wheelSize),
          ...asOptionalJsonField('engineSize', enrichedProviderResult.engineSize),
          ...asOptionalJsonField('cylinders', enrichedProviderResult.cylinders),
          ...asOptionalJsonField('fuelType', enrichedProviderResult.fuelType),
          ...asOptionalJsonField('manufacturer', enrichedProviderResult.manufacturer),
          ...asOptionalJsonField('horsepower', enrichedProviderResult.horsepower),
          ...asOptionalJsonField('eventCount', enrichedProviderResult.eventCount),
          ...asOptionalJsonField('providerResultCode', enrichedProviderResult.providerResultCode),
          ...asOptionalJsonField('providerResultMessage', enrichedProviderResult.providerResultMessage),
          ...asOptionalJsonField('quickCheck', enrichedProviderResult.quickCheck as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('ownershipHistory', enrichedProviderResult.ownershipHistory as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('accident', enrichedProviderResult.accident as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('mileage', enrichedProviderResult.mileage as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('recall', enrichedProviderResult.recall as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('nhtsaRecalls', nhtsaRecalls as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('vinSpecFallback', fallbackSpecs as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('titleHistory', titleHistory as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('serviceHistory', serviceHistory as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('valuation', valuation as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('titleProblem', enrichedProviderResult.titleProblem as Prisma.InputJsonValue | null | undefined),
          ...asOptionalJsonField('titleBrand', enrichedProviderResult.titleBrand as Prisma.InputJsonValue | null | undefined)
        }

        const transitioned = await prisma.claim.updateMany({
          where: {
            id: claim.id,
            status: ClaimStatus.AwaitingVinData,
            OR: [
              { reviewDecision: null },
              {
                reviewDecision: {
                  notIn: FINAL_REVIEW_DECISIONS
                }
              }
            ]
          },
          data: {
            vinDataResult: persistedVinDataResult,
            vinDataRawPayload:
              providerResult.raw !== undefined
                ? (providerResult.raw as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            vinDataProvider: provider.name,
            vinDataFetchedAt: new Date(),
            vinDataProviderResultCode: enrichedProviderResult.providerResultCode ?? null,
            vinDataProviderResultMessage: enrichedProviderResult.providerResultMessage ?? null,
            status: ClaimStatus.ReadyForAI,
            vinLookupLastError: null,
            vinLookupLastFailedAt: null
          }
        })

        if (transitioned.count === 0) {
          log('vin success persistence skipped due claim state change', {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber,
            status: claim.status
          })

          return {
            ok: true,
            skipped: true,
            reason: 'obsolete_claim_state'
          }
        }

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
        await enqueueReviewSummaryBestEffort(claim.id, 'worker_ready_for_ai_after_rules')

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
          year: enrichedProviderResult.year,
          make: enrichedProviderResult.make,
          model: enrichedProviderResult.model
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
        const failureCategory = classifyExternalFailure({
          status: providerLookupError?.status,
          reason: providerFailureReason,
          errorMessage,
          fallbackCategory: 'unknown_error'
        })

        logError('provider failed safely', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          provider: providerName,
          failureCategory,
          providerFailureReason,
          providerErrorStatus: providerLookupError?.status,
          attemptsMade,
          attemptsAllowed
        })

        const fallbackSpecs = await lookupVinSpecsFallbackBestEffort(vin, {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job.name,
          jobId: job.id,
          claimId: claim.id,
          claimNumber: claim.claimNumber
        })

        if (fallbackSpecs && hasMinimumVinSpecFields(fallbackSpecs)) {
          let nhtsaRecallsFromFallback: NhtsaRecallsResult | null = null
          let titleHistoryFromFallback: TitleHistoryResult | null = null
          let serviceHistoryFromFallback: ServiceHistoryResult | null = null
          let valuationFromFallback: ValuationResult | null = null

          if (!isFeatureEnabled('recalls')) {
            console.info('[feature] recalls disabled')
          } else {
            try {
              const recallsProvider = new NhtsaRecallsProvider()
              nhtsaRecallsFromFallback = await recallsProvider.lookupRecalls(vin)
            } catch (nhtsaError) {
              logError('nhtsa recalls enrichment failed during fallback recovery', {
                queueName: QUEUE_NAMES.VIN_DATA,
                jobName: job.name,
                jobId: job.id,
                claimId: claim.id,
                claimNumber: claim.claimNumber,
                vin,
                error: nhtsaError
              })
            }
          }

          titleHistoryFromFallback = await lookupTitleHistoryBestEffort(vin, {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber
          })

          serviceHistoryFromFallback = await lookupServiceHistoryBestEffort(vin, {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber
          })

          valuationFromFallback = await lookupValuationBestEffort(vin, {
            queueName: QUEUE_NAMES.VIN_DATA,
            jobName: job.name,
            jobId: job.id,
            claimId: claim.id,
            claimNumber: claim.claimNumber
          })

          const fallbackVinDataResult: Prisma.InputJsonObject = {
            vin,
            provider: fallbackSpecs.source,
            ...asOptionalJsonField('year', fallbackSpecs.year),
            ...asOptionalJsonField('make', fallbackSpecs.make),
            ...asOptionalJsonField('model', fallbackSpecs.model),
            ...asOptionalJsonField('trim', fallbackSpecs.trim),
            ...asOptionalJsonField('bodyStyle', fallbackSpecs.bodyStyle),
            ...asOptionalJsonField('drivetrain', fallbackSpecs.drivetrain),
            ...asOptionalJsonField('transmissionType', fallbackSpecs.transmissionType),
            ...asOptionalJsonField('engineSize', fallbackSpecs.engineSize),
            ...asOptionalJsonField('cylinders', fallbackSpecs.cylinders),
            ...asOptionalJsonField('fuelType', fallbackSpecs.fuelType),
            ...asOptionalJsonField('manufacturer', fallbackSpecs.manufacturer),
            ...asOptionalJsonField('vinSpecFallback', fallbackSpecs as Prisma.InputJsonValue | null | undefined),
            ...asOptionalJsonField('nhtsaRecalls', nhtsaRecallsFromFallback as Prisma.InputJsonValue | null | undefined),
            ...asOptionalJsonField('titleHistory', titleHistoryFromFallback as Prisma.InputJsonValue | null | undefined),
            ...asOptionalJsonField('serviceHistory', serviceHistoryFromFallback as Prisma.InputJsonValue | null | undefined),
            ...asOptionalJsonField('valuation', valuationFromFallback as Prisma.InputJsonValue | null | undefined),
            ...asOptionalJsonField('providerResultMessage', `primary_provider_failed:${errorMessage}`)
          }

          const recovered = await prisma.claim.updateMany({
            where: {
              id: claim.id,
              status: ClaimStatus.AwaitingVinData,
              OR: [
                { reviewDecision: null },
                {
                  reviewDecision: {
                    notIn: FINAL_REVIEW_DECISIONS
                  }
                }
              ]
            },
            data: {
              vinDataResult: fallbackVinDataResult,
              vinDataRawPayload: Prisma.JsonNull,
              vinDataProvider: fallbackSpecs.source,
              vinDataFetchedAt: new Date(),
              vinDataProviderResultCode: null,
              vinDataProviderResultMessage: `Primary provider failed; recovered by fallback (${fallbackSpecs.source})`,
              status: ClaimStatus.ReadyForAI,
              vinLookupLastError: null,
              vinLookupLastFailedAt: null
            }
          })

          if (recovered.count > 0) {
            log('claim recovered by vin spec fallback', {
              queueName: QUEUE_NAMES.VIN_DATA,
              jobName: job.name,
              jobId: job.id,
              claimId: claim.id,
              claimNumber: claim.claimNumber,
              source: fallbackSpecs.source,
              year: fallbackSpecs.year,
              make: fallbackSpecs.make,
              model: fallbackSpecs.model,
              attemptsMade,
              attemptsAllowed
            })

            await evaluateClaimRulesBestEffort(claim.id, 'worker_fallback_specs_recovered_ready_for_ai')
            await enqueueReviewSummaryBestEffort(claim.id, 'worker_ready_for_ai_after_vin_spec_fallback')

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
              provider: fallbackSpecs.source,
              year: fallbackSpecs.year,
              make: fallbackSpecs.make,
              model: fallbackSpecs.model
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

            return {
              ok: true,
              fallbackRecovered: true
            }
          }
        }

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
          const transitioned = await prisma.claim.updateMany({
            where: {
              id: claim.id,
              status: ClaimStatus.AwaitingVinData,
              OR: [
                { reviewDecision: null },
                {
                  reviewDecision: {
                    notIn: FINAL_REVIEW_DECISIONS
                  }
                }
              ]
            },
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

          if (transitioned.count === 0) {
            log('vin failure persistence skipped due claim state change', {
              queueName: QUEUE_NAMES.VIN_DATA,
              jobName: job.name,
              jobId: job.id,
              claimId: claim.id,
              claimNumber: claim.claimNumber,
              status: claim.status
            })

            return {
              ok: true,
              skipped: true,
              reason: 'obsolete_claim_state'
            }
          }

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
    const requestedAt = parseJobRequestedAt(payload.requestedAt)

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
          reviewDecision: true,
          status: true,
          source: true,
          vin: true,
          updatedAt: true
        }
      })

      if (!existingClaim) {
        return
      }

      if (isClaimLockedForProcessing(existingClaim)) {
        log('failed handler skipped status mutation because claim is locked by final reviewer decision', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job?.name,
          jobId: job?.id,
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber,
          reviewDecision: existingClaim.reviewDecision
        })
        return
      }

      if (existingClaim.status === ClaimStatus.ProviderFailed) {
        await evaluateClaimRulesBestEffort(
          existingClaim.id,
          'worker_failed_handler_existing_provider_failed'
        )
        return
      }

      if (existingClaim.status !== ClaimStatus.AwaitingVinData) {
        log('failed handler skipped mutation because claim status is no longer eligible', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job?.name,
          jobId: job?.id,
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber,
          status: existingClaim.status
        })
        return
      }

      if (isJobStaleComparedToClaim(requestedAt, existingClaim.updatedAt)) {
        log('failed handler skipped mutation because job is stale', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job?.name,
          jobId: job?.id,
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber,
          claimUpdatedAt: existingClaim.updatedAt,
          requestedAt
        })
        return
      }

      const transitioned = await prisma.claim.updateMany({
        where: {
          id: existingClaim.id,
          status: ClaimStatus.AwaitingVinData,
          OR: [
            { reviewDecision: null },
            {
              reviewDecision: {
                notIn: FINAL_REVIEW_DECISIONS
              }
            }
          ]
        },
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

      if (transitioned.count === 0) {
        log('failed handler processing-error update skipped due claim state change', {
          queueName: QUEUE_NAMES.VIN_DATA,
          jobName: job?.name,
          jobId: job?.id,
          claimId: existingClaim.id,
          claimNumber: existingClaim.claimNumber
        })
        return
      }

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

  log('starting', {
    queueName: QUEUE_NAMES.REVIEW_SUMMARY,
    prefix
  })

  const reviewSummaryWorker = new Worker(
    QUEUE_NAMES.REVIEW_SUMMARY,
    async (job: Job) => {
      log('review summary job start', {
        queueName: QUEUE_NAMES.REVIEW_SUMMARY,
        jobName: job.name,
        jobId: job.id,
        payload: job.data,
        attemptsMade: job.attemptsMade + 1,
        attemptsAllowed: job.opts.attempts
      })

      if (job.name !== JOB_NAMES.GENERATE_REVIEW_SUMMARY) {
        const message = `Unsupported job name: ${job.name}`

        logError('review summary job failed', {
          queueName: QUEUE_NAMES.REVIEW_SUMMARY,
          jobName: job.name,
          jobId: job.id,
          error: message
        })

        return {
          ok: false,
          error: message
        }
      }

      try {
        const payload = job.data as ReviewSummaryJobPayload
        const result = await processReviewSummaryJob(payload.claimId, {
          requestedAt: payload.requestedAt
        })

        if (!result.ok) {
          logError('review summary job failed', {
            queueName: QUEUE_NAMES.REVIEW_SUMMARY,
            jobName: job.name,
            jobId: job.id,
            claimId: payload.claimId,
            reason: result.reason
          })

          return result
        }

        if (result.status === 'skipped') {
          log('review summary job skipped', {
            queueName: QUEUE_NAMES.REVIEW_SUMMARY,
            jobName: job.name,
            jobId: job.id,
            claimId: payload.claimId,
            reason: result.reason
          })

          return result
        }

        log('review summary job success', {
          queueName: QUEUE_NAMES.REVIEW_SUMMARY,
          jobName: job.name,
          jobId: job.id,
          claimId: payload.claimId,
          status: result.status
        })

        return result
      } catch (error) {
        const payload = job.data as Partial<ReviewSummaryJobPayload>
        const claimId = typeof payload.claimId === 'string' ? payload.claimId : null
        const errorMessage = error instanceof Error ? error.message : 'Unknown review summary worker error.'

        if (claimId) {
          try {
            await prisma.claim.update({
              where: { id: claimId },
              data: {
                reviewSummaryStatus: 'Failed',
                reviewSummaryLastError: errorMessage
              }
            })
          } catch (persistError) {
            logError('review summary failure persistence failed', {
              queueName: QUEUE_NAMES.REVIEW_SUMMARY,
              jobName: job.name,
              jobId: job.id,
              claimId,
              error: persistError
            })
          }
        }

        logError('review summary job failed', {
          queueName: QUEUE_NAMES.REVIEW_SUMMARY,
          jobName: job.name,
          jobId: job.id,
          claimId,
          error: errorMessage
        })

        return {
          ok: false,
          error: errorMessage
        }
      }
    },
    {
      connection,
      prefix
    }
  )

  reviewSummaryWorker.on('ready', () => {
    log('connected to redis', {
      queueName: QUEUE_NAMES.REVIEW_SUMMARY,
      prefix
    })
  })

  reviewSummaryWorker.on('completed', (job) => {
    log('job completed', {
      queueName: QUEUE_NAMES.REVIEW_SUMMARY,
      jobName: job.name,
      jobId: job.id
    })
  })

  reviewSummaryWorker.on('failed', (job, error) => {
    logError('job failed', {
      queueName: QUEUE_NAMES.REVIEW_SUMMARY,
      jobName: job?.name,
      jobId: job?.id,
      error: error.message
    })
  })

  const shutdown = async (signal: string) => {
    log(`shutdown requested (${signal})`)

    try {
      await Promise.all([worker.close(), reviewSummaryWorker.close()])
      log('workers closed')
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

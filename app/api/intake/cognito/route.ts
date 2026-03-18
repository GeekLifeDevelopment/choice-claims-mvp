import { ZodError } from 'zod'
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { parseNormalizedIntakePayload } from '../../../../lib/schemas/intake'
import { toCreateClaimFromIntakeInput } from '../../../../lib/domain/claims'
import { normalizeCognitoPayload } from '../../../../lib/intake/normalize-cognito-payload'
import { readCognitoBody } from '../../../../lib/intake/read-cognito-body'
import { validateCognitoWebhookHeaders } from '../../../../lib/intake/validate-cognito-webhook'
import { getPayloadPreview } from '../../../../lib/intake/get-payload-preview'
import { buildDedupeKeyDetails } from '../../../../lib/claims/build-dedupe-key'
import { createClaimFromSubmission } from '../../../../lib/claims/create-claim-from-submission'
import { logIntakeValidationFailedAudit } from '../../../../lib/audit/intake-audit-log'

function getRequestId() {
  return randomUUID().slice(0, 8)
}

function isDebugModeEnabled() {
  return process.env.COGNITO_WEBHOOK_DEBUG === 'true'
}

function logWithRequestId(requestId: string, message: string, details?: unknown) {
  if (details !== undefined) {
    console.info(`[COGNITO_WEBHOOK][${requestId}] ${message}`, details)
    return
  }

  console.info(`[COGNITO_WEBHOOK][${requestId}] ${message}`)
}

function logWarnWithRequestId(requestId: string, message: string, details?: unknown) {
  if (details !== undefined) {
    console.warn(`[COGNITO_WEBHOOK][${requestId}] ${message}`, details)
    return
  }

  console.warn(`[COGNITO_WEBHOOK][${requestId}] ${message}`)
}

function logErrorWithRequestId(requestId: string, message: string, details?: unknown) {
  if (details !== undefined) {
    console.error(`[COGNITO_WEBHOOK][${requestId}] ${message}`, details)
    return
  }

  console.error(`[COGNITO_WEBHOOK][${requestId}] ${message}`)
}

function respond(requestId: string, status: number, body: object) {
  logWithRequestId(requestId, `responding ${status}`)
  return NextResponse.json(body, { status })
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: '/api/intake/cognito',
    message: 'Webhook endpoint is reachable'
  })
}

export async function POST(request: Request) {
  const requestId = getRequestId()
  const debugMode = isDebugModeEnabled()

  logWithRequestId(requestId, 'received', { method: request.method })

  const webhookValidation = validateCognitoWebhookHeaders(request.headers)
  if (!webhookValidation.ok) {
    logWarnWithRequestId(requestId, 'secret unauthorized', { reason: webhookValidation.reason })
    return respond(requestId, 401, { ok: false, requestId, error: 'unauthorized' })
  }

  logWithRequestId(
    requestId,
    webhookValidation.mode === 'validated' ? 'secret passed' : 'secret skipped'
  )

  const bodyResult = await readCognitoBody(request)
  if (!bodyResult.ok) {
    logWarnWithRequestId(requestId, 'invalid json')
    return respond(requestId, 400, { ok: false, requestId, error: 'invalid_json' })
  }

  const rawPayload = bodyResult.body
  const payloadPreview = getPayloadPreview(rawPayload)
  let normalizedSource: string | undefined
  logWithRequestId(requestId, 'raw keys', payloadPreview.topLevelKeys)

  try {
    const normalizedPayload = normalizeCognitoPayload(rawPayload)
    normalizedSource = normalizedPayload.source
    logWithRequestId(requestId, 'normalized')

    const validatedPayload = parseNormalizedIntakePayload(normalizedPayload)
    const createClaimInput = toCreateClaimFromIntakeInput(validatedPayload)

    logWithRequestId(requestId, 'validation succeeded')
    logWithRequestId(requestId, 'starting claim persistence', {
      source: createClaimInput.source,
      vin: createClaimInput.vin,
      attachmentCount: createClaimInput.attachments.length,
      submittedAt: createClaimInput.submittedAt.toISOString()
    })

    const dedupeDetails = buildDedupeKeyDetails(createClaimInput)
    logWithRequestId(requestId, 'dedupe key built', {
      dedupeKey: dedupeDetails.dedupeKey,
      dedupeSource: dedupeDetails.dedupeSource
    })

    const dedupeKey = dedupeDetails.dedupeKey

    const claimCreationResult = await createClaimFromSubmission(createClaimInput)

    if (!claimCreationResult.ok) {
      logErrorWithRequestId(requestId, 'claim creation failed', {
        error: claimCreationResult.error,
        message: claimCreationResult.message
      })

      if (claimCreationResult.error === 'vin_lookup_enqueue_failed') {
        logErrorWithRequestId(requestId, 'enqueue failed claim remains submitted', {
          dedupeKey,
          source: createClaimInput.source,
          vin: createClaimInput.vin
        })
      }

      if (claimCreationResult.error === 'claim_status_update_failed') {
        logErrorWithRequestId(requestId, 'enqueue succeeded but status update failed', {
          dedupeKey,
          source: createClaimInput.source,
          vin: createClaimInput.vin
        })
      }

      return respond(requestId, 500, {
        ok: false,
        requestId,
        error: claimCreationResult.error,
        message:
          claimCreationResult.error === 'vin_lookup_enqueue_failed'
            ? 'Claim created, but VIN lookup enqueue failed'
            : claimCreationResult.error === 'claim_status_update_failed'
              ? 'Claim created and enqueued, but status update failed'
              : 'Claim creation failed'
      })
    }

    if (claimCreationResult.duplicate) {
      logWithRequestId(requestId, 'duplicate detected no enqueue', {
        dedupeKey: claimCreationResult.dedupeKey,
        claimId: claimCreationResult.claim.id,
        claimNumber: claimCreationResult.claim.claimNumber,
        attachmentCount: createClaimInput.attachments.length
      })
    } else {
      logWithRequestId(requestId, 'claim created', {
        dedupeKey: claimCreationResult.dedupeKey,
        claimId: claimCreationResult.claim.id,
        claimNumber: claimCreationResult.claim.claimNumber,
        status: claimCreationResult.claim.status,
        attachmentCount: createClaimInput.attachments.length
      })

      logWithRequestId(requestId, 'vin lookup enqueued', {
        claimId: claimCreationResult.claim.id,
        claimNumber: claimCreationResult.claim.claimNumber,
        queueName: claimCreationResult.enqueued.queueName,
        jobName: claimCreationResult.enqueued.jobName,
        jobId: claimCreationResult.enqueued.jobId
      })
    }

    if (debugMode) {
      return respond(requestId, 200, {
        ok: true,
        requestId,
        duplicate: claimCreationResult.duplicate,
        message: claimCreationResult.duplicate
          ? 'Duplicate submission detected; existing claim returned'
          : 'Claim created and queued for VIN lookup',
        claim: claimCreationResult.claim,
        topLevelKeys: payloadPreview.topLevelKeys,
        payloadPreview,
        normalizedPayload: validatedPayload,
        createClaimInput,
        dedupeKey: claimCreationResult.dedupeKey
      })
    }

    return respond(requestId, 200, {
      ok: true,
      requestId,
      duplicate: claimCreationResult.duplicate,
      message: claimCreationResult.duplicate
        ? 'Duplicate submission detected; existing claim returned'
        : 'Claim created and queued for VIN lookup',
      claim: claimCreationResult.claim
    })
  } catch (error) {
    if (error instanceof ZodError) {
      logWarnWithRequestId(requestId, 'validation failed', error.issues)

      const validationIssues = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message
      }))

      const auditResult = await logIntakeValidationFailedAudit({
        requestId,
        source: normalizedSource,
        issues: validationIssues,
        topLevelKeys: payloadPreview.topLevelKeys
      })

      if (!auditResult.ok) {
        logErrorWithRequestId(requestId, 'audit log failed action=intake_validation_failed', {
          error: auditResult.error
        })
      } else {
        logWithRequestId(requestId, 'audit log written action=intake_validation_failed', {
          requestId,
          auditLogId: auditResult.auditLogId
        })
      }

      return respond(
        requestId,
        400,
        {
          ok: false,
          requestId,
          error: 'validation_failed',
          issues: validationIssues
        }
      )
    }

    logErrorWithRequestId(requestId, 'internal error', error)
    return respond(requestId, 500, { ok: false, requestId, error: 'internal_error' })
  }
}

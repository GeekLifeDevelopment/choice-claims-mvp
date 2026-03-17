import { ZodError } from 'zod'
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { parseNormalizedIntakePayload } from '../../../../lib/schemas/intake'
import { toCreateClaimFromIntakeInput } from '../../../../lib/domain/claims'
import { normalizeCognitoPayload } from '../../../../lib/intake/normalize-cognito-payload'
import { readCognitoBody } from '../../../../lib/intake/read-cognito-body'
import { validateCognitoWebhookHeaders } from '../../../../lib/intake/validate-cognito-webhook'
import { getPayloadPreview } from '../../../../lib/intake/get-payload-preview'
import { createClaimFromSubmission } from '../../../../lib/claims/create-claim-from-submission'

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
  logWithRequestId(requestId, 'raw keys', payloadPreview.topLevelKeys)

  try {
    const normalizedPayload = normalizeCognitoPayload(rawPayload)
    logWithRequestId(requestId, 'normalized')

    const validatedPayload = parseNormalizedIntakePayload(normalizedPayload)
    const createClaimInput = toCreateClaimFromIntakeInput(validatedPayload)

    logWithRequestId(requestId, 'validation succeeded')

    const claimCreationResult = await createClaimFromSubmission(createClaimInput)

    if (!claimCreationResult.ok) {
      logErrorWithRequestId(requestId, 'claim creation failed', {
        error: claimCreationResult.error,
        message: claimCreationResult.message
      })

      return respond(requestId, 500, {
        ok: false,
        requestId,
        error: claimCreationResult.error,
        message: 'Claim creation failed'
      })
    }

    logWithRequestId(requestId, 'claim created', {
      claimId: claimCreationResult.claim.id,
      claimNumber: claimCreationResult.claim.claimNumber,
      status: claimCreationResult.claim.status
    })

    if (debugMode) {
      return respond(requestId, 200, {
        ok: true,
        requestId,
        message: 'Claim created successfully',
        claim: claimCreationResult.claim,
        topLevelKeys: payloadPreview.topLevelKeys,
        payloadPreview,
        normalizedPayload: validatedPayload,
        createClaimInput
      })
    }

    return respond(requestId, 200, {
      ok: true,
      requestId,
      message: 'Claim created successfully',
      claim: claimCreationResult.claim
    })
  } catch (error) {
    if (error instanceof ZodError) {
      logWarnWithRequestId(requestId, 'validation failed', error.issues)
      return respond(
        requestId,
        400,
        {
          ok: false,
          requestId,
          error: 'validation_failed',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message
          }))
        }
      )
    }

    logErrorWithRequestId(requestId, 'internal error', error)
    return respond(requestId, 500, { ok: false, requestId, error: 'internal_error' })
  }
}

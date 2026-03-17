export const COGNITO_WEBHOOK_SECRET_HEADER = 'x-webhook-secret'

type ValidateWebhookResult =
  | { ok: true; mode: 'skipped' | 'validated' }
  | { ok: false; reason: 'missing_header' | 'secret_mismatch' }

export function validateCognitoWebhookHeaders(headers: Headers): ValidateWebhookResult {
  const configuredSecret = process.env.COGNITO_WEBHOOK_SECRET

  if (!configuredSecret) {
    return { ok: true, mode: 'skipped' }
  }

  const providedSecret = headers.get(COGNITO_WEBHOOK_SECRET_HEADER)

  if (!providedSecret) {
    return { ok: false, reason: 'missing_header' }
  }

  if (providedSecret !== configuredSecret) {
    return { ok: false, reason: 'secret_mismatch' }
  }

  return { ok: true, mode: 'validated' }
}

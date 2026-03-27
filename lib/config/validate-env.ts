type ValidationScope = 'app' | 'worker' | 'queue'

type EnvCheckResult = {
  key: string
  value: string | null
}

const validatedScopes = new Set<ValidationScope>()

const requiredEnvKeysByScope: Record<ValidationScope, string[]> = {
  app: [],
  worker: ['REDIS_URL', 'DATABASE_URL'],
  queue: ['REDIS_URL', 'DATABASE_URL']
}

function readEnvValue(key: string): EnvCheckResult {
  const raw = process.env[key]
  if (raw === undefined) {
    return { key, value: null }
  }

  const trimmed = raw.trim()
  return { key, value: trimmed.length > 0 ? trimmed : null }
}

function logConfigInfo(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.info(`[config] ${message}`, details)
    return
  }

  console.info(`[config] ${message}`)
}

function logConfigWarn(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.warn(`[config] ${message}`, details)
    return
  }

  console.warn(`[config] ${message}`)
}

function validateUrl(value: string, key: string, logSuccess = true): void {
  try {
    const parsed = new URL(value)

    if (key === 'REDIS_URL' || key === 'QUEUE_PREREDIS_URL') {
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        logConfigWarn(`${key} invalid URL protocol`, {
          expected: ['redis:', 'rediss:'],
          actual: parsed.protocol
        })
        return
      }
    }

    if (key === 'DATABASE_URL') {
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        logConfigWarn(`${key} invalid URL protocol`, {
          expected: ['postgres:', 'postgresql:'],
          actual: parsed.protocol
        })
        return
      }
    }

    if (logSuccess) {
      logConfigInfo(`${key} ok`)
    }
  } catch {
    logConfigWarn(`${key} invalid URL`)
  }
}

function requireEnv(key: string): string {
  const result = readEnvValue(key)
  if (!result.value) {
    throw new Error(`[config] ${key} missing (required)`)
  }

  return result.value
}

function warnOptionalMissing(key: string, note: string): void {
  const result = readEnvValue(key)
  if (!result.value) {
    logConfigWarn(`${key} missing (${note})`)
  } else if (key.endsWith('_URL')) {
    validateUrl(result.value, key, false)
  }
}

function warnOptionalUrl(key: string, note: string): void {
  const result = readEnvValue(key)
  if (!result.value) {
    logConfigWarn(`${key} missing (${note})`)
    return
  }

  validateUrl(result.value, key, false)
}

export function validateEnvConfig(scope: ValidationScope = 'app'): void {
  logConfigInfo(`startup validation begin (${scope})`)

  const requiredKeys = requiredEnvKeysByScope[scope]
  const redisUrl = requiredKeys.includes('REDIS_URL')
    ? requireEnv('REDIS_URL')
    : readEnvValue('REDIS_URL').value
  const databaseUrl = requiredKeys.includes('DATABASE_URL')
    ? requireEnv('DATABASE_URL')
    : readEnvValue('DATABASE_URL').value
  const queuePrefix = readEnvValue('QUEUE_PREFIX').value

  if (redisUrl) {
    validateUrl(redisUrl, 'REDIS_URL')
  } else {
    logConfigWarn('REDIS_URL missing (queue features unavailable until configured)')
  }

  if (databaseUrl) {
    validateUrl(databaseUrl, 'DATABASE_URL')
  } else {
    logConfigWarn('DATABASE_URL missing (database-backed routes unavailable until configured)')
  }

  const queuePreRedisRaw = process.env.QUEUE_PREREDIS_URL
  if (queuePreRedisRaw !== undefined) {
    const queuePreRedis = queuePreRedisRaw.trim()

    if (!queuePreRedis) {
      throw new Error('[config] QUEUE_PREREDIS_URL missing (required when used)')
    }

    validateUrl(queuePreRedis, 'QUEUE_PREREDIS_URL')
  }

  if (queuePrefix) {
    logConfigInfo('QUEUE_PREFIX ok')
  } else {
    logConfigWarn('QUEUE_PREFIX missing (defaulting to choice-claims)')
  }

  warnOptionalMissing('OPENAI_API_KEY', 'summary disabled')
  warnOptionalMissing('CARFAX_API_KEY', 'carfax provider may be unavailable')
  warnOptionalMissing('AUTOCHECK_API_KEY', 'autocheck provider may be unavailable')
  warnOptionalMissing('MARKETCHECK_API_KEY', 'stub mode')
  warnOptionalMissing('SERVICE_HISTORY_API_KEY', 'service provider fallback/stub may apply')
  warnOptionalMissing('VALUATION_API_KEY', 'valuation provider fallback/stub may apply')
  warnOptionalMissing('AUTOCHECK_PROVIDER_DEBUG', 'provider debug logs default to disabled')
  warnOptionalMissing('PCMI_CLIENT_ID', 'pcmi provider integration will be unavailable')
  warnOptionalMissing('PCMI_CLIENT_SECRET', 'pcmi provider integration will be unavailable')
  warnOptionalMissing('PCMI_USERNAME', 'pcmi provider integration will be unavailable')
  warnOptionalMissing('PCMI_PASSWORD', 'pcmi provider integration will be unavailable')
  warnOptionalUrl('MARKETCHECK_API_URL', 'decode provider uses default URL when omitted')
  warnOptionalUrl('SERVICE_HISTORY_API_URL', 'service provider fallback/stub may apply')
  warnOptionalUrl('VALUATION_API_URL', 'valuation provider fallback/stub may apply')
  warnOptionalUrl('NHTSA_RECALLS_API_URL', 'recalls provider uses default URL when omitted')
  warnOptionalUrl('EXPERIAN_BASE_URL', 'autocheck live provider may be unavailable')
  warnOptionalUrl('PCMI_BASE_URL', 'pcmi provider integration will be unavailable')
  warnOptionalUrl('PCMI_TOKEN_URL', 'pcmi token URL defaults to PCMI_BASE_URL/Pcmi.Web.Sts/token')

  logConfigInfo(`startup validation complete (${scope})`)
}

export function ensureEnvConfigValidated(scope: ValidationScope): void {
  if (validatedScopes.has(scope)) {
    return
  }

  validateEnvConfig(scope)
  validatedScopes.add(scope)
}

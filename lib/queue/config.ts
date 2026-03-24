import type { ConnectionOptions } from 'bullmq'
import { ensureEnvConfigValidated } from '../config/validate-env'

const DEFAULT_QUEUE_PREFIX = 'choice-claims'

export type QueueRuntimeConfig = {
  connection: ConnectionOptions
  prefix: string
}

function toRedisConnectionOptions(redisUrl: string): ConnectionOptions {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(redisUrl)
  } catch {
    throw new Error(
      '[QUEUE_CONFIG] REDIS_URL must be a valid redis:// or rediss:// URL when queue infrastructure is used.'
    )
  }

  if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
    throw new Error('[QUEUE_CONFIG] REDIS_URL must use redis:// or rediss:// protocol')
  }

  const parsedPort = parsedUrl.port ? Number(parsedUrl.port) : 6379
  if (!Number.isFinite(parsedPort)) {
    throw new Error('[QUEUE_CONFIG] REDIS_URL port is invalid')
  }

  let db: number | undefined
  const dbPath = parsedUrl.pathname.replace('/', '')

  if (dbPath) {
    const parsedDb = Number(dbPath)

    if (!Number.isInteger(parsedDb) || parsedDb < 0) {
      throw new Error('[QUEUE_CONFIG] REDIS_URL database index must be a non-negative integer')
    }

    db = parsedDb
  }

  return {
    host: parsedUrl.hostname,
    port: parsedPort,
    username: parsedUrl.username || undefined,
    password: parsedUrl.password || undefined,
    db,
    tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    // BullMQ workers require this for reliability on blocking Redis operations.
    maxRetriesPerRequest: null,
    // Upstash commonly blocks INFO for constrained users.
    enableReadyCheck: false
  }
}

function readRedisUrl(): string {
  const queueSpecificRedisUrl = process.env.QUEUE_PREREDIS_URL?.trim()
  if (queueSpecificRedisUrl) {
    return queueSpecificRedisUrl
  }

  const value = process.env.REDIS_URL?.trim()

  if (!value) {
    throw new Error(
      '[QUEUE_CONFIG] Missing required environment variable: REDIS_URL (or QUEUE_PREREDIS_URL). Set one before using queue infrastructure.'
    )
  }

  return value
}

export function getQueuePrefix(): string {
  ensureEnvConfigValidated('queue')

  const raw = process.env.QUEUE_PREFIX?.trim()
  if (!raw) {
    console.warn(
      `[QUEUE_CONFIG] QUEUE_PREFIX missing; defaulting to ${DEFAULT_QUEUE_PREFIX}. Set QUEUE_PREFIX explicitly to avoid cross-environment collisions.`
    )
    return DEFAULT_QUEUE_PREFIX
  }

  return raw
}

export function getRedisConnection(): ConnectionOptions {
  ensureEnvConfigValidated('queue')
  return toRedisConnectionOptions(readRedisUrl())
}

export function getQueueRuntimeConfig(): QueueRuntimeConfig {
  ensureEnvConfigValidated('queue')

  return {
    connection: getRedisConnection(),
    prefix: getQueuePrefix()
  }
}

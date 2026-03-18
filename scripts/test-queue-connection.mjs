import { Queue } from 'bullmq'

const DEFAULT_QUEUE_PREFIX = 'choice-claims'

function readRequiredEnv(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      `[QUEUE_CONFIG] Missing required environment variable: ${name}. Set ${name} before running queue infrastructure.`
    )
  }

  return value
}

function toRedisConnectionOptions(redisUrl) {
  let parsedUrl

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

  const dbPath = parsedUrl.pathname.replace('/', '')
  const db = dbPath ? Number(dbPath) : undefined

  if (dbPath && (!Number.isInteger(db) || db < 0)) {
    throw new Error('[QUEUE_CONFIG] REDIS_URL database index must be a non-negative integer')
  }

  return {
    host: parsedUrl.hostname,
    port: parsedPort,
    username: parsedUrl.username || undefined,
    password: parsedUrl.password || undefined,
    db,
    tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    enableReadyCheck: false
  }
}

function getQueueRuntimeConfig() {
  const connection = toRedisConnectionOptions(readRequiredEnv('REDIS_URL'))
  const prefix = process.env.QUEUE_PREFIX?.trim() || DEFAULT_QUEUE_PREFIX

  return {
    connection,
    prefix
  }
}

async function main() {
  try {
    const { connection, prefix } = getQueueRuntimeConfig()
    const queue = new Queue('__queue_connectivity_smoke_test__', {
      connection,
      prefix
    })
    const client = await queue.client
    const pingResult = await client.ping()

    console.info('[QUEUE_SMOKE_TEST] Redis connection successful', {
      prefix,
      ping: pingResult
    })

    await queue.close()
  } catch (error) {
    console.error('[QUEUE_SMOKE_TEST] Redis/BullMQ connection failed', error)
    process.exitCode = 1
  }
}

void main()

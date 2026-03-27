import type { PrismaClient as PrismaClientType } from '@prisma/client'
import { readRuntimeEnv } from './config/runtime-env'

declare global {
  var __prismaEnvDiagnosticsLogged: boolean | undefined
}

function getResolvedDatabaseUrl(): string | null {
  const databaseUrl = readRuntimeEnv('DATABASE_URL')
  if (databaseUrl) {
    return databaseUrl
  }

  const directUrl = readRuntimeEnv('DIRECT_URL')
  if (directUrl) {
    return directUrl
  }

  return null
}

const resolvedDatabaseUrl = getResolvedDatabaseUrl()

if (!globalThis.__prismaEnvDiagnosticsLogged) {
  console.info('[prisma] env diagnostics', {
    hasDatabaseUrl: Boolean(readRuntimeEnv('DATABASE_URL')),
    hasDirectUrl: Boolean(readRuntimeEnv('DIRECT_URL')),
    hasResolvedDatabaseUrl: Boolean(resolvedDatabaseUrl),
    nodeEnv: readRuntimeEnv('NODE_ENV')
  })
  globalThis.__prismaEnvDiagnosticsLogged = true
}

// Prisma schema uses DATABASE_URL; keep it populated for Prisma internals and logs.
if (!process.env.DATABASE_URL && resolvedDatabaseUrl) {
  process.env.DATABASE_URL = resolvedDatabaseUrl
}

if (!resolvedDatabaseUrl) {
  console.warn('[prisma] missing DATABASE_URL and DIRECT_URL; database queries will fail')
}

// Load Prisma client after env fallback is in place to avoid import-time schema env failures.
const { PrismaClient } = require('@prisma/client') as {
  PrismaClient: new (...args: any[]) => PrismaClientType
}

declare global {
  var prisma: PrismaClientType | undefined
}

export const prisma =
  globalThis.prisma ??
  new PrismaClient({
    ...(resolvedDatabaseUrl ? { datasources: { db: { url: resolvedDatabaseUrl } } } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma
}

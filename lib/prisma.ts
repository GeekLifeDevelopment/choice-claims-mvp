import type { PrismaClient as PrismaClientType } from '@prisma/client'

function getResolvedDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) {
    return databaseUrl
  }

  const directUrl = process.env.DIRECT_URL?.trim()
  if (directUrl) {
    return directUrl
  }

  return null
}

const resolvedDatabaseUrl = getResolvedDatabaseUrl()

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

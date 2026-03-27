import { PrismaClient } from '@prisma/client'

// Prisma datasource URL is DATABASE_URL. In some deploys only DIRECT_URL is configured,
// so map it as a runtime fallback before client initialization.
if (!process.env.DATABASE_URL && process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL
}

declare global {
  var prisma: PrismaClient | undefined
}

export const prisma =
  globalThis.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma
}

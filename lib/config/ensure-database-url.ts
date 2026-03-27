import { readRuntimeEnv } from './runtime-env'

declare global {
  var __databaseUrlFallbackLogged: boolean | undefined
}

const databaseUrl = readRuntimeEnv('DATABASE_URL')
if (!databaseUrl) {
  const directUrl = readRuntimeEnv('DIRECT_URL')
  if (directUrl) {
    process.env.DATABASE_URL = directUrl

    if (!globalThis.__databaseUrlFallbackLogged) {
      console.warn('[config] DATABASE_URL missing; using DIRECT_URL fallback')
      globalThis.__databaseUrlFallbackLogged = true
    }
  }
}

export {}
declare global {
  var __databaseUrlFallbackLogged: boolean | undefined
}

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) {
  const directUrl = process.env.DIRECT_URL?.trim()
  if (directUrl) {
    process.env.DATABASE_URL = directUrl

    if (!globalThis.__databaseUrlFallbackLogged) {
      console.warn('[config] DATABASE_URL missing; using DIRECT_URL fallback')
      globalThis.__databaseUrlFallbackLogged = true
    }
  }
}

export {}
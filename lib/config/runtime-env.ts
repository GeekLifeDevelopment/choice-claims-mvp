export function readRuntimeEnv(key: string): string | null {
  const value = process.env[key]

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
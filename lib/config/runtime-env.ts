export function readRuntimeEnv(key: string): string | null {
  const runtimeEnv = globalThis.process?.env
  const value = runtimeEnv ? runtimeEnv[key] : undefined

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
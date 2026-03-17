type UnknownRecord = Record<string, unknown>

type PayloadPreview = {
  topLevelKeys: string[]
  vin?: string
  claimantName?: string
  claimantEmail?: string
  claimantPhone?: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function findFirstString(raw: unknown, candidateKeys: string[]): string | undefined {
  const queue: unknown[] = [raw]
  const visited = new Set<unknown>()
  const normalizedCandidates = new Set(candidateKeys.map(normalizeKey))
  const maxNodes = 1000

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift()

    if (!current || visited.has(current)) {
      continue
    }

    visited.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    if (!isRecord(current)) {
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (normalizedCandidates.has(normalizeKey(key)) && typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }

    queue.push(...Object.values(current))
  }

  return undefined
}

export function getPayloadPreview(rawPayload: unknown): PayloadPreview {
  const topLevelKeys = isRecord(rawPayload) ? Object.keys(rawPayload).slice(0, 20) : []

  return {
    topLevelKeys,
    vin: findFirstString(rawPayload, ['vin', 'full vin #', 'vehicle vin']),
    claimantName: findFirstString(rawPayload, ['customerName', 'customer name', 'name', 'signed name']),
    claimantEmail: findFirstString(rawPayload, ['customerEmail', 'customer email', 'email']),
    claimantPhone: findFirstString(rawPayload, ['customerPhone', 'customer phone', 'phone'])
  }
}

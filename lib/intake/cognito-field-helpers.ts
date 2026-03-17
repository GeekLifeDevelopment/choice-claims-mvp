type UnknownRecord = Record<string, unknown>

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord
  }

  return undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return undefined
}

export function getCognitoNameValue(value: unknown): string | undefined {
  const record = asRecord(value)

  if (!record) {
    return asNonEmptyString(value)
  }

  const firstAndLast = asNonEmptyString(record.FirstAndLast)
  if (firstAndLast) {
    return firstAndLast
  }

  const first = asNonEmptyString(record.First)
  const last = asNonEmptyString(record.Last)

  if (first && last) {
    return `${first} ${last}`
  }

  return first || last
}

export function getCognitoAddressValue(value: unknown): string | undefined {
  const record = asRecord(value)

  if (!record) {
    return asNonEmptyString(value)
  }

  const fullAddress = asNonEmptyString(record.FullAddress)
  if (fullAddress) {
    return fullAddress
  }

  const parts = [
    asNonEmptyString(record.AddressLine1),
    asNonEmptyString(record.AddressLine2),
    asNonEmptyString(record.City),
    asNonEmptyString(record.State),
    asNonEmptyString(record.ZipCode)
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(', ') : undefined
}

export function getCognitoEntryTimestamp(entry: unknown): string | undefined {
  const record = asRecord(entry)

  if (!record) {
    return undefined
  }

  const preferred = asNonEmptyString(record.DateSubmitted) || asNonEmptyString(record.Timestamp)
  if (!preferred) {
    return undefined
  }

  const parsed = Date.parse(preferred)
  if (Number.isNaN(parsed)) {
    return undefined
  }

  return new Date(parsed).toISOString()
}

export function getCognitoTopLevelString(payload: unknown, key: string): string | undefined {
  const record = asRecord(payload)
  if (!record) {
    return undefined
  }

  return asNonEmptyString(record[key])
}

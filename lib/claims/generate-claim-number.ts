import { randomInt } from 'crypto'

function formatDatePart(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')

  return `${year}${month}${day}`
}

function formatSequence(value: number): string {
  return String(value).padStart(4, '0')
}

export function generateClaimNumber(now: Date = new Date()): string {
  const datePart = formatDatePart(now)
  const sequence = formatSequence(randomInt(0, 10000))

  return `CC-${datePart}-${sequence}`
}

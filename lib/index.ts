// Placeholder shared utilities for the Choice Claims MVP

export function formatDateISO(date?: Date) {
  const d = date ?? new Date()
  return d.toISOString()
}

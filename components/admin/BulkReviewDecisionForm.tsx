'use client'

import { useEffect, useMemo, useState } from 'react'

type BulkReviewDecisionFormProps = {
  returnTo: string
}

const BULK_DECISION_VALUES = [
  { value: '', label: 'Choose action...' },
  { value: 'Approved', label: 'Approve' },
  { value: 'Denied', label: 'Reject' },
  { value: 'NeedsReview', label: 'NeedsReview' }
] as const

export function BulkReviewDecisionForm({ returnTo }: BulkReviewDecisionFormProps) {
  const [decision, setDecision] = useState('')
  const [allUnlockedSelected, setAllUnlockedSelected] = useState(false)
  const [selectedCount, setSelectedCount] = useState(0)

  useEffect(() => {
    const syncSelectionState = () => {
      const allCheckboxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="claimIds"]')
      )
      const unlocked = allCheckboxes.filter((checkbox) => !checkbox.disabled)
      const selected = unlocked.filter((checkbox) => checkbox.checked)

      setSelectedCount(selected.length)
      setAllUnlockedSelected(unlocked.length > 0 && selected.length === unlocked.length)
    }

    const onChange = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement)) {
        return
      }

      if (target.name === 'claimIds') {
        syncSelectionState()
      }
    }

    document.addEventListener('change', onChange)
    syncSelectionState()

    return () => {
      document.removeEventListener('change', onChange)
    }
  }, [])

  const canSubmit = useMemo(() => decision.length > 0 && selectedCount > 0, [decision, selectedCount])

  const toggleAllUnlocked = (checked: boolean) => {
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="claimIds"]')
    )

    for (const checkbox of checkboxes) {
      if (checkbox.disabled) {
        continue
      }

      checkbox.checked = checked
    }

    const selectedUnlocked = checkboxes.filter((checkbox) => !checkbox.disabled && checkbox.checked)
    const unlockedCount = checkboxes.filter((checkbox) => !checkbox.disabled).length

    setSelectedCount(selectedUnlocked.length)
    setAllUnlockedSelected(unlockedCount > 0 && selectedUnlocked.length === unlockedCount)
  }

  return (
    <form
      id="bulk-review-form"
      action="/api/admin/claims/bulk-review-decision"
      method="post"
      className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-white p-2"
    >
      <input type="hidden" name="returnTo" value={returnTo} />

      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={allUnlockedSelected}
          onChange={(event) => toggleAllUnlocked(event.currentTarget.checked)}
          className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          aria-label="Select all unlocked claims"
        />
        Select all
      </label>

      <label className="flex min-w-[220px] flex-col gap-1 text-sm text-slate-700">
        <span className="font-medium">Bulk action</span>
        <select
          name="decision"
          value={decision}
          onChange={(event) => setDecision(event.currentTarget.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
        >
          {BULK_DECISION_VALUES.map((option) => (
            <option key={option.value || 'empty'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex items-center rounded-md border border-slate-300 bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Apply ({selectedCount})
      </button>

      <span className="text-xs text-slate-600">Locked claims are skipped automatically.</span>
    </form>
  )
}

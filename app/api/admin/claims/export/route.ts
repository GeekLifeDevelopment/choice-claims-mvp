import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { ClaimStatus } from '../../../../../lib/domain/claims'
import { prisma } from '../../../../../lib/prisma'
import { isFinalReviewDecision } from '../../../../../lib/review/claim-lock'

const STATUS_FILTER_VALUES = [
  'all',
  ClaimStatus.Submitted,
  ClaimStatus.AwaitingVinData,
  ClaimStatus.ReadyForAI,
  ClaimStatus.ProviderFailed,
  ClaimStatus.ProcessingError
] as const

type StatusFilterValue = (typeof STATUS_FILTER_VALUES)[number]

const DECISION_FILTER_VALUES = ['all', 'Unset', 'NeedsReview', 'Approved', 'Denied'] as const
type DecisionFilterValue = (typeof DECISION_FILTER_VALUES)[number]

const SUMMARY_FILTER_VALUES = ['all', 'NotRequested', 'Queued', 'Generated', 'Failed'] as const
type SummaryFilterValue = (typeof SUMMARY_FILTER_VALUES)[number]

const SORT_FILTER_VALUES = [
  'submitted_desc',
  'submitted_asc',
  'updated_desc',
  'evaluated_desc',
  'summarized_desc'
] as const
type SortFilterValue = (typeof SORT_FILTER_VALUES)[number]

function isValidFilterValue<T extends readonly string[]>(value: string | null, allowed: T): value is T[number] {
  return Boolean(value && allowed.includes(value as T[number]))
}

function getSortOrder(sort: SortFilterValue): Prisma.ClaimOrderByWithRelationInput[] {
  if (sort === 'submitted_asc') {
    return [{ submittedAt: 'asc' }]
  }

  if (sort === 'updated_desc') {
    return [{ updatedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  if (sort === 'evaluated_desc') {
    return [{ reviewRuleEvaluatedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  if (sort === 'summarized_desc') {
    return [{ reviewSummaryGeneratedAt: 'desc' }, { submittedAt: 'desc' }]
  }

  return [{ submittedAt: 'desc' }]
}

function toCsvCell(value: string | number | boolean | null | undefined): string {
  const normalized = value == null ? '' : String(value)
  const escaped = normalized.replaceAll('"', '""')
  return `"${escaped}"`
}

function buildCsv(input: {
  rows: Array<{
    id: string
    claimNumber: string
    submittedAt: Date
    updatedAt: Date
    claimantName: string | null
    vin: string | null
    status: string
    vinDataProvider: string | null
    reviewSummaryStatus: string | null
    reviewDecision: string | null
  }>
}): string {
  const headers = [
    'claim_id',
    'claim_number',
    'submitted_at',
    'updated_at',
    'claimant_name',
    'vin',
    'provider_status',
    'provider_name',
    'summary_status',
    'reviewer_decision',
    'locked_state'
  ]

  const lines = [headers.map((header) => toCsvCell(header)).join(',')]

  for (const row of input.rows) {
    const summaryStatus = row.reviewSummaryStatus || 'NotRequested'
    const decision = row.reviewDecision || 'Unset'
    const lockedState = isFinalReviewDecision(row.reviewDecision) ? 'Locked' : 'Unlocked'

    const values = [
      row.id,
      row.claimNumber,
      row.submittedAt.toISOString(),
      row.updatedAt.toISOString(),
      row.claimantName || '',
      row.vin || '',
      row.status,
      row.vinDataProvider || '',
      summaryStatus,
      decision,
      lockedState
    ]

    lines.push(values.map((value) => toCsvCell(value)).join(','))
  }

  return lines.join('\n')
}

export async function GET(request: NextRequest) {
  const statusParam = request.nextUrl.searchParams.get('status')
  const decisionParam = request.nextUrl.searchParams.get('decision')
  const summaryParam = request.nextUrl.searchParams.get('summary')
  const sortParam = request.nextUrl.searchParams.get('sort')

  const selectedStatus: StatusFilterValue = isValidFilterValue(statusParam, STATUS_FILTER_VALUES)
    ? statusParam
    : 'all'
  const selectedDecision: DecisionFilterValue = isValidFilterValue(decisionParam, DECISION_FILTER_VALUES)
    ? decisionParam
    : 'all'
  const selectedSummary: SummaryFilterValue = isValidFilterValue(summaryParam, SUMMARY_FILTER_VALUES)
    ? summaryParam
    : 'all'
  const selectedSort: SortFilterValue = isValidFilterValue(sortParam, SORT_FILTER_VALUES)
    ? sortParam
    : 'submitted_desc'

  const whereClauses: Prisma.ClaimWhereInput[] = []

  if (selectedStatus !== 'all') {
    whereClauses.push({ status: selectedStatus })
  }

  if (selectedDecision === 'Unset') {
    whereClauses.push({ reviewDecision: null })
  } else if (selectedDecision !== 'all') {
    whereClauses.push({ reviewDecision: selectedDecision })
  }

  if (selectedSummary === 'NotRequested') {
    whereClauses.push({ OR: [{ reviewSummaryStatus: null }, { reviewSummaryStatus: 'NotRequested' }] })
  } else if (selectedSummary !== 'all') {
    whereClauses.push({ reviewSummaryStatus: selectedSummary })
  }

  const where: Prisma.ClaimWhereInput | undefined =
    whereClauses.length > 0 ? { AND: whereClauses } : undefined

  const orderBy = getSortOrder(selectedSort)

  const rows = await prisma.claim.findMany({
    where,
    orderBy,
    select: {
      id: true,
      claimNumber: true,
      submittedAt: true,
      updatedAt: true,
      claimantName: true,
      vin: true,
      status: true,
      vinDataProvider: true,
      reviewSummaryStatus: true,
      reviewDecision: true
    }
  })

  const csv = buildCsv({ rows })
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/, '')

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="claims-export-${timestamp}.csv"`,
      'Cache-Control': 'no-store'
    }
  })
}

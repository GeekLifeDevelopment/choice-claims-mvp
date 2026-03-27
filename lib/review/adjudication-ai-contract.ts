import type {
  AdjudicationEvidenceEntry,
  AdjudicationQuestionStatus,
  AdjudicationSourceType
} from './adjudication-result'

export const ADJUDICATION_AI_SUPPORTED_QUESTION_IDS = [
  'document_match',
  'image_modifications',
  'obd_codes',
  'prior_repairs',
  'warranty_support'
] as const

export type AdjudicationAiQuestionId = (typeof ADJUDICATION_AI_SUPPORTED_QUESTION_IDS)[number]

export type AdjudicationAiFinding = {
  questionId: AdjudicationAiQuestionId
  status: AdjudicationQuestionStatus
  scoreSuggestion?: number
  explanation: string
  evidence: AdjudicationEvidenceEntry[]
  confidence?: number
  sourceType: AdjudicationSourceType
}

type AdjudicationAiEnvelope = {
  findings: AdjudicationAiFinding[]
}

type ParsedAiJson = {
  value: unknown
  malformedJson: boolean
}

const ALLOWED_STATUSES = new Set<AdjudicationQuestionStatus>([
  'scored',
  'insufficient_data',
  'not_applicable',
  'provider_unavailable'
])

const ALLOWED_SOURCE_TYPES = new Set<AdjudicationSourceType>(['provider', 'claim', 'documents', 'system'])

const ALLOWED_QUESTION_IDS = new Set<string>(ADJUDICATION_AI_SUPPORTED_QUESTION_IDS)

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseEvidence(input: unknown): AdjudicationEvidenceEntry[] {
  if (!Array.isArray(input)) {
    return []
  }

  return input
    .map((entry) => {
      const record = asRecord(entry)
      const label = getOptionalString(record.label)
      const value = record.value

      if (!label) {
        return null
      }

      const isAllowedValueType =
        value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

      if (!isAllowedValueType) {
        return null
      }

      return {
        label,
        value
      }
    })
    .filter((entry): entry is AdjudicationEvidenceEntry => Boolean(entry))
}

function parseFinding(input: unknown): AdjudicationAiFinding | null {
  const record = asRecord(input)
  const questionId = getOptionalString(record.questionId)
  const status = getOptionalString(record.status)
  const explanation = getOptionalString(record.explanation)
  const sourceType = getOptionalString(record.sourceType)

  if (!questionId || !ALLOWED_QUESTION_IDS.has(questionId)) {
    return null
  }

  if (!status || !ALLOWED_STATUSES.has(status as AdjudicationQuestionStatus)) {
    return null
  }

  if (!explanation) {
    return null
  }

  if (!sourceType || !ALLOWED_SOURCE_TYPES.has(sourceType as AdjudicationSourceType)) {
    return null
  }

  const scoreSuggestionRaw = record.scoreSuggestion
  const scoreSuggestion = getOptionalNumber(scoreSuggestionRaw)
  if (scoreSuggestionRaw !== undefined && (scoreSuggestion === undefined || scoreSuggestion < 0 || scoreSuggestion > 100)) {
    return null
  }

  const confidenceRaw = record.confidence
  const confidence = getOptionalNumber(confidenceRaw)
  if (confidenceRaw !== undefined && (confidence === undefined || confidence < 0 || confidence > 1)) {
    return null
  }

  return {
    questionId: questionId as AdjudicationAiQuestionId,
    status: status as AdjudicationQuestionStatus,
    scoreSuggestion,
    explanation,
    evidence: parseEvidence(record.evidence),
    confidence,
    sourceType: sourceType as AdjudicationSourceType
  }
}

function tryParseJsonObject(raw: string): ParsedAiJson {
  try {
    return {
      value: JSON.parse(raw),
      malformedJson: false
    }
  } catch {
    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace <= firstBrace) {
      return {
        value: null,
        malformedJson: true
      }
    }

    try {
      return {
        value: JSON.parse(raw.slice(firstBrace, lastBrace + 1)),
        malformedJson: true
      }
    } catch {
      return {
        value: null,
        malformedJson: true
      }
    }
  }
}

export function parseAdjudicationAiEnvelope(raw: string): {
  findings: AdjudicationAiFinding[]
  rejectedCount: number
  findingsInputCount: number
  malformedJson: boolean
} {
  const parsed = tryParseJsonObject(raw)
  const record = asRecord(parsed.value)
  const findingsInput = Array.isArray(record.findings) ? record.findings : []

  const findings = findingsInput
    .map((entry) => parseFinding(entry))
    .filter((entry): entry is AdjudicationAiFinding => Boolean(entry))

  const result: AdjudicationAiEnvelope = {
    findings
  }

  return {
    findings: result.findings,
    rejectedCount: Math.max(0, findingsInput.length - result.findings.length),
    findingsInputCount: findingsInput.length,
    malformedJson: parsed.malformedJson
  }
}

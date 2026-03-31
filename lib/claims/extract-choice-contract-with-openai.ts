import { z } from 'zod'
import { isFeatureEnabled } from '../config/feature-flags'
import { getOpenAiTimeoutMs } from '../providers/config'

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_CHOICE_CONTRACT_OCR_MODEL = process.env.CHOICE_CONTRACT_OCR_MODEL || 'gpt-4.1-mini'
const MAX_FALLBACK_FILE_BYTES = 8 * 1024 * 1024

type ChoiceContractOpenAiData = {
  vin?: string
  agreementNumber?: string
  mileageAtSale?: number
  vehiclePurchaseDate?: string
  agreementPurchaseDate?: string
  agreementPrice?: number
  coverageLevel?: string
  termMonths?: number
  termMiles?: number
  deductible?: number
  coverageSummary?: string
  selectedAddOnsSummary?: string
  waitingPeriod?: string
}

export type ChoiceContractOpenAiFallbackResult = {
  status: 'succeeded' | 'partial' | 'failed' | 'skipped'
  attempted: boolean
  extractedAt: string
  data: ChoiceContractOpenAiData
  warnings: string[]
  confidence: number | null
  failureReason: string | null
}

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vin: { type: ['string', 'null'] },
    agreementNumber: { type: ['string', 'null'] },
    mileageAtSale: { type: ['number', 'integer', 'null'] },
    vehiclePurchaseDate: { type: ['string', 'null'] },
    agreementPurchaseDate: { type: ['string', 'null'] },
    agreementPrice: { type: ['number', 'null'] },
    coverageLevel: { type: ['string', 'null'] },
    termMonths: { type: ['number', 'integer', 'null'] },
    termMiles: { type: ['number', 'integer', 'null'] },
    deductible: { type: ['number', 'null'] },
    coverageSummary: { type: ['string', 'null'] },
    selectedAddOnsSummary: { type: ['string', 'null'] },
    waitingPeriod: { type: ['string', 'null'] },
    extractionConfidence: { type: ['number', 'null'] },
    extractionWarnings: {
      type: ['array', 'null'],
      items: { type: 'string' }
    }
  },
  required: [
    'vin',
    'agreementNumber',
    'mileageAtSale',
    'vehiclePurchaseDate',
    'agreementPurchaseDate',
    'agreementPrice',
    'coverageLevel',
    'termMonths',
    'termMiles',
    'deductible',
    'coverageSummary',
    'selectedAddOnsSummary',
    'waitingPeriod',
    'extractionConfidence',
    'extractionWarnings'
  ]
} as const

const responseSchema = z
  .object({
    vin: z.string().nullable(),
    agreementNumber: z.string().nullable(),
    mileageAtSale: z.number().nullable(),
    vehiclePurchaseDate: z.string().nullable(),
    agreementPurchaseDate: z.string().nullable(),
    agreementPrice: z.number().nullable(),
    coverageLevel: z.string().nullable(),
    termMonths: z.number().nullable(),
    termMiles: z.number().nullable(),
    deductible: z.number().nullable(),
    coverageSummary: z.string().nullable(),
    selectedAddOnsSummary: z.string().nullable(),
    waitingPeriod: z.string().nullable(),
    extractionConfidence: z.number().min(0).max(1).nullable(),
    extractionWarnings: z.array(z.string()).nullable()
  })
  .strict()

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeVin(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value)
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalized) ? normalized : null
}

function normalizeMoney(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }

  return Math.round(value * 100) / 100
}

function normalizeInt(value: number | null | undefined, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  const rounded = Math.round(value)
  if (rounded < min || rounded > max) {
    return null
  }

  return rounded
}

function normalizeDate(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value)
  if (!trimmed) {
    return null
  }

  const parsed = new Date(trimmed)
  if (!Number.isFinite(parsed.getTime())) {
    return null
  }

  return parsed.toISOString().slice(0, 10)
}

function getOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const direct = (payload as { output_text?: unknown }).output_text
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct
  }

  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) {
    return null
  }

  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }

    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) {
      continue
    }

    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        continue
      }

      const text = (part as { text?: unknown }).text
      if (typeof text === 'string' && text.trim().length > 0) {
        return text
      }
    }
  }

  return null
}

function countMeaningfulFields(data: ChoiceContractOpenAiData): number {
  return Object.values(data).filter((value) => {
    if (typeof value === 'number') {
      return Number.isFinite(value)
    }

    if (typeof value === 'string') {
      return value.trim().length > 0
    }

    return false
  }).length
}

function buildSystemPrompt(): string {
  return [
    'You extract fields from a Choice Auto Protection vehicle service contract PDF.',
    'Respond with strict JSON only and no prose.',
    'Do not hallucinate. Use null when a field is not clearly visible.',
    'Only use values that appear in the uploaded contract document.',
    'Use ISO date format YYYY-MM-DD when possible.',
    'extractionConfidence is a number 0 to 1 for overall reliability.',
    'extractionWarnings should be brief strings describing uncertainty.'
  ].join(' ')
}

function buildUserPrompt(): string {
  return [
    'Extract these fields from the provided Choice contract PDF:',
    'vin, agreementNumber, mileageAtSale, vehiclePurchaseDate, agreementPurchaseDate, agreementPrice,',
    'coverageLevel, termMonths, termMiles, deductible, coverageSummary, selectedAddOnsSummary, waitingPeriod,',
    'extractionConfidence, extractionWarnings.',
    'Return null for unknown fields and never invent values.'
  ].join(' ')
}

function toRequestBody(input: {
  fileBytes: Buffer
  mimeType: string
  fileName: string
}): Record<string, unknown> {
  const fileData = `data:${input.mimeType};base64,${input.fileBytes.toString('base64')}`
  const isImage = input.mimeType.startsWith('image/')

  return {
    model: DEFAULT_CHOICE_CONTRACT_OCR_MODEL,
    temperature: 0,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: buildSystemPrompt() }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: buildUserPrompt() },
          isImage
            ? {
                type: 'input_image',
                image_url: fileData
              }
            : {
                type: 'input_file',
                filename: input.fileName,
                file_data: fileData
              }
        ]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'choice_contract_fallback',
        schema: jsonSchema,
        strict: true
      }
    }
  }
}

function getSkipResult(reason: string, extractedAt: string): ChoiceContractOpenAiFallbackResult {
  return {
    status: 'skipped',
    attempted: false,
    extractedAt,
    data: {},
    warnings: [reason],
    confidence: null,
    failureReason: reason
  }
}

export async function extractChoiceContractWithOpenAi(input: {
  fileBytes: Buffer
  mimeType?: string | null
  fileName?: string | null
}): Promise<ChoiceContractOpenAiFallbackResult> {
  const extractedAt = new Date().toISOString()

  if (!isFeatureEnabled('openai')) {
    return getSkipResult('OpenAI fallback disabled by feature flag.', extractedAt)
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return getSkipResult('OpenAI fallback unavailable: OPENAI_API_KEY not configured.', extractedAt)
  }

  if (input.fileBytes.length <= 0) {
    return getSkipResult('OpenAI fallback skipped: empty PDF content.', extractedAt)
  }

  if (input.fileBytes.length > MAX_FALLBACK_FILE_BYTES) {
    return getSkipResult('OpenAI fallback skipped: file too large for OCR fallback.', extractedAt)
  }

  const normalizedMimeType = (input.mimeType || 'application/pdf').toLowerCase()
  const fileName = input.fileName?.trim() || (normalizedMimeType.startsWith('image/') ? 'choice-contract-image' : 'choice-contract.pdf')

  const timeoutMs = getOpenAiTimeoutMs()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        toRequestBody({
          fileBytes: input.fileBytes,
          mimeType: normalizedMimeType,
          fileName
        })
      ),
      signal: controller.signal
    })

    if (!response.ok) {
      const body = await response.text()
      return {
        status: 'failed',
        attempted: true,
        extractedAt,
        data: {},
        warnings: ['OpenAI OCR fallback request failed.'],
        confidence: null,
        failureReason: `openai_http_${String(response.status)}:${body.slice(0, 120)}`
      }
    }

    const payload = (await response.json()) as unknown
    const outputText = getOutputText(payload)

    if (!outputText) {
      return {
        status: 'failed',
        attempted: true,
        extractedAt,
        data: {},
        warnings: ['OpenAI OCR fallback returned empty output.'],
        confidence: null,
        failureReason: 'empty_response'
      }
    }

    let parsedJson: unknown

    try {
      parsedJson = JSON.parse(outputText)
    } catch {
      return {
        status: 'failed',
        attempted: true,
        extractedAt,
        data: {},
        warnings: ['OpenAI OCR fallback returned malformed JSON.'],
        confidence: null,
        failureReason: 'malformed_json'
      }
    }

    const validated = responseSchema.safeParse(parsedJson)
    if (!validated.success) {
      return {
        status: 'failed',
        attempted: true,
        extractedAt,
        data: {},
        warnings: ['OpenAI OCR fallback JSON failed schema validation.'],
        confidence: null,
        failureReason: 'schema_validation_failed'
      }
    }

    const normalizedData: ChoiceContractOpenAiData = {}

    const vin = normalizeVin(validated.data.vin)
    if (vin) {
      normalizedData.vin = vin
    }

    const agreementNumber = trimOrNull(validated.data.agreementNumber)
    if (agreementNumber) {
      normalizedData.agreementNumber = agreementNumber
    }

    const mileageAtSale = normalizeInt(validated.data.mileageAtSale, 0, 999_999)
    if (mileageAtSale !== null) {
      normalizedData.mileageAtSale = mileageAtSale
    }

    const vehiclePurchaseDate = normalizeDate(validated.data.vehiclePurchaseDate)
    if (vehiclePurchaseDate) {
      normalizedData.vehiclePurchaseDate = vehiclePurchaseDate
    }

    const agreementPurchaseDate = normalizeDate(validated.data.agreementPurchaseDate)
    if (agreementPurchaseDate) {
      normalizedData.agreementPurchaseDate = agreementPurchaseDate
    }

    const agreementPrice = normalizeMoney(validated.data.agreementPrice)
    if (agreementPrice !== null) {
      normalizedData.agreementPrice = agreementPrice
    }

    const coverageLevel = trimOrNull(validated.data.coverageLevel)
    if (coverageLevel) {
      normalizedData.coverageLevel = coverageLevel
    }

    const termMonths = normalizeInt(validated.data.termMonths, 1, 240)
    if (termMonths !== null) {
      normalizedData.termMonths = termMonths
    }

    const termMiles = normalizeInt(validated.data.termMiles, 1, 999_999)
    if (termMiles !== null) {
      normalizedData.termMiles = termMiles
    }

    const deductible = normalizeMoney(validated.data.deductible)
    if (deductible !== null) {
      normalizedData.deductible = deductible
    }

    const coverageSummary = trimOrNull(validated.data.coverageSummary)
    if (coverageSummary) {
      normalizedData.coverageSummary = coverageSummary
    }

    const selectedAddOnsSummary = trimOrNull(validated.data.selectedAddOnsSummary)
    if (selectedAddOnsSummary) {
      normalizedData.selectedAddOnsSummary = selectedAddOnsSummary
    }

    const waitingPeriod = trimOrNull(validated.data.waitingPeriod)
    if (waitingPeriod) {
      normalizedData.waitingPeriod = waitingPeriod
    }

    const confidence =
      typeof validated.data.extractionConfidence === 'number' &&
      Number.isFinite(validated.data.extractionConfidence)
        ? Math.max(0, Math.min(1, validated.data.extractionConfidence))
        : null

    const warnings = (validated.data.extractionWarnings || []).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    const meaningfulCount = countMeaningfulFields(normalizedData)

    if (meaningfulCount === 0) {
      return {
        status: 'failed',
        attempted: true,
        extractedAt,
        data: {},
        warnings: ['OpenAI OCR fallback did not extract reliable contract fields.'],
        confidence,
        failureReason: 'no_reliable_fields'
      }
    }

    return {
      status: meaningfulCount >= 3 ? 'succeeded' : 'partial',
      attempted: true,
      extractedAt,
      data: normalizedData,
      warnings,
      confidence,
      failureReason: null
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error'
    return {
      status: 'failed',
      attempted: true,
      extractedAt,
      data: {},
      warnings: ['OpenAI OCR fallback request errored before completion.'],
      confidence: null,
      failureReason: reason
    }
  } finally {
    clearTimeout(timeout)
  }
}

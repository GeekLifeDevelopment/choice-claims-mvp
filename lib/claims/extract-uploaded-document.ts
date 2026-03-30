import type { DetectedDocumentType } from './detect-uploaded-document'
import {
  extractChoiceContractWithOpenAi,
  type ChoiceContractOpenAiFallbackResult
} from './extract-choice-contract-with-openai'
import { readPdfTextConservatively } from './read-pdf-text'

export type DocumentExtractionStatus = 'pending' | 'extracted' | 'partial' | 'failed' | 'skipped'

export type DocumentExtractionResult = {
  status: DocumentExtractionStatus
  extractedAt: string
  extractedData: Record<string, unknown> | null
  warnings: string[]
  choiceContractFallback?: {
    attempted: boolean
    status: 'succeeded' | 'partial' | 'failed' | 'skipped'
    used: boolean
    method: 'openai_ocr_vision'
    extractedAt: string | null
    filledFields: string[]
    triggerReasons: string[]
    confidence: number | null
    warnings: string[]
    failureReason: string | null
  }
}

type ExtractionInput = {
  documentType: DetectedDocumentType
  pdfBytes: Buffer
}

const MAX_HISTORY_ENTRIES = 5
const CHOICE_MARKER_EXPRESSIONS = [
  /choice\s+auto\s+protection/i,
  /vehicle\s+service\s+contract/i,
  /agreement\s+(?:number|no\.?)/i,
  /contract\s+purchase\s+date/i,
  /coverage\s+level/i,
  /deductible/i
]

const CHOICE_HIGH_VALUE_FIELDS = [
  'vin',
  'agreementNumber',
  'mileageAtSale',
  'vehiclePurchaseDate',
  'agreementPurchaseDate',
  'agreementPrice',
  'coverageLevel',
  'termMonths',
  'termMiles',
  'deductible'
] as const

type ParsedPdfTextResult = {
  text: string
  parseFailed: boolean
}

type ChoiceFallbackDetails = {
  attempted: boolean
  status: 'succeeded' | 'partial' | 'failed' | 'skipped'
  used: boolean
  method: 'openai_ocr_vision'
  extractedAt: string | null
  filledFields: string[]
  triggerReasons: string[]
  confidence: number | null
  warnings: string[]
  failureReason: string | null
}

async function extractPdfText(pdfBytes: Buffer): Promise<ParsedPdfTextResult> {
  const parsed = await readPdfTextConservatively(pdfBytes)
  return {
    text: parsed.text,
    parseFailed: parsed.parseFailed
  }
}

function extractFirstMatch(text: string, expressions: RegExp[]): string | null {
  for (const expression of expressions) {
    const match = text.match(expression)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  return null
}

function extractMoneyValue(raw: string | null): number | null {
  if (!raw) {
    return null
  }

  const numeric = raw.replace(/[$,\s]/g, '')
  const parsed = Number.parseFloat(numeric)
  return Number.isFinite(parsed) ? parsed : null
}

function extractIntegerValue(raw: string | null): number | null {
  if (!raw) {
    return null
  }

  const numeric = raw.replace(/[,\s]/g, '')
  const parsed = Number.parseInt(numeric, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function extractVin(text: string): string | null {
  const matches = text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g)
  return matches && matches.length > 0 ? matches[0] : null
}

function extractHistoryEntries(text: string): string[] {
  const matches = Array.from(
    text.matchAll(/\b(?:0?[1-9]|1[0-2])[\/.-](?:0?[1-9]|[12]\d|3[01])[\/.-](?:\d{2}|\d{4})\b[^.\n]{5,140}/g)
  )
    .map((entry) => entry[0].replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length >= 10)

  return matches.slice(0, MAX_HISTORY_ENTRIES)
}

function buildCarfaxData(text: string): { data: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const data: Record<string, unknown> = {}

  const vin = extractVin(text)
  if (vin) {
    data.vin = vin
  }

  const mileageRaw = extractFirstMatch(text, [
    /(?:last reported mileage|odometer reading|last reported odometer)[^\d]{0,30}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i,
    /(?:odometer|mileage)[^\d]{0,30}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i
  ])
  const mileage = extractIntegerValue(mileageRaw)
  if (mileage !== null) {
    data.lastReportedMileage = mileage
  }

  const ownerCountRaw = extractFirstMatch(text, [
    /(?:owners?\s*reported|number of owners?)[^\d]{0,10}(\d{1,2})/i,
    /(?:owner\s*\d\s*:\s*)?(\d{1,2})\s*owner/i
  ])
  const ownerCount = extractIntegerValue(ownerCountRaw)
  if (ownerCount !== null) {
    data.ownerCount = ownerCount
  }

  const recallSummary = extractFirstMatch(text, [
    /(open recalls?[^.\n]{0,120})/i,
    /(no open recalls?[^.\n]{0,120})/i
  ])
  if (recallSummary) {
    data.openRecallSummary = recallSummary
    data.recallStatus = /no open recall/i.test(recallSummary) ? 'none_open' : 'possible_open'
  }

  const serviceCountRaw = extractFirstMatch(text, [
    /(?:service\s+history\s+records?|service\s+records?)[^\d]{0,15}(\d{1,3})/i,
    /(\d{1,3})\s+service\s+records?/i
  ])
  const serviceCount = extractIntegerValue(serviceCountRaw)
  if (serviceCount !== null) {
    data.serviceHistoryCount = serviceCount
  }

  const titleSummary = extractFirstMatch(text, [
    /(title history[^.\n]{0,140})/i,
    /(clean title[^.\n]{0,120})/i,
    /(salvage title[^.\n]{0,120})/i
  ])
  if (titleSummary) {
    data.titleHistorySummary = titleSummary
  }

  const damageSummary = extractFirstMatch(text, [
    /(accident[^.\n]{0,140})/i,
    /(damage[^.\n]{0,140})/i,
    /(no accidents? reported[^.\n]{0,120})/i
  ])
  if (damageSummary) {
    data.damageOrAccidentSummary = damageSummary
  }

  const timelineEntries = extractHistoryEntries(text)
  if (timelineEntries.length > 0) {
    data.timelineEntries = timelineEntries
  }

  if (!vin) {
    warnings.push('VIN not confidently extracted from CARFAX document.')
  }

  return { data, warnings }
}

function buildAutocheckData(text: string): { data: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const data: Record<string, unknown> = {}

  const vin = extractVin(text)
  if (vin) {
    data.vin = vin
  }

  const mileageRaw = extractFirstMatch(text, [
    /(?:last reported mileage|odometer check|odometer)[^\d]{0,30}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i,
    /(?:mileage)[^\d]{0,30}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i
  ])
  const mileage = extractIntegerValue(mileageRaw)
  if (mileage !== null) {
    data.lastReportedMileage = mileage
  }

  const ownerCountRaw = extractFirstMatch(text, [
    /(?:owner\(s\)|number of owners?)[^\d]{0,10}(\d{1,2})/i,
    /(\d{1,2})\s+owners?/i
  ])
  const ownerCount = extractIntegerValue(ownerCountRaw)
  if (ownerCount !== null) {
    data.ownerCount = ownerCount
  }

  const recallSummary = extractFirstMatch(text, [
    /(open recalls?[^.\n]{0,120})/i,
    /(no open recalls?[^.\n]{0,120})/i
  ])
  if (recallSummary) {
    data.openRecallSummary = recallSummary
    data.recallStatus = /no open recall/i.test(recallSummary) ? 'none_open' : 'possible_open'
  }

  const serviceCountRaw = extractFirstMatch(text, [
    /(?:service\s+records?|service\s+record\s+count)[^\d]{0,15}(\d{1,3})/i,
    /(\d{1,3})\s+service\s+records?/i
  ])
  const serviceCount = extractIntegerValue(serviceCountRaw)
  if (serviceCount !== null) {
    data.serviceRecordCount = serviceCount
  }

  const lienStatus = extractFirstMatch(text, [
    /(lien\s*\/\s*loan\s*record[^.\n]{0,120})/i,
    /(loan\s*or\s*lien[^.\n]{0,120})/i,
    /(no\s+lien[^.\n]{0,120})/i
  ])
  if (lienStatus) {
    data.lienOrLoanStatus = lienStatus
  }

  const titleSummary = extractFirstMatch(text, [
    /(title\s*brand[^.\n]{0,120})/i,
    /(title\s*history[^.\n]{0,140})/i,
    /(clean\s*title[^.\n]{0,120})/i
  ])
  if (titleSummary) {
    data.titleHistorySummary = titleSummary
  }

  const odometerSummary = extractFirstMatch(text, [
    /(odometer\s*check[^.\n]{0,140})/i,
    /(odometer\s*problem[^.\n]{0,140})/i,
    /(no\s*odometer\s*problem[^.\n]{0,140})/i
  ])
  if (odometerSummary) {
    data.odometerCheckSummary = odometerSummary
  }

  const keyEvents = extractHistoryEntries(text)
  if (keyEvents.length > 0) {
    data.keyHistoryEvents = keyEvents
  }

  if (!vin) {
    warnings.push('VIN not confidently extracted from AutoCheck document.')
  }

  return { data, warnings }
}

function buildChoiceContractData(text: string): { data: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const data: Record<string, unknown> = {}

  const vin = extractVin(text)
  if (vin) {
    data.vin = vin
  }

  const agreementNumber = extractFirstMatch(text, [
    /(?:agreement|contract)\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i,
    /(?:agreement id|contract id)\s*[:#]?\s*([A-Z0-9-]{5,})/i,
    /\b(?:agreement|contract)\s*[:#]\s*([A-Z0-9-]{5,})/i
  ])
  if (agreementNumber) {
    data.agreementNumber = agreementNumber
  }

  const mileageAtSaleRaw = extractFirstMatch(text, [
    /(?:mileage\s+at\s+sale|odometer\s+at\s+sale)[^\d]{0,20}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i,
    /(?:current\s+mileage)[^\d]{0,20}(\d{1,3}(?:,\d{3}){0,2}|\d{4,7})/i
  ])
  const mileageAtSale = extractIntegerValue(mileageAtSaleRaw)
  if (mileageAtSale !== null) {
    data.mileageAtSale = mileageAtSale
  }

  const vehiclePurchaseDate = extractFirstMatch(text, [
    /vehicle\s+purchase\s+date\s*[:#]?\s*([0-9]{1,2}[\/.-][0-9]{1,2}[\/.-][0-9]{2,4})/i,
    /purchase\s+date\s*[:#]?\s*([0-9]{1,2}[\/.-][0-9]{1,2}[\/.-][0-9]{2,4})/i
  ])
  if (vehiclePurchaseDate) {
    data.vehiclePurchaseDate = vehiclePurchaseDate
  }

  const agreementPurchaseDate = extractFirstMatch(text, [
    /agreement\s+purchase\s+date\s*[:#]?\s*([0-9]{1,2}[\/.-][0-9]{1,2}[\/.-][0-9]{2,4})/i,
    /contract\s+purchase\s+date\s*[:#]?\s*([0-9]{1,2}[\/.-][0-9]{1,2}[\/.-][0-9]{2,4})/i
  ])
  if (agreementPurchaseDate) {
    data.agreementPurchaseDate = agreementPurchaseDate
  }

  const agreementPriceRaw = extractFirstMatch(text, [
    /(?:agreement\s+price|purchase\s+price|total\s+contract\s+price)\s*[:#]?\s*(\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /(?:price\s+paid)\s*[:#]?\s*(\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /(?:agreement\s+price|contract\s+price|purchase\s+price)\s*[:#]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i
  ])
  const agreementPrice = extractMoneyValue(agreementPriceRaw)
  if (agreementPrice !== null) {
    data.agreementPrice = agreementPrice
  }

  const coverageLevel = extractFirstMatch(text, [
    /(?:coverage\s+level|plan\s+name|plan|protection\s+plan|coverage\s+option)\s*[:#]?\s*([A-Za-z][A-Za-z0-9\s\-/]{2,40})/i
  ])
  if (coverageLevel) {
    data.coverageLevel = coverageLevel
  }

  const termMonthsRaw = extractFirstMatch(text, [
    /(?:term\s*[:#]?\s*)(\d{1,3})\s*months?/i,
    /(\d{1,3})\s*months?\s*\/\s*\d{1,3}(?:,\d{3}){0,2}\s*miles?/i,
    /(?:service\s+term)\s*[:#]?\s*(\d{1,3})\s*months?/i
  ])
  const termMonths = extractIntegerValue(termMonthsRaw)
  if (termMonths !== null) {
    data.termMonths = termMonths
  }

  const termMilesRaw = extractFirstMatch(text, [
    /(?:term\s*[:#]?\s*\d{1,3}\s*months?\s*\/\s*)(\d{1,3}(?:,\d{3}){0,2})\s*miles?/i,
    /(?:term\s+miles?|mileage\s+term|service\s+term\s+miles?)\s*[:#]?\s*(\d{1,3}(?:,\d{3}){0,2})/i
  ])
  const termMiles = extractIntegerValue(termMilesRaw)
  if (termMiles !== null) {
    data.termMiles = termMiles
  }

  const deductibleRaw = extractFirstMatch(text, [
    /(?:deductible)\s*[:#]?\s*(\$\s*\d{1,4})/i,
    /(\$\s*\d{1,4})\s*deductible/i,
    /(?:deductible)\s*[:#]?\s*(\d{1,4})/i
  ])
  const deductible = extractMoneyValue(deductibleRaw)
  if (deductible !== null) {
    data.deductible = deductible
  }

  const waitingPeriodMarker = extractFirstMatch(text, [
    /(waiting\s+period[^.\n]{0,140})/i,
    /(day\s*one\s+coverage[^.\n]{0,140})/i,
    /(coverage\s+begins[^.\n]{0,140})/i
  ])
  if (waitingPeriodMarker) {
    data.waitingPeriodMarker = waitingPeriodMarker
  }

  const addonCandidates = ['rental', 'roadside', 'trip interruption', 'key replacement', 'wheel and tire', 'maintenance']
  const lower = text.toLowerCase()
  const selectedAddOns = addonCandidates.filter((entry) => lower.includes(entry))
  if (selectedAddOns.length > 0) {
    data.selectedAddOns = selectedAddOns
  }

  if (!vin) {
    warnings.push('VIN not confidently extracted from Choice contract.')
  }

  if (!agreementNumber && !data.coverageLevel && !data.termMonths && !data.termMiles) {
    warnings.push('Choice contract markers were detected but key contract terms were not confidently extracted.')
  }

  return { data, warnings }
}

function countScalarFields(data: Record<string, unknown>): number {
  return Object.entries(data).filter(([key, value]) => {
    if (key.startsWith('__')) {
      return false
    }

    if (value === null || value === undefined) {
      return false
    }

    if (Array.isArray(value)) {
      return value.length > 0
    }

    if (typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).length > 0
    }

    return true
  }).length
}

function hasChoiceMarkers(text: string): boolean {
  const markerMatches = CHOICE_MARKER_EXPRESSIONS.reduce((count, expression) => {
    return expression.test(text) ? count + 1 : count
  }, 0)

  return markerMatches >= 2
}

function hasMeaningfulChoiceValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  return false
}

function getMissingChoiceFields(data: Record<string, unknown>): string[] {
  return CHOICE_HIGH_VALUE_FIELDS.filter((field) => !hasMeaningfulChoiceValue(data[field]))
}

function buildChoiceFallbackTriggerReasons(input: {
  parseFailed: boolean
  extractedFieldCount: number
  missingHighValueFields: string[]
  text: string
}): string[] {
  const reasons: string[] = []

  if (input.parseFailed) {
    reasons.push('pdf_text_parse_failed')
  }

  if (input.extractedFieldCount < 3) {
    reasons.push('deterministic_extraction_sparse')
  }

  if (input.missingHighValueFields.length >= 4) {
    reasons.push('high_value_fields_missing')
  }

  if (!hasChoiceMarkers(input.text)) {
    reasons.push('choice_markers_weak')
  }

  return reasons
}

function mapChoiceFallbackFieldValue(field: string, value: unknown): { key: string; value: unknown } | null {
  if (value === null || value === undefined) {
    return null
  }

  if (field === 'waitingPeriod') {
    return { key: 'waitingPeriodMarker', value }
  }

  return { key: field, value }
}

function mergeChoiceFallbackData(input: {
  deterministicData: Record<string, unknown>
  fallbackResult: ChoiceContractOpenAiFallbackResult
}): { mergedData: Record<string, unknown>; filledFields: string[] } {
  const mergedData = { ...input.deterministicData }
  const filledFields: string[] = []

  const fallbackEntries = Object.entries(input.fallbackResult.data)
  for (const [field, rawValue] of fallbackEntries) {
    const mapped = mapChoiceFallbackFieldValue(field, rawValue)
    if (!mapped) {
      continue
    }

    const existing = mergedData[mapped.key]
    if (hasMeaningfulChoiceValue(existing)) {
      continue
    }

    mergedData[mapped.key] = mapped.value
    filledFields.push(mapped.key)
  }

  return {
    mergedData,
    filledFields
  }
}

function buildChoiceFallbackDetails(input: {
  fallbackResult: ChoiceContractOpenAiFallbackResult
  filledFields: string[]
  triggerReasons: string[]
}): ChoiceFallbackDetails {
  const used =
    (input.fallbackResult.status === 'succeeded' || input.fallbackResult.status === 'partial') &&
    input.filledFields.length > 0

  return {
    attempted: input.fallbackResult.attempted,
    status: input.fallbackResult.status,
    used,
    method: 'openai_ocr_vision',
    extractedAt: input.fallbackResult.attempted ? input.fallbackResult.extractedAt : null,
    filledFields: input.filledFields,
    triggerReasons: input.triggerReasons,
    confidence: input.fallbackResult.confidence,
    warnings: input.fallbackResult.warnings,
    failureReason: input.fallbackResult.failureReason
  }
}

export async function extractUploadedDocumentData(input: ExtractionInput): Promise<DocumentExtractionResult> {
  const extractedAt = new Date().toISOString()

  if (input.documentType === 'unknown') {
    return {
      status: 'skipped',
      extractedAt,
      extractedData: null,
      warnings: ['Extraction skipped for unknown document type.']
    }
  }

  try {
    const parsedText = await extractPdfText(input.pdfBytes)
    const text = parsedText.text

    let built: { data: Record<string, unknown>; warnings: string[] }
    if (input.documentType === 'carfax') {
      built = buildCarfaxData(text)
    } else if (input.documentType === 'autocheck') {
      built = buildAutocheckData(text)
    } else {
      built = buildChoiceContractData(text)
    }

    let extractedData = { ...built.data }
    let warnings = [...built.warnings]
    let choiceFallback: ChoiceFallbackDetails | undefined

    if (input.documentType === 'choice_contract') {
      const missingHighValueFields = getMissingChoiceFields(extractedData)
      const triggerReasons = buildChoiceFallbackTriggerReasons({
        parseFailed: parsedText.parseFailed,
        extractedFieldCount: countScalarFields(extractedData),
        missingHighValueFields,
        text
      })

      const shouldAttemptFallback =
        hasChoiceMarkers(text) &&
        (triggerReasons.includes('pdf_text_parse_failed') ||
          triggerReasons.includes('deterministic_extraction_sparse') ||
          triggerReasons.includes('high_value_fields_missing'))

      if (shouldAttemptFallback) {
        console.info('[claim_document] choice contract fallback attempted', {
          documentType: input.documentType,
          triggerReasons,
          missingFieldCount: missingHighValueFields.length
        })

        const fallbackResult = await extractChoiceContractWithOpenAi({
          pdfBytes: input.pdfBytes
        })

        const merged = mergeChoiceFallbackData({
          deterministicData: extractedData,
          fallbackResult
        })

        extractedData = merged.mergedData
        choiceFallback = buildChoiceFallbackDetails({
          fallbackResult,
          filledFields: merged.filledFields,
          triggerReasons
        })

        if (choiceFallback.used) {
          extractedData.__choiceContractFallback = {
            used: true,
            method: 'openai_ocr_vision',
            extractedAt: choiceFallback.extractedAt,
            filledFields: choiceFallback.filledFields,
            confidence: choiceFallback.confidence,
            warnings: choiceFallback.warnings
          }

          warnings.push('OCR/vision fallback used due to weak PDF text.')
          if (choiceFallback.warnings.length > 0) {
            warnings = warnings.concat(choiceFallback.warnings.map((entry) => `OpenAI fallback: ${entry}`))
          }

          console.info('[claim_document] choice contract fallback succeeded', {
            documentType: input.documentType,
            fallbackStatus: choiceFallback.status,
            filledFieldCount: choiceFallback.filledFields.length
          })
        } else if (choiceFallback.status === 'failed') {
          warnings.push('OpenAI OCR/vision fallback failed; deterministic extraction retained.')

          console.warn('[claim_document] choice contract fallback failed', {
            documentType: input.documentType,
            failureReason: choiceFallback.failureReason ?? 'unknown_error'
          })
        } else if (choiceFallback.status === 'partial') {
          console.info('[claim_document] choice contract fallback partial', {
            documentType: input.documentType,
            filledFieldCount: choiceFallback.filledFields.length
          })
        }
      }
    }

    const extractedFieldCount = countScalarFields(extractedData)

    if (extractedFieldCount === 0) {
      return {
        status: 'partial',
        extractedAt,
        extractedData: null,
        warnings: [...warnings, 'No reliable structured fields were extracted.'],
        choiceContractFallback: choiceFallback
      }
    }

    if (extractedFieldCount < 3) {
      return {
        status: 'partial',
        extractedAt,
        extractedData,
        warnings,
        choiceContractFallback: choiceFallback
      }
    }

    return {
      status: 'extracted',
      extractedAt,
      extractedData,
      warnings,
      choiceContractFallback: choiceFallback
    }
  } catch (error) {
    return {
      status: 'failed',
      extractedAt,
      extractedData: null,
      warnings: [error instanceof Error ? error.message : 'Document extraction failed.']
    }
  }
}

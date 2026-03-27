import type { DetectedDocumentType } from './detect-uploaded-document'
import { readPdfTextConservatively } from './read-pdf-text'

export type DocumentExtractionStatus = 'pending' | 'extracted' | 'partial' | 'failed' | 'skipped'

export type DocumentExtractionResult = {
  status: DocumentExtractionStatus
  extractedAt: string
  extractedData: Record<string, unknown> | null
  warnings: string[]
}

type ExtractionInput = {
  documentType: DetectedDocumentType
  pdfBytes: Buffer
}

const MAX_HISTORY_ENTRIES = 5

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const parsed = await readPdfTextConservatively(pdfBytes)
  return parsed.text
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
    /(?:agreement id|contract id)\s*[:#]?\s*([A-Z0-9-]{5,})/i
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
    /(?:price\s+paid)\s*[:#]?\s*(\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i
  ])
  const agreementPrice = extractMoneyValue(agreementPriceRaw)
  if (agreementPrice !== null) {
    data.agreementPrice = agreementPrice
  }

  const coverageLevel = extractFirstMatch(text, [
    /(?:coverage\s+level|plan\s+name|plan)\s*[:#]?\s*([A-Za-z][A-Za-z0-9\s\-/]{2,40})/i
  ])
  if (coverageLevel) {
    data.coverageLevel = coverageLevel
  }

  const termMonthsRaw = extractFirstMatch(text, [
    /(?:term\s*[:#]?\s*)(\d{1,3})\s*months?/i,
    /(\d{1,3})\s*months?\s*\/\s*\d{1,3}(?:,\d{3}){0,2}\s*miles?/i
  ])
  const termMonths = extractIntegerValue(termMonthsRaw)
  if (termMonths !== null) {
    data.termMonths = termMonths
  }

  const termMilesRaw = extractFirstMatch(text, [
    /(?:term\s*[:#]?\s*\d{1,3}\s*months?\s*\/\s*)(\d{1,3}(?:,\d{3}){0,2})\s*miles?/i,
    /(?:term\s+miles?|mileage\s+term)\s*[:#]?\s*(\d{1,3}(?:,\d{3}){0,2})/i
  ])
  const termMiles = extractIntegerValue(termMilesRaw)
  if (termMiles !== null) {
    data.termMiles = termMiles
  }

  const deductibleRaw = extractFirstMatch(text, [
    /(?:deductible)\s*[:#]?\s*(\$\s*\d{1,4})/i,
    /(\$\s*\d{1,4})\s*deductible/i
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

  return { data, warnings }
}

function countScalarFields(data: Record<string, unknown>): number {
  return Object.values(data).filter((value) => {
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
    const text = await extractPdfText(input.pdfBytes)

    let built: { data: Record<string, unknown>; warnings: string[] }
    if (input.documentType === 'carfax') {
      built = buildCarfaxData(text)
    } else if (input.documentType === 'autocheck') {
      built = buildAutocheckData(text)
    } else {
      built = buildChoiceContractData(text)
    }

    const extractedFieldCount = countScalarFields(built.data)

    if (extractedFieldCount === 0) {
      return {
        status: 'partial',
        extractedAt,
        extractedData: null,
        warnings: [...built.warnings, 'No reliable structured fields were extracted.']
      }
    }

    if (extractedFieldCount < 3) {
      return {
        status: 'partial',
        extractedAt,
        extractedData: built.data,
        warnings: built.warnings
      }
    }

    return {
      status: 'extracted',
      extractedAt,
      extractedData: built.data,
      warnings: built.warnings
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

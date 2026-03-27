export type ProviderStatus = 'ok' | 'not_configured' | 'error' | 'no_result'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isErrorMessage(value: unknown): boolean {
  const message = getOptionalString(value)
  if (!message) {
    return false
  }

  return /(error|failed|timeout|exception)/i.test(message)
}

function isNotConfiguredMessage(value: unknown): boolean {
  const message = getOptionalString(value)
  if (!message) {
    return false
  }

  return /(stub|unconfigured|not configured|disabled|missing config)/i.test(message)
}

function isStubSource(value: unknown): boolean {
  const source = getOptionalString(value)
  if (!source) {
    return false
  }

  return /stub/i.test(source)
}

function resolveTitleHistoryStatus(vinDataResult: Record<string, unknown>): ProviderStatus {
  const titleHistory = asRecord(vinDataResult.titleHistory)

  if (Object.keys(titleHistory).length === 0) {
    const message = getOptionalString(vinDataResult.providerResultMessage)
    if (message && isNotConfiguredMessage(message)) {
      return 'not_configured'
    }

    if (message && isErrorMessage(message)) {
      return 'error'
    }

    return 'no_result'
  }

  if (isStubSource(titleHistory.source)) {
    return 'not_configured'
  }

  if (isNotConfiguredMessage(titleHistory.message)) {
    return 'not_configured'
  }

  if (isErrorMessage(titleHistory.message)) {
    return 'error'
  }

  const brandFlags = Array.isArray(titleHistory.brandFlags) ? titleHistory.brandFlags.length : 0
  const odometerFlags = Array.isArray(titleHistory.odometerFlags) ? titleHistory.odometerFlags.length : 0
  const events = Array.isArray(titleHistory.events) ? titleHistory.events.length : 0
  const hasTitleStatus = Boolean(getOptionalString(titleHistory.titleStatus))
  const hasIndicator =
    titleHistory.salvageIndicator === true ||
    titleHistory.rebuiltIndicator === true ||
    titleHistory.totalLossIndicator === true ||
    titleHistory.theftIndicator === true ||
    titleHistory.junkIndicator === true

  if (brandFlags === 0 && odometerFlags === 0 && events === 0 && !hasTitleStatus && !hasIndicator) {
    return 'no_result'
  }

  return 'ok'
}

function resolveServiceHistoryStatus(vinDataResult: Record<string, unknown>): ProviderStatus {
  const serviceHistory = asRecord(vinDataResult.serviceHistory)
  if (Object.keys(serviceHistory).length === 0) {
    const message = getOptionalString(vinDataResult.providerResultMessage)
    if (message && isNotConfiguredMessage(message)) {
      return 'not_configured'
    }

    if (message && isErrorMessage(message)) {
      return 'error'
    }

    return 'no_result'
  }

  if (isStubSource(serviceHistory.source)) {
    return 'not_configured'
  }

  if (isNotConfiguredMessage(serviceHistory.message)) {
    return 'not_configured'
  }

  if (isErrorMessage(serviceHistory.message)) {
    return 'error'
  }

  const eventCount = typeof serviceHistory.eventCount === 'number' ? serviceHistory.eventCount : null
  const events = Array.isArray(serviceHistory.events) ? serviceHistory.events.length : 0

  if (eventCount === null && events === 0) {
    return 'no_result'
  }

  if (eventCount === 0 && events === 0) {
    return 'no_result'
  }

  return 'ok'
}

function resolveRecallsStatus(vinDataResult: Record<string, unknown>): ProviderStatus {
  const recalls = asRecord(vinDataResult.nhtsaRecalls)
  if (Object.keys(recalls).length === 0) {
    return 'no_result'
  }

  if (isErrorMessage(recalls.message)) {
    return 'error'
  }

  const count = typeof recalls.count === 'number' ? recalls.count : null
  if (count === null) {
    return 'no_result'
  }

  if (count === 0) {
    return 'no_result'
  }

  return 'ok'
}

function resolveValuationStatus(vinDataResult: Record<string, unknown>): ProviderStatus {
  const valuation = asRecord(vinDataResult.valuation)
  if (Object.keys(valuation).length === 0) {
    const message = getOptionalString(vinDataResult.providerResultMessage)
    if (message && isNotConfiguredMessage(message)) {
      return 'not_configured'
    }

    if (message && isErrorMessage(message)) {
      return 'error'
    }

    return 'no_result'
  }

  if (isStubSource(valuation.source)) {
    return 'not_configured'
  }

  if (isNotConfiguredMessage(valuation.message)) {
    return 'not_configured'
  }

  if (isErrorMessage(valuation.message)) {
    return 'error'
  }

  const estimated = typeof valuation.estimatedValue === 'number' ? valuation.estimatedValue : null
  const retail = typeof valuation.retailValue === 'number' ? valuation.retailValue : null
  const tradeIn = typeof valuation.tradeInValue === 'number' ? valuation.tradeInValue : null

  if (estimated === null && retail === null && tradeIn === null) {
    return 'no_result'
  }

  return 'ok'
}

function resolveVinStatus(vinDataResult: Record<string, unknown>): ProviderStatus {
  const provider = getOptionalString(vinDataResult.provider)
  if (!provider) {
    return 'no_result'
  }

  const message = getOptionalString(vinDataResult.providerResultMessage)
  if (message && isNotConfiguredMessage(message)) {
    return 'not_configured'
  }

  if (isErrorMessage(message)) {
    return 'error'
  }

  return 'ok'
}

export function resolveQuestionProviderStatus(questionId: string, vinDataResult: unknown): ProviderStatus {
  const providerResult = asRecord(vinDataResult)

  if (questionId === 'maintenance_history' || questionId === 'prior_repairs') {
    return resolveServiceHistoryStatus(providerResult)
  }

  if (questionId === 'branded_title') {
    return resolveTitleHistoryStatus(providerResult)
  }

  if (questionId === 'recall_relevance') {
    return resolveRecallsStatus(providerResult)
  }

  if (questionId === 'valuation_context') {
    return resolveValuationStatus(providerResult)
  }

  if (questionId === 'miles_since_purchase' || questionId === 'days_since_purchase') {
    return resolveVinStatus(providerResult)
  }

  return 'no_result'
}

export const VIN_LOOKUP_MAX_ATTEMPTS = 3
export const VIN_LOOKUP_BACKOFF_MS = 3000
export const VIN_LOOKUP_BACKOFF_TYPE = 'vin_lookup_adaptive'
export const DEFAULT_AUTOCHECK_429_RETRY_DELAY_MS = 30_000

function readOptionalEnv(name: string): string | null {
	const value = process.env[name]?.trim()
	return value ? value : null
}

function parseBoolean(value: string | null): boolean | null {
	if (!value) {
		return null
	}

	const normalized = value.toLowerCase()

	if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
		return true
	}

	if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
		return false
	}

	return null
}

function parsePositiveInt(value: string | null, fallback: number): number {
	if (!value) {
		return fallback
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback
	}

	return Math.floor(parsed)
}

function isSandboxBaseUrl(baseUrl: string | null): boolean {
	return Boolean(baseUrl && /sandbox/i.test(baseUrl))
}

export function isAutoCheckSandboxRateLimitMitigationEnabled(): boolean {
	const explicit = parseBoolean(readOptionalEnv('AUTOCHECK_SANDBOX_RATE_LIMIT_MODE'))

	if (explicit !== null) {
		return explicit
	}

	return isSandboxBaseUrl(readOptionalEnv('EXPERIAN_BASE_URL'))
}

export function getAutoCheck429RetryDelayMs(): number {
	return parsePositiveInt(readOptionalEnv('AUTOCHECK_429_RETRY_DELAY_MS'), DEFAULT_AUTOCHECK_429_RETRY_DELAY_MS)
}

export function isRateLimitedProviderFailure(error: Error | undefined): boolean {
	if (!error) {
		return false
	}

	const message = error.message || ''
	return /http_429_rate_limited|status\s*429|rate\s*limit/i.test(message)
}

export function getVinLookupBackoffDelayMs(input: {
	attemptsMade: number
	baseDelayMs: number
	error?: Error
}): number {
	const { attemptsMade, baseDelayMs, error } = input

	if (isAutoCheckSandboxRateLimitMitigationEnabled() && isRateLimitedProviderFailure(error)) {
		return getAutoCheck429RetryDelayMs()
	}

	// Mirror exponential backoff behavior when no rate-limit override is active.
	const exponent = Math.max(0, attemptsMade - 1)
	return baseDelayMs * 2 ** exponent
}

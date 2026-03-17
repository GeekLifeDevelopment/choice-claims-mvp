import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const fixtureDir = path.join(projectRoot, 'test', 'fixtures', 'cognito')
const manifestPath = path.join(fixtureDir, 'manifest.json')

function getUrlArg() {
  const arg = process.argv.find((value) => value.startsWith('--url='))
  if (arg) {
    return arg.slice('--url='.length)
  }

  const directArgIndex = process.argv.findIndex((value) => value === '--url')
  if (directArgIndex >= 0) {
    return process.argv[directArgIndex + 1]
  }

  return undefined
}

function normalizeTargetUrl(urlValue) {
  if (!urlValue) {
    return 'http://localhost:3000/api/intake/cognito'
  }

  if (urlValue.endsWith('/api/intake/cognito')) {
    return urlValue
  }

  const withoutTrailingSlash = urlValue.replace(/\/$/, '')
  return `${withoutTrailingSlash}/api/intake/cognito`
}

function classifyOutcome(responseStatus, responseBody) {
  if (responseStatus === 400 && responseBody?.error === 'validation_failed') {
    return 'validation_failed'
  }

  if (responseStatus >= 200 && responseStatus < 300 && responseBody?.ok === true) {
    if (responseBody?.duplicate === true) {
      return 'duplicate'
    }

    if (responseBody?.claim?.claimNumber) {
      return 'created'
    }
  }

  return 'unexpected'
}

function formatResultLine(item) {
  const duplicatePart =
    item.responseBody?.duplicate === true
      ? 'duplicate=true'
      : item.responseBody?.duplicate === false
        ? 'duplicate=false'
        : 'duplicate=n/a'

  const claimNumber = item.responseBody?.claim?.claimNumber || 'n/a'
  const outcomeText = `${item.actualOutcome}${item.expectationMatched ? '' : ` (expected ${item.expectedOutcome})`}`

  return `${item.file} -> ${item.status} -> ${outcomeText} -> ${duplicatePart} -> claimNumber=${claimNumber}`
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

async function main() {
  const requestedUrl = getUrlArg() || process.env.INTAKE_TEST_URL || process.env.INTAKE_BASE_URL
  const intakeUrl = normalizeTargetUrl(requestedUrl)

  const secret = process.env.COGNITO_WEBHOOK_SECRET
  const headers = {
    'Content-Type': 'application/json'
  }

  if (secret) {
    headers['x-webhook-secret'] = secret
  }

  const manifest = await readJsonFile(manifestPath)

  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('Fixture manifest is empty or invalid')
  }

  console.log(`Target intake endpoint: ${intakeUrl}`)
  console.log(`Fixture directory: ${fixtureDir}`)
  console.log(`Running ${manifest.length} fixture(s)...`)

  let passed = 0
  let failed = 0

  for (const fixture of manifest) {
    const fixtureFilePath = path.join(fixtureDir, fixture.file)
    let status = 0
    let responseBody = null
    let actualOutcome = 'unexpected'
    let networkError = null

    try {
      const payload = await readJsonFile(fixtureFilePath)

      const response = await fetch(intakeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })

      status = response.status
      const text = await response.text()

      try {
        responseBody = text ? JSON.parse(text) : null
      } catch {
        responseBody = { raw: text }
      }

      actualOutcome = classifyOutcome(status, responseBody)
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error)
      actualOutcome = 'unexpected'
    }

    const statusMatched = status === fixture.expectedStatus
    const expectationMatched = actualOutcome === fixture.expectedOutcome && statusMatched && !networkError

    if (expectationMatched) {
      passed += 1
    } else {
      failed += 1
    }

    const result = {
      file: fixture.file,
      status: status || 'network_error',
      expectedOutcome: fixture.expectedOutcome,
      actualOutcome,
      expectationMatched,
      responseBody
    }

    console.log(formatResultLine(result))

    if (networkError) {
      console.log(`  error: ${networkError}`)
    }

    if (!expectationMatched) {
      console.log(`  expectedStatus=${fixture.expectedStatus} actualStatus=${status || 'network_error'}`)
      if (responseBody?.error) {
        console.log(`  errorCode=${responseBody.error}`)
      }
    }
  }

  console.log('---')
  console.log(`total fixtures: ${manifest.length}`)
  console.log(`passed expectations: ${passed}`)
  console.log(`failed expectations: ${failed}`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Failed to run intake fixture replay:', error)
  process.exit(1)
})

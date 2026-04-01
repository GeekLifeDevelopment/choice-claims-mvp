import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

function parseListeningNodePids(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const pids = new Set()

  for (const line of lines.slice(1)) {
    const columns = line.split(/\s+/)
    const command = columns[0] || ''
    const pid = columns[1] || ''

    if (!command.toLowerCase().includes('node')) {
      continue
    }

    if (/^\d+$/.test(pid)) {
      pids.add(pid)
    }
  }

  return [...pids]
}

function getProcessCwd(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    const pathLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'))

    return pathLine ? pathLine.slice(1) : null
  } catch {
    return null
  }
}

function hasActiveNodeListenerInWorkspace(cwd) {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    const nodePids = parseListeningNodePids(output)
    for (const pid of nodePids) {
      const processCwd = getProcessCwd(pid)
      if (processCwd && resolve(processCwd) === resolve(cwd)) {
        return { pid }
      }
    }

    return null
  } catch {
    return null
  }
}

const bypassSafety = process.env.ALLOW_CONCURRENT_NEXT_CLEAN === '1'

if (!bypassSafety) {
  const active = hasActiveNodeListenerInWorkspace(process.cwd())
  if (active) {
    console.error(
      `[clean:next] aborted: active node listener (pid ${active.pid}) detected in this workspace. Stop other dev/build servers first or rerun with ALLOW_CONCURRENT_NEXT_CLEAN=1.`
    )
    process.exit(1)
  }
}

const targets = ['.next', 'next-dist']

for (const target of targets) {
  const fullPath = resolve(process.cwd(), target)

  if (!existsSync(fullPath)) {
    continue
  }

  rmSync(fullPath, { recursive: true, force: true })
  console.log(`[clean:next] removed ${target}`)
}

// In this iCloud-backed workspace, Next can intermittently fail before generating
// server manifests in dev mode. Seed minimal placeholders to avoid MODULE_NOT_FOUND.
const nextServerDir = resolve(process.cwd(), '.next', 'server')
mkdirSync(nextServerDir, { recursive: true })

const placeholderManifests = ['middleware-manifest.json', 'pages-manifest.json']

for (const manifestName of placeholderManifests) {
  const manifestPath = resolve(nextServerDir, manifestName)
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, '{}\n', { encoding: 'utf8' })
    console.log(`[clean:next] seeded .next/server/${manifestName}`)
  }
}

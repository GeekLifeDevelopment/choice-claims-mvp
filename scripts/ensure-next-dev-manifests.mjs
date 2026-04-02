import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const distDir = resolve(process.cwd(), 'next-dist')
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true })
  console.log('[predev] removed next-dist')
}

const legacyNextDir = resolve(process.cwd(), '.next')
if (existsSync(legacyNextDir)) {
  rmSync(legacyNextDir, { recursive: true, force: true })
  console.log('[predev] removed .next')
}

const serverDir = resolve(process.cwd(), 'next-dist', 'server')

// Reset the entire server output to avoid stale webpack runtime/chunk references.
// This is important in iCloud-backed workspaces where partial writes can leave
// runtime files pointing at missing vendor chunks (for example bullmq.js).
mkdirSync(serverDir, { recursive: true })

const manifestSeeds = {
  'middleware-manifest.json': {
    version: 2,
    middleware: {},
    functions: {},
    sortedMiddleware: []
  },
  'pages-manifest.json': {},
  'app-paths-manifest.json': {}
}

for (const [name, payload] of Object.entries(manifestSeeds)) {
  const target = resolve(serverDir, name)
  if (!existsSync(target)) {
    writeFileSync(target, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' })
    console.log(`[predev] seeded next-dist/server/${name}`)
  }
}

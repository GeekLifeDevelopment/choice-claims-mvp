import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(process.cwd(), 'next-dist', 'server')
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

import { NextResponse } from 'next/server'
import { readRuntimeEnv } from '../../../../lib/config/runtime-env'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const databaseUrl = readRuntimeEnv('DATABASE_URL') || ''
  const directUrl = readRuntimeEnv('DIRECT_URL') || ''
  const nextPublicAppUrl = readRuntimeEnv('NEXT_PUBLIC_APP_URL') || ''
  const redisUrl = readRuntimeEnv('REDIS_URL') || ''

  return NextResponse.json(
    {
      ok: true,
      hasDatabaseUrl: databaseUrl.length > 0,
      hasDirectUrl: directUrl.length > 0,
      hasNextPublicAppUrl: nextPublicAppUrl.length > 0,
      hasRedisUrl: redisUrl.length > 0,
      databaseUrlLength: databaseUrl.length,
      directUrlLength: directUrl.length,
      nodeEnv: readRuntimeEnv('NODE_ENV'),
      netlify: {
        siteName: readRuntimeEnv('SITE_NAME'),
        context: readRuntimeEnv('CONTEXT'),
        branch: readRuntimeEnv('BRANCH'),
        deployId: readRuntimeEnv('DEPLOY_ID'),
        deployUrl: readRuntimeEnv('DEPLOY_URL'),
        url: readRuntimeEnv('URL'),
        netlifyFlag: readRuntimeEnv('NETLIFY')
      }
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}

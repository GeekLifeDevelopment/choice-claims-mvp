import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL?.trim() || ''
  const directUrl = process.env.DIRECT_URL?.trim() || ''
  const nextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || ''
  const redisUrl = process.env.REDIS_URL?.trim() || ''

  return NextResponse.json(
    {
      ok: true,
      hasDatabaseUrl: databaseUrl.length > 0,
      hasDirectUrl: directUrl.length > 0,
      hasNextPublicAppUrl: nextPublicAppUrl.length > 0,
      hasRedisUrl: redisUrl.length > 0,
      databaseUrlLength: databaseUrl.length,
      directUrlLength: directUrl.length,
      nodeEnv: process.env.NODE_ENV || null,
      netlify: {
        siteName: process.env.SITE_NAME || null,
        context: process.env.CONTEXT || null,
        branch: process.env.BRANCH || null,
        deployId: process.env.DEPLOY_ID || null,
        deployUrl: process.env.DEPLOY_URL || null,
        url: process.env.URL || null,
        netlifyFlag: process.env.NETLIFY || null
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

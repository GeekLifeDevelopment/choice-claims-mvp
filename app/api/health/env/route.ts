import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL?.trim() || ''
  const directUrl = process.env.DIRECT_URL?.trim() || ''

  return NextResponse.json(
    {
      ok: true,
      hasDatabaseUrl: databaseUrl.length > 0,
      hasDirectUrl: directUrl.length > 0,
      databaseUrlLength: databaseUrl.length,
      directUrlLength: directUrl.length,
      nodeEnv: process.env.NODE_ENV || null
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}

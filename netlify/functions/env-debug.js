exports.handler = async function handler() {
  const read = (key) => {
    const value = process.env[key]
    if (typeof value !== 'string') {
      return null
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const databaseUrl = read('DATABASE_URL')
  const directUrl = read('DIRECT_URL')
  const redisUrl = read('REDIS_URL')
  const nextPublicAppUrl = read('NEXT_PUBLIC_APP_URL')

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify({
      ok: true,
      source: 'netlify-function',
      hasDatabaseUrl: Boolean(databaseUrl),
      hasDirectUrl: Boolean(directUrl),
      hasRedisUrl: Boolean(redisUrl),
      hasNextPublicAppUrl: Boolean(nextPublicAppUrl),
      nodeEnv: read('NODE_ENV'),
      netlify: {
        siteName: read('SITE_NAME'),
        context: read('CONTEXT'),
        branch: read('BRANCH'),
        deployId: read('DEPLOY_ID'),
        deployUrl: read('DEPLOY_URL'),
        url: read('URL'),
        netlifyFlag: read('NETLIFY')
      }
    })
  }
}

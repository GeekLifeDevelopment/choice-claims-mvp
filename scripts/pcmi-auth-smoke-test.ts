import { getPcmiOAuthConfig, hasPcmiOAuthConfig } from '../lib/providers/config'
import { getPcmiAccessTokenResult } from '../lib/providers/pcmi/auth'
import { pcmiRequest } from '../lib/providers/pcmi/client'

async function main() {
  const config = getPcmiOAuthConfig()

  if (!hasPcmiOAuthConfig()) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: 'not_configured',
          hasBaseUrl: Boolean(config.baseUrl),
          hasTokenUrl: Boolean(config.tokenUrl),
          hasClientId: Boolean(config.clientId),
          hasClientSecret: Boolean(config.clientSecret),
          hasUsername: Boolean(config.username),
          hasPassword: Boolean(config.password)
        },
        null,
        2
      )
    )

    process.exitCode = 1
    return
  }

  const tokenResult = await getPcmiAccessTokenResult({ forceRefresh: true })

  if (!tokenResult.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: tokenResult.code,
          status: tokenResult.status,
          message: tokenResult.message
        },
        null,
        2
      )
    )

    process.exitCode = 1
    return
  }

  const smokePath = process.env.PCMI_SMOKE_PATH?.trim()
  if (!smokePath) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          token: {
            source: tokenResult.source,
            tokenType: tokenResult.token.token_type,
            expiresIn: tokenResult.token.expires_in,
            hasRefreshToken: Boolean(tokenResult.token.refresh_token)
          }
        },
        null,
        2
      )
    )

    return
  }

  const requestResult = await pcmiRequest({
    path: smokePath,
    method: 'GET'
  })

  if (!requestResult.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: requestResult.code,
          providerStatus: requestResult.providerStatus,
          status: requestResult.status,
          message: requestResult.message
        },
        null,
        2
      )
    )

    process.exitCode = 1
    return
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        token: {
          source: tokenResult.source,
          tokenType: tokenResult.token.token_type,
          expiresIn: tokenResult.token.expires_in,
          hasRefreshToken: Boolean(tokenResult.token.refresh_token)
        },
        smokeRequest: {
          path: smokePath,
          status: requestResult.status
        }
      },
      null,
      2
    )
  )
}

void main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'unexpected_error',
        message: error instanceof Error ? error.message : 'unknown_error'
      },
      null,
      2
    )
  )

  process.exit(1)
})

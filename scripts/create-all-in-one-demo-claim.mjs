import { config as loadEnv } from 'dotenv'
import { PrismaClient } from '@prisma/client'

loadEnv({ path: '.env.local' })
loadEnv()

const prisma = new PrismaClient()

function pad2(value) {
  return String(value).padStart(2, '0')
}

async function main() {
  const now = new Date()
  const claimNumber = `CC-DEMO-${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`

  const ruleFlags = [
    {
      code: 'no_photos',
      severity: 'info',
      message: 'Claim has no photo attachments.'
    }
  ]

  const summaryInput = {
    claimNumber,
    status: 'ReadyForAI',
    vin: '1HGCM82633A004352',
    providerResult: {
      provider: 'demo-provider',
      year: 2019,
      make: 'Honda',
      model: 'Accord'
    },
    attachments: {
      count: 2,
      hasPhotos: false,
      hasDocuments: true
    },
    ruleFlags
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to generate demo summary text.')
  }

  const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.REVIEW_SUMMARY_MODEL || 'gpt-4.1-mini',
      temperature: 0.1,
      max_tokens: 260,
      messages: [
        {
          role: 'system',
          content:
            'You are an insurance claim reviewer assistant. Return factual plain text summary under 200 words.'
        },
        {
          role: 'user',
          content: `Summarize this claim for a reviewer. ${JSON.stringify(summaryInput)}`
        }
      ]
    })
  })

  if (!openAiResponse.ok) {
    const errorBody = await openAiResponse.text()
    throw new Error(`OpenAI error ${openAiResponse.status}: ${errorBody.slice(0, 400)}`)
  }

  const payload = await openAiResponse.json()
  const reviewSummaryText = payload?.choices?.[0]?.message?.content?.trim()

  if (!reviewSummaryText) {
    throw new Error('OpenAI did not return summary text.')
  }

  const claim = await prisma.claim.create({
    data: {
      claimNumber,
      status: 'ReadyForAI',
      source: 'demo',
      vin: '1HGCM82633A004352',
      claimantName: 'Reviewer Demo',
      claimantEmail: 'reviewer.demo@example.com',
      claimantPhone: '(555) 010-2026',
      rawSubmissionPayload: {
        demo: true,
        reason: 'all_in_one_reviewer_claim'
      },
      vinDataProvider: 'demo-provider',
      vinDataFetchedAt: now,
      vinDataResult: {
        provider: 'demo-provider',
        vin: '1HGCM82633A004352',
        year: 2019,
        make: 'Honda',
        model: 'Accord',
        eventCount: 2
      },
      reviewRuleFlags: ruleFlags,
      reviewRuleEvaluatedAt: now,
      reviewRuleVersion: 'demo-v1',
      reviewSummaryStatus: 'Generated',
      reviewSummaryEnqueuedAt: now,
      reviewSummaryGeneratedAt: now,
      reviewSummaryText,
      reviewSummaryVersion: 'v1',
      reviewSummaryLastError: null,
      submittedAt: now,
      attachments: {
        create: [
          {
            filename: 'repair-order.pdf',
            mimeType: 'application/pdf',
            fileSize: 120345,
            sourceUrl: 'https://example.com/repair-order.pdf'
          },
          {
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            fileSize: 88321,
            sourceUrl: 'https://example.com/invoice.pdf'
          }
        ]
      }
    }
  })

  console.log(
    JSON.stringify(
      {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        adminPath: `/admin/claims/${claim.id}`,
        reviewSummaryStatus: 'Generated',
        ruleFlagCount: ruleFlags.length,
        attachmentCount: 2
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

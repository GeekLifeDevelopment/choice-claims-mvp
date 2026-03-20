import { enqueueReviewSummaryForClaim } from '../lib/review/enqueue-review-summary'

async function main() {
  const result = await enqueueReviewSummaryForClaim('cmmz9suwb0000fj49ssg0dawd', 'manual')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

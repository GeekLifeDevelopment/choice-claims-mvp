# Choice Claims MVP — Sprint 1 baseline

This repository contains the Sprint 1 baseline for the Choice Claims MVP staging app. It
is intended for stakeholder review of early progress and provides a lightweight,
production-sensible starting point.

Tech stack (Ticket 1)

- Next.js (App Router)
- TypeScript
- Tailwind CSS
- Netlify (deployment target)

Local setup

1. Install dependencies:

```bash
npm install
```

2. Run the dev server:

```bash
npm run dev
```

3. Build for production:

```bash
npm run build
```

Database setup (Supabase + Prisma)

1. Create a Supabase project and Postgres database.
2. In Supabase, open **Project Settings → Database** and copy the connection strings.
3. Create `.env.local` from `.env.example` and set:
	- `DATABASE_URL` (pooled connection string)
	- `DIRECT_URL` (direct/non-pooled connection string)
	- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
4. Generate Prisma client:

```bash
npx prisma generate
```

5. Apply the initial migration to your Supabase database:

```bash
npx prisma migrate deploy
```

For local schema changes during development, use:

```bash
npx prisma migrate dev --name <migration_name>
```

6. Test DB health route:

```bash
npm run dev
curl http://localhost:3000/api/health/db
```

Expected success response:

```json
{"status":"ok"}
```

If DB credentials are missing/invalid, route returns:

```json
{"status":"error","message":"..."}
```

Quick GitHub → Netlify workflow

1. Push your local repository to the GitHub repo named `choice-claims-mvp` (replace origin URL):

```bash
git init
git add .
git commit -m "chore: initial Next.js TypeScript + Tailwind baseline"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

2. In Netlify, create a new site and connect it to the `choice-claims-mvp` repo.

Netlify deployment notes

- This repo includes `netlify.toml` and expects the official `@netlify/plugin-nextjs`.
- Netlify's Next.js plugin enables support for the App Router, server functions, and
	other Next-specific features on Netlify. In many cases Netlify will auto-install the
	plugin. If your Netlify org restricts plugins, enable or install the plugin in the
	Netlify UI for the site.
- Build command: `npm run build`. The plugin manages routing and publishing from the
	`.next` output.
- Add environment variables in Netlify site settings from `.env.example` (do not commit
	secrets). For Sprint 1 you can leave DB/webhook values blank.

Project purpose and scope

- Provides a stakeholder-safe staging environment showing the basic app structure.
- Pages included:
	- `/` — staging homepage with summary and note
	- `/admin/claims` — admin placeholder for claims intake/review
- Ticket 2 adds database foundation only (Prisma schema, migration, health check).
- Ticket 3 adds Sprint 1 intake domain contracts:
	- `ClaimStatus` enum (`Submitted`, `AwaitingVinData`, `ReadyForAI`, `ProviderFailed`, `ProcessingError`)
	- intake payload and attachment metadata TypeScript types
	- audit action type definitions
	- Zod schemas + parse helper for normalized intake payload validation
- Ticket 4 adds intake webhook processing (no DB writes yet):
	- endpoint: `/api/intake/cognito`
	- flow: raw payload -> normalize -> validate -> create-claim input shape
	- optional shared-secret check via `COGNITO_WEBHOOK_SECRET` + `x-webhook-secret`
	- explicit mapping for captured Cognito field names (for example: `Entry`, `CustomerName`, `FullVIN`, upload arrays)
	- upload file links from Cognito are treated as temporary references only in this phase
- Ticket 5 adds claim persistence:
	- validated intake submissions now create a `Claim` row and related `ClaimAttachment` rows
	- internal claim numbers are generated in `CC-YYYYMMDD-XXXX` format
	- webhook flow now writes a `claim_created` audit entry
	- intake audit writes are now handled by reusable services in `lib/audit/write-audit-log.ts` and `lib/audit/intake-audit-log.ts`
	- raw submission payload JSON is preserved on the claim
	- no duplicate detection yet
	- no provider/background jobs yet
	- no file download/storage migration yet (attachments are metadata only)
- Ticket 6 adds duplicate submission protection:
	- claims now store a nullable unique `dedupeKey`
	- dedupe key is built from canonical validated intake input + stable Cognito identifiers
	- reposting the same payload safely no-ops and returns the existing claim
	- duplicate detections write a `duplicate_blocked` audit log event
	- this prevents accidental replay/retry duplicates for MVP
	- future versions may add secondary heuristic checks if needed
- Ticket 7 adds attachment metadata persistence/visibility:
	- each extracted Cognito file now persists one `ClaimAttachment` row
	- `ClaimAttachment` now stores `filename`, `mimeType`, `fileSize`, `sourceUrl`, `externalId`, and `storageKey`
	- Cognito file URLs are preserved as external references for now
	- `storageKey` remains a placeholder for future app-managed ingestion (S3)
	- files are not downloaded or migrated yet in this ticket
- Business logic, webhook intake, claims processing, and authentication are intentionally
  deferred to later tickets.

Ticket 4 local test example

```bash
curl -X POST http://localhost:3000/api/intake/cognito \
	-H "Content-Type: application/json" \
	-H "x-webhook-secret: ${COGNITO_WEBHOOK_SECRET}" \
	-d '{
		"customer": {
			"customerName": "Jordan Driver",
			"customerEmail": "jordan.driver@example.com",
			"customerPhone": "(555) 010-8844"
		},
		"vehicle": {
			"vin": "1HGCM82633A004352"
		},
		"uploads": {
			"repairOrder": {
				"filename": "repair-order.pdf",
				"sourceUrl": "https://example.com/repair-order.pdf"
			}
		}
	}'
```

How to verify a live Cognito webhook submission

1. Confirm route reachability on deployed app:

```bash
curl -s https://choice-claims-mvp.netlify.app/api/intake/cognito
```

Expected response:

```json
{"ok":true,"route":"/api/intake/cognito","message":"Webhook endpoint is reachable"}
```

2. Confirm Cognito **Submit Entry Endpoint** points to:
	 `https://choice-claims-mvp.netlify.app/api/intake/cognito`
3. Submit a real test entry through the public Cognito form.
4. In Netlify, open **Logs & Metrics → Functions** and inspect logs for `api/intake/cognito`.
5. Match request logs via `requestId` returned in endpoint response.
6. Inspect logs for:
	 - request received
	 - secret validation skipped/passed
	 - raw top-level keys
	 - normalization + validation status

Optional debug mode (temporary)

- Set `COGNITO_WEBHOOK_DEBUG=true` to include extra response fields on successful POST:
	- `topLevelKeys`
	- `payloadPreview`
	- `normalizedPayload`
	- `createClaimInput`
- Keep `COGNITO_WEBHOOK_DEBUG=false` for minimal response shape in normal operation.

Local POST verification example

```bash
curl -X POST http://localhost:3000/api/intake/cognito \
	-H "Content-Type: application/json" \
	-H "x-webhook-secret: ${COGNITO_WEBHOOK_SECRET}" \
	-d '{"CustomerName":{"First":"Jordan","Last":"Driver","FirstAndLast":"Jordan Driver"},"FullVIN":"1HGCM82633A004352","Entry":{"DateSubmitted":"2026-03-17T15:00:00.000Z"}}'
```

Note: Cognito submits structured JSON payloads to the configured endpoint on form submission; attachment file URLs are currently captured for metadata/preview and will be moved to durable storage in a later ticket.

Ticket 5 behavior summary

- Successful `POST /api/intake/cognito` now returns:
	- `ok: true`
	- `requestId`
	- `message: "Claim created successfully"`
	- `claim` with `id`, `claimNumber`, and `status`
- On claim persistence failures, the route returns HTTP `500` with a structured error code.

Ticket 6 behavior summary

- Successful first submission returns:
	- `ok: true`
	- `duplicate: false`
	- `message: "Claim created successfully"`
	- `claim` summary (`id`, `claimNumber`, `status`)
- Reposting the same submission returns:
	- `ok: true`
	- `duplicate: true`
	- `message: "Duplicate submission detected; existing claim returned"`
	- the existing `claim` summary (no new claim row created)

Ticket 6 local verification (duplicate protection)

1. Submit the same payload twice:

```bash
INTAKE_BASE_URL=http://localhost:3000 npm run intake:test-local
INTAKE_BASE_URL=http://localhost:3000 npm run intake:test-local
```

2. Confirm second response has `"duplicate": true`.
3. Confirm only one new claim was added on `/admin/claims` and logs show duplicate detection.

Ticket 7 behavior summary

- Attachment extraction supports known upload arrays and single file-like `Signature` objects.
- One `ClaimAttachment` row is created per normalized file.
- Metadata is preserved for each attachment:
	- `filename`
	- `mimeType`
	- `fileSize`
	- `sourceUrl`
	- `externalId`
	- `storageKey` (nullable placeholder)
- Admin verification views now include attachment visibility in:
	- `/admin/claims` (count + file URL presence)
	- `/admin/claims/[id]` (per-file metadata table)

Ticket 7 migration note

- Apply migrations after pulling Ticket 7:

```bash
npx prisma migrate deploy
```

Ticket 8 behavior summary

- Intake audit logging now uses a dedicated reusable service (`lib/audit/write-audit-log.ts`).
- Intake-specific wrappers in `lib/audit/intake-audit-log.ts` standardize metadata for key events.
- Successful claim persistence writes `claim_created` and links the audit row to the created claim.
- Duplicate submissions write `duplicate_blocked` and link the audit row to the existing claim.
- Intake validation failures write `intake_validation_failed` with request-scoped metadata and no claim link.
- Audit writes are best-effort for intake flow traceability; failures are logged without breaking intake responses.
- Admin claim detail now includes a simple audit section showing action, timestamp, and metadata preview.

Ticket 8 migration note

- No Prisma schema changes were required for Ticket 8.

Ticket 11 payload replay suite (Cognito intake)

- Fixture directory:
	- `test/fixtures/cognito/`
	- `manifest.json` defines run order and expected outcome per payload (`created`, `duplicate`, `validation_failed`).
- Fixtures included:
	- `valid-claim.json` — realistic baseline payload, expected `created`
	- `duplicate-claim.json` — exact replay of `valid-claim.json`, expected `duplicate`
	- `missing-vin.json` — omits `FullVIN`, tests current validation behavior
	- `missing-contact.json` — omits `CustomerEmail`, tests current validation behavior
	- `multiple-attachments.json` — multiple upload arrays and files, expected `created`
- Replay runner:
	- script: `scripts/replay-intake-fixtures.mjs`
	- npm command: `npm run test:intake`
	- posts each fixture to intake endpoint, compares actual vs expected, and prints per-fixture + final summary counts.

Ticket 11 local run

```bash
npm run dev
npm run test:intake
```

Optional endpoint targets

- Use `INTAKE_TEST_URL` for full endpoint URL:

```bash
INTAKE_TEST_URL=http://localhost:3000/api/intake/cognito npm run test:intake
```

Ticket 9 behavior summary (AutoCheck enrichment expansion)

- AutoCheck live provider now keeps `vinspecifications` as the required endpoint and adds best-effort enrichment requests for:
	- `quickcheck`
	- `ownershiphistory`
	- `accident`
	- `mileage`
	- `recall`
	- `titleproblem`
	- `titlebrand`
- Required-vs-optional behavior:
	- if `vinspecifications` fails, lookup still fails and claim follows existing ProviderFailed handling
	- if any optional enrichment endpoint fails, worker continues and claim can still reach `ReadyForAI`
- Raw payload storage shape is endpoint-keyed in `Claim.vinDataRawPayload`:
	- includes `vinspecifications` response
	- includes successful optional endpoint payloads by endpoint name
	- includes optional `endpointErrors` object keyed by endpoint with concise error details
- Normalized enrichment summary fields are now persisted in `Claim.vinDataResult` when present:
	- `quickCheck`, `ownershipHistory`, `accident`, `mileage`, `recall`, `titleProblem`, `titleBrand`
	- each field stores a compact summary object intended for admin and AI workflow context (not a raw payload dump)
- Admin claim detail page (`/admin/claims/[id]`) now shows:
	- endpoints attempted
	- optional endpoint failure count and per-endpoint failure details when present

```bash
INTAKE_TEST_URL=https://your-site.netlify.app/api/intake/cognito npm run test:intake
```

- Or pass `--url` as a base URL or full endpoint URL:

```bash
npm run test:intake -- --url http://localhost:3000
npm run test:intake -- --url https://your-site.netlify.app/api/intake/cognito
```

Webhook secret support

- If `COGNITO_WEBHOOK_SECRET` is set, replay requests include `x-webhook-secret` automatically.

Current validation assumptions (important)

- Based on current normalized intake schema, `vin` and contact fields are optional.
- For current behavior, `missing-vin.json` and `missing-contact.json` are expected to be `created` (HTTP `200`) unless intake validation rules are tightened in a future ticket.
- The replay runner reports mismatches directly; it does not mask unexpected outcomes.

Sprint 2 status lifecycle note

- Async lifecycle statuses are now defined on `ClaimStatus`: `Submitted`, `AwaitingVinData`, `ReadyForAI`, `ProviderFailed`, `ProcessingError`.
- Allowed transitions are documented in code comments near the enum and are not yet enforced in runtime logic.
- This ticket does not add queue, worker, or provider integration logic.

Sprint 2 queue infrastructure (Ticket 2)

- BullMQ is now installed and queue infrastructure scaffolding is in place.
- Redis is required only when queue infrastructure is actively used.
- Queue/Redis config is isolated in one shared module:
	- `lib/queue/config.ts`
- Queue instances should be created through the shared helper:
	- `lib/queue/get-queue.ts`

Required environment variables

- `REDIS_URL` (required when invoking queue infrastructure)
- `QUEUE_PREFIX` (optional; defaults to `choice-claims`)

Queue connectivity smoke test

1. Set `REDIS_URL` in your environment.
2. Optionally set `QUEUE_PREFIX`.
3. Run:

```bash
npm run test:queue
```

Expected output includes:

- `[QUEUE_SMOKE_TEST] Redis connection successful`

Local vs staging notes

- Local: use a local or hosted Redis URL in `.env.local`.
- Staging: set `REDIS_URL` (and optional `QUEUE_PREFIX`) in Netlify environment variables.

Scope boundaries for Ticket 2

- No job enqueueing yet.
- No BullMQ worker processing yet.
- No provider integrations yet.
- No retry or transition enforcement logic yet.

Sprint 2 queue contracts (Ticket 3)

- Queue names are now standardized in one place:
	- `lib/queue/queue-names.ts`
- Job names are now standardized in one place:
	- `lib/queue/job-names.ts`
- Typed queue job payload contracts now live in:
	- `lib/queue/job-payloads.ts`
- Queue/job contract bindings and helpers now live in:
	- `lib/queue/contracts.ts`
- Optional VIN lookup payload builder now lives in:
	- `lib/queue/build-vin-lookup-job.ts`
- `getQueue` now accepts typed queue names (`QueueName`) for safer queue creation.

Ticket 3 scope boundaries

- No enqueueing from claim creation yet.
- No worker processing or handlers yet.
- No provider integrations yet.
- No retry logic yet.

Sprint 2 async enqueue integration (Ticket 4)

- Newly created claims now enqueue a VIN lookup job after persistence.
- Queue/job used:
	- queue: `vin-data`
	- job: `lookup-vin-data`
- On successful enqueue, claim status is updated from `Submitted` to `AwaitingVinData`.
- Successful enqueue writes an audit log action: `vin_lookup_enqueued`.
- Duplicate submissions do not enqueue additional jobs.
- Near-immediate Cognito webhook retries are classified as `duplicate_replay_ignored` (instead of `duplicate_blocked`) to reduce false alarm noise while preserving idempotency.
- Duplicate replay audit metadata now includes Cognito identity fields for support triage: `cognitoPayloadId` and `cognitoEntryNumber`.
- Cognito duplicate detection now prioritizes submission identity in this order:
	- `rawSubmissionPayload.Entry.Number`
	- `rawSubmissionPayload.Id`
	- `rawSubmissionPayload.Entry.DateSubmitted`
- Canonical normalized-field hashing is used only when Cognito submission identifiers are missing.

Ticket 4 scope boundaries

- No worker processing yet.
- No provider integration yet.
- No retry system yet.
- No status transition enforcement engine yet.

Sprint 2 worker process (Ticket 5)

- A BullMQ worker entry now exists at:
	- `worker/worker.ts`
- The worker runs separately from the web server and listens to:
	- queue: `vin-data`
- The worker currently logs lifecycle/job events only:
	- worker starting
	- connected to Redis
	- job received
	- job completed
	- job failed

Start the worker

```bash
npm run worker
```

Worker requirements

- `REDIS_URL` must be set.
- Optional `QUEUE_PREFIX` is respected.

Ticket 5 scope boundaries

- No provider logic yet.
- No CARFAX/AutoCheck calls yet.
- No retry system yet.
- No job result persistence yet.

Sprint 2 provider abstraction (Ticket 6)

- A VIN provider abstraction now exists so worker logic is separated from provider implementations.
- Shared normalized provider result type now lives in:
	- `lib/providers/types.ts`
- Provider interface contract now lives in:
	- `lib/providers/provider-interface.ts`
- Stub provider implementations now live in:
	- `lib/providers/carfax-provider-stub.ts`
	- `lib/providers/autocheck-provider-stub.ts`
- Provider resolver/factory now lives in:
	- `lib/providers/get-vin-provider.ts`

Worker integration (Ticket 6)

- Worker now resolves a provider and calls `lookupVinData(vin)` for `lookup-vin-data` jobs.
- Worker logs include:
	- job received
	- provider selected
	- provider result
	- job completed
- If VIN is missing/null in payload, worker logs and safely skips provider call.

Provider selection

- Optional env selector is supported:
	- `VIN_DATA_PROVIDER=carfax|autocheck`
- Default provider is `carfax` when selector is unset or invalid.

Ticket 6 scope boundaries

- No real CARFAX API calls.
- No real AutoCheck API calls.
- No persistence of provider results yet.
- No claim status updates from provider results yet.
- No retry logic yet.
- No failure-state UI yet.

Sprint 2 mocked VIN job handler (Ticket 7)

- Worker now handles `lookup-vin-data` jobs end-to-end with mocked providers.
- Worker flow now:
	- loads claim by `claimId`
	- resolves provider via abstraction
	- calls provider stub
	- stores normalized VIN data result on claim
	- updates claim status on success: `AwaitingVinData -> ReadyForAI`
	- writes audit events for success/failure

Claim VIN data persistence fields (Ticket 7)

- Claim now stores mocked VIN provider results in:
	- `vinDataResult` (JSON)
	- `vinDataProvider` (string)
	- `vinDataFetchedAt` (datetime)

Missing VIN behavior (Ticket 7)

- If VIN is missing/null/empty for a job:
	- provider call is skipped
	- claim status is set to `ProviderFailed`
	- audit event `vin_data_fetch_failed` is written with reason `vin_missing`

Audit events added (Ticket 7)

- `vin_data_fetched`
- `vin_data_fetch_failed`

Ticket 7 scope boundaries

- No real CARFAX API calls.
- No real AutoCheck API calls.
- No retry logic yet.
- No advanced failure recovery yet.
- No manual retry UI yet.
- No full transition enforcement engine yet.

Sprint 2 retry + failure visibility (Ticket 8)

- VIN lookup jobs now include BullMQ retry support:
	- attempts: `3`
	- exponential backoff with a small delay
- Claim now persists VIN lookup retry/failure details:
	- `vinLookupAttemptCount`
	- `vinLookupLastError`
	- `vinLookupLastFailedAt`
	- `vinLookupLastJobId`
	- `vinLookupLastJobName`
	- `vinLookupLastQueueName`
- Worker behavior now records attempt metadata on every run and keeps processing other jobs when one fails.
- Failure states are persisted and visible:
	- provider lookup failures set claim status to `ProviderFailed`
	- non-provider processing failures set claim status to `ProcessingError`
- Failure audits use `vin_data_fetch_failed` with useful metadata including:
	- `jobId`, `jobName`, `queueName`
	- `attemptsMade`, `attemptsAllowed`
	- `errorMessage`
- Success path remains unchanged for Ticket 7 outcomes:
	- `AwaitingVinData -> ReadyForAI`
	- provider result persistence
	- `vin_data_fetched` audit logging

Ticket 8 failure-path test note

- Provider stubs intentionally throw for VINs containing `FAIL` to validate retry/failure handling safely without external APIs.

Ticket 8 scope boundaries

- No real CARFAX API calls.
- No real AutoCheck API calls.
- No manual retry UI yet.
- No queue dashboards or operator tooling yet.
- No advanced fallback/orchestration logic yet.

Sprint 2 admin async visibility (Ticket 9)

- Admin claim detail page now highlights async VIN processing state in a readable section.
- Detail page surfaces key async metadata directly:
	- status
	- provider
	- fetched time
	- year/make/model summary
	- attempt count
	- last error and failure time
	- last queue/job metadata
- Detail page now includes a focused "Latest Async Audit Events" view for:
	- `vin_lookup_enqueued`
	- `vin_data_fetched`
	- `vin_data_fetch_failed`
- Admin claims list now makes async outcomes easier to scan:
	- clear status badges for `AwaitingVinData`, `ReadyForAI`, `ProviderFailed`, `ProcessingError`
	- compact provider/attempt/error visibility
	- simple status filter for async statuses
	- failure rows highlighted for quick triage
- Developer raw JSON debug section remains available on claim detail pages.

Sprint 3 OAuth-ready provider abstraction (Ticket 2)

- Added OAuth provider env scaffolding for future Experian/AutoCheck integrations:
	- `EXPERIAN_BASE_URL`
	- `EXPERIAN_USERNAME`
	- `EXPERIAN_PASSWORD`
	- `EXPERIAN_CLIENT_ID`
	- `EXPERIAN_CLIENT_SECRET`
- Added provider OAuth helper modules:
	- `lib/providers/oauth-token.ts`
	- `lib/providers/authenticated-fetch.ts`
- OAuth token helper supports:
	- token fetch from OAuth endpoint
	- in-memory token caching only
	- expiry checks and safe refresh behavior
- Added provider config helpers for Experian OAuth readiness in:
	- `lib/providers/config.ts`
- Sandbox base URL example for setup:
	- `https://sandbox-us-api.experian.com`
- Real provider API calls are still not implemented in this ticket.
- Stub providers and existing worker/job flow remain unchanged.
- Provider secrets must be set in `.env.local`/Netlify env vars and must never be committed.

Sprint 3 AutoCheck live VIN Specifications integration (Ticket 4)

- Added first live VIN provider implementation:
	- `lib/providers/autocheck-provider-live.ts`
- Live AutoCheck provider uses existing OAuth and authenticated request helpers:
	- `lib/providers/oauth-token.ts`
	- `lib/providers/authenticated-fetch.ts`
- Request path now targets Experian EITS gateway + VIN Specifications endpoint:
	- gateway: `/eits/gdp/v1/request?targeturl=...`
	- target: `/automotive/accuselect/v1/vinspecifications?vinlist={VIN}`
	- optional overrides via env for contract drift troubleshooting:
		- `EXPERIAN_VINSPECS_TARGET_PATH`
		- `EXPERIAN_VINSPECS_QUERY_PARAM`
- Resolver behavior:
	- `VIN_DATA_PROVIDER=autocheck` + valid `EXPERIAN_*` config -> live provider
	- otherwise AutoCheck stub remains active
- Result handling:
	- normalizes `vin`, `year`, `make`, `model`
	- preserves provider response data for downstream persistence
- Failure handling includes:
	- missing VIN
	- missing OAuth config
	- token failure
	- non-200 responses
	- timeout
	- invalid JSON
	- no vehicle data returned
- Scope boundaries:
	- AutoCheck only
	- VIN Specifications only
	- no CARFAX live integration yet
	- no QuickCheck endpoint yet
	- no worker/queue redesign

Sprint 3 AutoCheck live hardening (Ticket 5)

- AutoCheck live provider now uses structured provider errors with safe reason codes for:
	- missing config
	- OAuth request/response failures
	- gateway/network failures
	- HTTP status failures
	- timeouts
	- no vehicle data
	- invalid response shape/JSON
- Timeout handling is enforced for both OAuth token requests and gateway calls via `VIN_PROVIDER_TIMEOUT_MS`.
- Sandbox no-data and odd response-shape cases are treated as safe `ProviderFailed` outcomes rather than worker crashes.
- Worker failure handling now records provider error codes safely in logs/audit reasons while keeping existing queue/worker flow unchanged.
- Known sandbox test VINs remain the expected happy-path verification route for `ReadyForAI`.

Sprint 3 provider persistence cleanup (Ticket 6)

- Claim persistence now stores normalized provider result and raw provider payload separately:
	- `vinDataResult` stores normalized VIN attributes for AI/admin usage.
	- `vinDataRawPayload` stores raw provider JSON for debugging.
- Provider metadata is stored alongside result payloads:
	- `vinDataProvider`
	- `vinDataFetchedAt`
	- `vinDataProviderResultCode` (when available)
	- `vinDataProviderResultMessage` (when available)
- Success-path persistence is explicit and retry-safe so failed retries do not overwrite prior successful VIN provider data.

Sprint 3 manual retry hardening (Ticket 7)

- Manual retry now supports failed async statuses only:
	- retryable: `ProviderFailed`, `ProcessingError`
	- blocked: `Submitted`, `AwaitingVinData`, `ReadyForAI`
- Retry orchestration is explicit and duplicate-safe:
	- status is transitioned to `AwaitingVinData` before enqueue
	- stale/double-click retries are blocked if status changed
	- enqueue failure restores previous failed status
- Manual retry resets transient failure fields only:
	- clears `vinLookupLastError`, `vinLookupLastFailedAt`, last queue/job ids
	- sets `vinLookupRetryRequestedAt`
	- preserves prior successful provider data (`vinDataResult`, `vinDataRawPayload`, provider metadata)
- Attempt count semantics are now explicit:
	- `vinLookupAttemptCount` is reset on manual retry and tracks attempts for the current retry run.
- Manual retry now writes a dedicated audit action:
	- `vin_lookup_requeued` with previous/new status, queue/job identifiers, VIN, and `reason: manual_retry`.

Sprint 3 admin provider visibility improvements (Ticket 8)

- Admin claim detail now surfaces provider metadata in a clearer summary block:
	- provider name
	- fetched timestamp
	- provider result code/message
	- run attempt count
	- retry requested timestamp
	- last error and queue/job metadata
	- provider endpoint/source hints when available from stored payloads
- Claim detail now labels provider JSON sections more clearly:
	- normalized provider result (app-friendly)
	- raw provider payload (debug-focused)
- Admin claims list now adds lightweight provider context for faster triage:
	- provider fetched timestamp
	- compact provider result preview (vehicle summary / provider message / code / pending)
	- clearer scanning of ReadyForAI vs ProviderFailed rows with provider context.

Files & structure

- `app/` — Next.js App Router pages and layout
- `components/` — shared UI components (e.g., header)
- `lib/` — shared utilities and helpers (placeholder)
- `styles/` — global styles (Tailwind)
- `prisma/` — placeholder Prisma schema for later DB work

What you'll need to do manually

1. Replace `<YOUR_GITHUB_REPO_URL>` in the git push steps above with your repo URL.
2. On Netlify: connect the repository, confirm the build command is `npm run build`, and
	 add environment variables from `.env.example` (for production/staging secrets).
3. Optionally set Node version under Netlify Build environment if you need a specific
	 Node.js version.

Next steps (Sprint 1 and beyond)

- Sprint 1 will add claims intake, admin listing, and basic DB integration (Supabase).
- Later tickets will add authentication (Cognito), webhook processing, and claim
	processing pipelines.


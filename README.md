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
	- `ClaimStatus` enum (`Submitted`)
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
	- `claim_created` audit writes are handled by a dedicated helper service (`lib/audit/write-claim-created-audit-log.ts`)
	- raw submission payload JSON is preserved on the claim
	- no duplicate detection yet
	- no provider/background jobs yet
	- no file download/storage migration yet (attachments are metadata only)
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


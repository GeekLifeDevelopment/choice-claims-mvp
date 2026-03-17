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
- This ticket intentionally excludes database, authentication, and webhook logic —
	those will be added in later tickets (e.g., Supabase integration and Cognito flows).

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


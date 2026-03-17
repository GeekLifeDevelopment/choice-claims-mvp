export default function HomePage() {
  return (
    <section className="space-y-6">
      <div className="card">
        <h1 className="text-3xl">Choice Claims MVP — Staging</h1>
        <p className="mt-3 text-slate-700 max-w-prose">
          Welcome — this is the staging environment for the Choice Claims Minimum Viable
          Product. It demonstrates the baseline app structure (Next.js App Router,
          TypeScript, Tailwind CSS) and provides a simple admin placeholder for early
          stakeholder review.
        </p>
      </div>

      <div className="card">
        <h2 className="text-lg">Staging note</h2>
        <p className="mt-2 text-slate-700">
          This environment is for progress review only. Core features such as the database,
          webhook intake, and claims processing will be implemented in later tickets.
        </p>
      </div>
    </section>
  )
}

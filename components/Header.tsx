import Link from 'next/link'

export default function Header() {
  return (
    <header className="bg-white border-b">
      <div className="container flex items-center justify-between h-16">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-lg font-semibold text-slate-900">
            Choice Claims MVP
          </Link>
        </div>

        <nav aria-label="Main navigation" className="flex items-center gap-2">
          <Link
            href="/"
            className="px-3 py-2 text-sm rounded-md text-slate-700 hover:bg-slate-50"
          >
            Home
          </Link>
          <Link
            href="/admin/claims"
            className="px-3 py-2 text-sm rounded-md text-slate-700 hover:bg-slate-50"
          >
            Claims
          </Link>
        </nav>
      </div>
    </header>
  )
}

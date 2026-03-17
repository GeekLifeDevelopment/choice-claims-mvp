import '../styles/globals.css'
import Header from '../components/Header'

export const metadata = {
  title: 'Choice Claims MVP (staging)'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1 container py-8">{children}</main>
          <footer className="border-t py-4 text-sm text-slate-600">
            <div className="container">Choice Claims MVP — Staging</div>
          </footer>
        </div>
      </body>
    </html>
  )
}

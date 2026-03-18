/** @type {import('next').NextConfig} */
const isCiBuild = process.env.CI === 'true' || process.env.NETLIFY === 'true'

const nextConfig = {
  reactStrictMode: true,
  // Netlify plugin expects production output in .next.
  distDir: isCiBuild ? '.next' : 'next-dist',
  webpack: (config, { dev }) => {
    if (dev) {
      // iCloud-backed folders can cause intermittent fs cache write/read failures.
      config.cache = false
    }

    return config
  }
}

module.exports = nextConfig

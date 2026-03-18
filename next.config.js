/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: 'next-dist',
  webpack: (config, { dev }) => {
    if (dev) {
      // iCloud-backed folders can cause intermittent fs cache write/read failures.
      config.cache = false
    }

    return config
  }
}

module.exports = nextConfig

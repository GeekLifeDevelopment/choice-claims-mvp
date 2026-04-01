const nextConfig = {
  reactStrictMode: true,
  // Use a dedicated output directory for this iCloud-backed workspace.
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

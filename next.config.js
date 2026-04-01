const nextConfig = {
  reactStrictMode: true,
  // Use a dedicated output directory for this iCloud-backed workspace.
  distDir: 'next-dist',
  webpack: (config, { dev, isServer }) => {

    if (dev) {
      // iCloud-backed folders can cause intermittent fs cache write/read failures.
      config.cache = false
    }

    if (isServer && typeof config.output?.chunkFilename === 'string') {
      const serverChunkFilename = config.output.chunkFilename
      if (!serverChunkFilename.startsWith('chunks/')) {
        config.output.chunkFilename = `chunks/${serverChunkFilename}`
      }
    }

    return config
  }
}

module.exports = nextConfig

const nextConfig = {
  reactStrictMode: true,
  // Use the default Next output directory for consistent chunk resolution.
  distDir: '.next',
  webpack: (config, { dev }) => {

    if (dev) {
      // iCloud-backed folders can cause intermittent fs cache write/read failures.
      config.cache = false
    }

    return config
  }
}

module.exports = nextConfig

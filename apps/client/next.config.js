const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "i.scdn.co" },
      { protocol: "https", hostname: "*.bcbits.com" },
      { protocol: "https", hostname: "media.nts.live" },
    ],
  },
};

module.exports = withSentryConfig(nextConfig, {
  // Suppress source map upload (no auth token yet)
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Don't upload source maps until SENTRY_AUTH_TOKEN is set
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
});

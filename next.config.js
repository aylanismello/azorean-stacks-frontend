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

module.exports = nextConfig;

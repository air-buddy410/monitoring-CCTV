// Destinations are baked in at build time: set PANTAU_API_ORIGIN before `next build`.
const api = process.env.PANTAU_API_ORIGIN ?? "http://127.0.0.1:3101";

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  transpilePackages: ["@pantau/contracts"],
  async rewrites() {
    // Same-origin proxy: the browser only talks to this origin, so the backend's session cookie
    // and Origin/CSRF checks work unchanged.
    return [
      { source: "/api/auth/:path*", destination: `${api}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${api}/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;

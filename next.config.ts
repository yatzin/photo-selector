import type { NextConfig } from "next";
import { securityHeaderRules } from "./lib/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  // No "X-Powered-By: Next.js" — it only helps someone pick an exploit.
  poweredByHeader: false,
  async headers() {
    return securityHeaderRules(process.env.NODE_ENV === "development");
  },
  experimental: {
    globalNotFound: true,
  },
};

export default nextConfig;

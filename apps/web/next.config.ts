import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import {
  configureFileWatching,
  shouldPollForFileChanges,
} from "./lib/dev-file-watching";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const apiOrigin = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001";
const pollForFileChanges = shouldPollForFileChanges(
  process.platform,
  workspaceRoot,
);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  transpilePackages: ["@dialed/domain"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    webpackBuildWorker: false,
  },
  webpack(config, { dev }) {
    return configureFileWatching(config, dev, pollForFileChanges);
  },
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      {
        source: "/api/auth/:path*",
        destination: `${apiOrigin}/api/auth/:path*`,
      },
      { source: "/api/docs/:path*", destination: `${apiOrigin}/docs/:path*` },
    ];
  },
};

export default nextConfig;

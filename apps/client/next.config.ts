import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@astraprotocols/sdk"],
  serverExternalPackages: ["@stellar/stellar-sdk"],
};

export default nextConfig;

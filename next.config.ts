import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright", "@remotion/bundler", "@remotion/renderer"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // CLAUDE.md is the agent instruction file; stop `next dev` generating or editing AGENTS.md.
  agentRules: false,
  // lib/ai/prompts.ts reads /prompts/*.md at runtime; ship them with every server function.
  outputFileTracingIncludes: { "/**": ["./prompts/**"] },
};

export default nextConfig;

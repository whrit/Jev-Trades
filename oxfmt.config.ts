import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 80,
  ignorePatterns: [
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "pnpm-lock.yaml",
    "pipeline/**",
    "AGENTS.md",
    "CLAUDE.md",
  ],
});

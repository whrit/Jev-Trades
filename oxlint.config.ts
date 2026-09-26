import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: [
    "typescript",
    "react",
    "nextjs",
    "jsx-a11y",
    "import",
    "unicorn",
    "oxc",
  ],
  categories: { correctness: "error" },
  env: { builtin: true },
  ignorePatterns: [
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "pipeline/**",
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  settings: { react: { version: "19.2.8" }, next: { rootDir: "." } },
  rules: {
    "no-array-constructor": "error",
    "no-unused-expressions": "error",
    "no-unused-vars": "error",
    "no-var": "error",
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "error",
    "react/jsx-key": "error",
    "react/react-in-jsx-scope": "off",
    "nextjs/no-html-link-for-pages": "error",
    "nextjs/no-img-element": "error",
    "typescript/ban-ts-comment": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-namespace": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-this-alias": "error",
    "typescript/no-unnecessary-type-constraint": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/prefer-as-const": "error",
    "typescript/triple-slash-reference": "error",
  },
  overrides: [
    { files: ["app/**"], env: { browser: true, node: true } },
    { files: ["*.config.{ts,mjs}"], env: { node: true } },
    {
      // shadcn/ui primitives: the input-group addon's click-to-focus is a
      // mouse convenience; keyboard users reach the input directly.
      files: ["components/ui/**"],
      rules: {
        "jsx-a11y/prefer-tag-over-role": "off",
        "jsx-a11y/click-events-have-key-events": "off",
        "jsx-a11y/no-noninteractive-element-interactions": "off",
      },
    },
  ],
});

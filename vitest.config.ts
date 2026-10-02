import { defineConfig } from "vitest/config"
import { fileURLToPath } from "url"

// Pure logic only — nothing under test touches the database or Next.js. The
// alias mirrors tsconfig's "@/*" so modules import exactly as they do in the app.
const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: root }] },
  test: { include: ["lib/**/*.test.ts"], environment: "node" },
})

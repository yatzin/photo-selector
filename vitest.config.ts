import { defineConfig } from "vitest/config"
import { fileURLToPath } from "url"

// Mostly pure logic. The runner integration test (lib/ai/runner-server.test.ts)
// uses its own temporary SQLite database and folders. The alias mirrors
// tsconfig's "@/*" so modules import exactly as they do in the app; the
// "server-only" marker is stubbed because it throws outside Next.js.
const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: root },
      { find: /^server-only$/, replacement: `${root}test-support/server-only.ts` },
    ],
  },
  test: { include: ["lib/**/*.test.ts"], environment: "node" },
})

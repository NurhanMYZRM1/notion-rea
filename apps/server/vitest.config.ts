import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789",
          CONSENT_SECRET: "test-only-consent-secret-0123456789abcdef",
          ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000 },
}));

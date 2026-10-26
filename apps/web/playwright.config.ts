import { defineConfig, devices } from "@playwright/test";

// One local dev server (SPA + Worker in workerd) shared by every test; tests create their own users/workspaces.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --port 5173",
    url: "http://localhost:5173/api/providers",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

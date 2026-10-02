import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3179/app",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: "node ../../dist/ui/serve.js --port 3179",
    url: "http://127.0.0.1:3179/app",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

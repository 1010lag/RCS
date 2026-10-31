import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:3181", trace: "retain-on-failure" },
  webServer: {
    command: "tsx tests/e2e-server.ts",
    url: "http://127.0.0.1:3181/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: { APP_ORIGIN: "http://127.0.0.1:3181" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: "list",
});

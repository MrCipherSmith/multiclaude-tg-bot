import { defineConfig, devices } from "@playwright/test";
import { resolve, join } from "path";

const BASE_URL = process.env.TEST_BASE_URL ?? "https://helyx.mrciphersmith.com";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // sequential — shared server state

  globalSetup: "./global-setup.ts",

  use: {
    baseURL: BASE_URL,
    headless: true,
    ignoreHTTPSErrors: false,
    screenshot: "only-on-failure",
    video: "off",
    extraHTTPHeaders: {
      // injected by fixtures.ts per-test; set empty here
    },
  },

  projects: [
    {
      name: "api",
      testDir: "./e2e/api",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "dashboard",
      testDir: "./e2e/dashboard",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  outputDir: "./test-results",
});

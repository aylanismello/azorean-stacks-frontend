import { defineConfig, devices } from "@playwright/test";

// Pass port via env: PORT=3002 npx playwright test
const port = process.env.PORT || "3000";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "on",
  },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["iPhone 14"],
        // Override to chromium — WebKit has IPv6/localhost issues on macOS
        browserName: "chromium",
        isMobile: true,
        hasTouch: true,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});

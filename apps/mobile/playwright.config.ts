import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    { command: 'npx vite build --outDir dist-test && npx vite preview --outDir dist-test --host 127.0.0.1 --port 4175', url: 'http://127.0.0.1:4175', env: { VITE_ATRIS_RELAY_URL: 'ws://127.0.0.1:4190/remote/v1/ws' }, reuseExistingServer: false, timeout: 120000 },
    { command: 'npx tsx tests/bridge-fixture.ts', url: 'http://127.0.0.1:4191/health', reuseExistingServer: false, timeout: 60000 },
  ],
});

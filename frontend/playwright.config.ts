import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [{
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: { VITE_API_URL: 'http://127.0.0.1:4174' }
  }, {
    command: 'node ../backend/node_modules/ts-node/dist/bin.js --project ../backend/tsconfig.json ../backend/src/server.ts',
    url: 'http://127.0.0.1:4174/health',
    reuseExistingServer: false,
    env: { NODE_ENV: 'test', PORT: '4174', DATA_DIR: '.lab-validation/e2e', INTERNAL_API_KEY: 'test-lab-browser-local-only', JWT_SECRET: 'test-lab-browser-jwt-local-only', DATABASE_URL: '' }
  }],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});

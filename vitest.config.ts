import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          SLACK_SIGNING_SECRET: 'test-signing-secret',
          SLACK_BOT_TOKEN: 'xoxb-test',
          AI_GATEWAY_TOKEN: 'test-aig-token',
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
          GITHUB_INSTALLATION_ID: '67890',
          GITHUB_REPO: 'example/clips',
          FIRECRAWL_API_KEY: 'fc-test',
          X_BEARER_TOKEN: 'x-test',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});

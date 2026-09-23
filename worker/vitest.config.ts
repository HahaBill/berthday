import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    main: fileURLToPath(new URL('./index.ts', import.meta.url)),
    remoteBindings: false,
    miniflare: {
      // The pool's bundled workerd currently supports dates through August 22;
      // production remains on the PRD's September 1 compatibility date.
      compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings: { APP_VERSION: 'test', TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('../migrations', import.meta.url))) },
    },
  })],
  test: { include: ['worker/__tests__/**/*.test.ts'], fileParallelism: false },
}));

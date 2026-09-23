import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['shared/**/*.test.ts', 'worker/ask/**/*.test.ts', 'src/**/*.test.ts'], environment: 'node' } });

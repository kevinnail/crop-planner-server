import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: '.env.test' });

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/apply-schema.ts'],
    },
  },
});

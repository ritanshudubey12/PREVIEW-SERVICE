import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Tests read DB credentials from the git-ignored .env (never hard-coded) and use a separate
// "<DB_NAME>_test" database so real data is never touched.
const env = loadEnv('test', process.cwd(), '');
const testEnv = {
  DB_HOST: env.DB_HOST ?? '',
  DB_PORT: env.DB_PORT ?? '',
  DB_USER: env.DB_USER ?? '',
  DB_PASSWORD: env.DB_PASSWORD ?? '',
  DB_NAME: `${env.DB_NAME ?? 'preview_service'}_test`,
};
// globalSetup runs in the main process, which `test.env` does not reach.
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    env: testEnv,
    // All files share one test database; run files one at a time to keep truncation deterministic.
    fileParallelism: false,
    testTimeout: 15000,
  },
});

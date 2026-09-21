import { defineConfig } from 'vitest/config';

// Allow TS source that uses explicit ".js" import specifiers (NodeNext style)
// to resolve to the corresponding ".ts" files under Vite/Vitest.
export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' }],
  },
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['tests/**/*.test.ts'],
  },
});

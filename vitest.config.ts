import { defineConfig } from 'vitest/config';

// Standalone Vitest config — deliberately NOT importing vite.config.ts, whose
// plugins boot the game WebSocket server + editor save channel. Tests need none
// of that. Scoped to TS specs only so the existing dependency-free Node smoke
// tests (server/*.test.js, which call process.exit and watch files) keep running
// under `npm run test:server`, untouched.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});

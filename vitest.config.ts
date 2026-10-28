import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The gear, thread and mate tests build real geometry with the kernel: a few run 2 s here and
    // twice that on a busy CI runner, which the default 5 s has tripped over.
    testTimeout: 30000,
  },
});

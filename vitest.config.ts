import { defineConfig } from 'vitest/config';
import { dracoModule } from './tools/dracoModule.ts';

export default defineConfig({
  plugins: [dracoModule()],
  test: {
    // The Draco decoder is a script inside three.js that the plugin above makes a module of: it has to go through
    // the plugin rather than be loaded as it is.
    server: { deps: { inline: [/draco_wasm_wrapper/] } },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The gear, thread and mate tests build real geometry with the kernel: a few run 2 s here and
    // twice that on a busy CI runner, which the default 5 s has tripped over.
    testTimeout: 30000,
  },
});

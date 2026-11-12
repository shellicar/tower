import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Lists only failing tests, then the summary. Vitest picks this reporter
    // itself only when it detects a known agent from the environment.
    reporters: ['agent'],
  },
});

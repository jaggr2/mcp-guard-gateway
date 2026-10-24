import { defineConfig } from "vitest/config";

// Self-contained test setup: the parent repo's vitest config only matches its
// own `test/**` folder, so these tests never get picked up from the root.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

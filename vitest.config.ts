import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Benches are not tests and must not run in CI; `vitest bench` picks these up on its own.
    benchmark: { include: ["bench/**/*.bench.ts"] },
    environment: "node",
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text", "html"] },
  },
});

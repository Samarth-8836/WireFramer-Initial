import path from "node:path";
import { defineConfig } from "vitest/config";

// Vitest doesn't read tsconfig "paths" natively, so we mirror them here.
// Keep this list in sync with tsconfig.json compilerOptions.paths.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@core": path.resolve(__dirname, "./src/core"),
      "@components": path.resolve(__dirname, "./src/components"),
      "@stores": path.resolve(__dirname, "./src/stores"),
      "@lib": path.resolve(__dirname, "./src/lib"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Source uses NodeNext-style ".js" specifiers that point at ".ts" files.
    alias: [{ find: /^(\.[^.]*(\.[^.]*)*)\.js$/, replacement: "$1" }],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

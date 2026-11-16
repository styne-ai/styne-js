import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./spec/openapi.yaml",
  output: { path: "src/_generated", clean: true },
  plugins: [
    "@hey-api/typescript",
    { name: "@hey-api/sdk", operations: { strategy: "flat" } },
    "@hey-api/client-fetch",
  ],
});

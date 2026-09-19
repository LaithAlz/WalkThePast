import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  build: { target: "es2022" },
  // Spark ships a Wasm blob + worker inline; keep it out of the dep optimizer
  // so Vite serves the module untouched.
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
});

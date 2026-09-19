import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const hasClerk = !!env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!hasClerk) console.warn("[walk-the-past] VITE_CLERK_PUBLISHABLE_KEY not set: auth is stubbed, the app runs signed-out.");
  return {
    plugins: [react()],
    resolve: {
      alias: hasClerk ? {} : { "@clerk/react": fileURLToPath(new URL("./src/shims/clerk-stub.tsx", import.meta.url)) },
    },
    // Spark ships a Wasm blob + worker inline; keep it out of the dep optimizer.
    optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  };
});

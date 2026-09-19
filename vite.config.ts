import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { marbleApi } from "./server/marble";
import { viewsApi } from "./server/views";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const hasClerk = !!env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!hasClerk) console.warn("[walk-the-past] VITE_CLERK_PUBLISHABLE_KEY not set: auth is stubbed, the app runs signed-out.");
  return {
    plugins: [react(), marbleApi({ apiKey: env.WORLDLAB_API_KEY || env.WORLDLABS_API_KEY, worldsDir: fileURLToPath(new URL("./public/worlds", import.meta.url)) }), viewsApi({ geminiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, openaiKey: env.OPENAI_API_KEY })],
    resolve: {
      alias: hasClerk ? {} : { "@clerk/react": fileURLToPath(new URL("./src/shims/clerk-stub.tsx", import.meta.url)) },
    },
    // Spark ships a Wasm blob + worker inline; keep it out of the dep optimizer.
    optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  };
});

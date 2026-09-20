import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createNarrationHandler } from "./server/narration.ts";
import { marbleApi } from "./server/marble.ts";
import { fetchWithRetry } from "./server/retryFetch.ts";
import { viewsApi } from "./server/views.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const hasClerk = !!env.VITE_CLERK_PUBLISHABLE_KEY;
  const openAIKey = env.OPENAI_API_KEY;
  const alias: Record<string, string> = hasClerk
    ? {}
    : { "@clerk/react": fileURLToPath(new URL("./src/shims/clerk-stub.tsx", import.meta.url)) };
  if (!hasClerk) console.warn("[walk-the-past] VITE_CLERK_PUBLISHABLE_KEY not set: auth is stubbed, the app runs signed-out.");
  return {
    plugins: [
      react(),
      // World generation from the user's own photo or text (Laith's bridge).
      marbleApi({ apiKey: env.WORLDLAB_API_KEY || env.WORLDLABS_API_KEY, worldsDir: fileURLToPath(new URL("./public/worlds", import.meta.url)) }),
      viewsApi({ geminiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, openaiKey: env.OPENAI_API_KEY, prefer: env.VIEW_PROVIDER }),
      // The voice historian's realtime session minting.
      realtimeSessionEndpoint(openAIKey, env.OPENAI_REALTIME_MODEL),
    ],
    resolve: {
      alias,
    },
    // Spark ships a Wasm blob + worker inline; keep it out of the dep optimizer.
    optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  };
});

function realtimeSessionEndpoint(apiKey: string | undefined, configuredModel: string | undefined): Plugin {
  const model = configuredModel || "gpt-realtime-2.1";
  const install = (middlewares: Connect.Server) => {
    middlewares.use("/api/realtime/narration", createNarrationHandler({ apiKey }));
    middlewares.use("/api/realtime/session", async (req, res, next) => {
      if (req.method !== "POST") return next();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (!apiKey) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "OPENAI_API_KEY is not configured on the server" }));
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!res.writableEnded) abort(); };
      req.once("aborted", abort);
      res.once("close", close);
      try {
        const response = await fetchWithRetry(fetch, "https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            session: {
              type: "realtime",
              model,
              output_modalities: ["text"],
              audio: {
                input: {
                  transcription: { model: "gpt-4o-mini-transcribe" },
                  turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
                },
                output: { voice: "marin" },
              },
            },
          }),
        }, { attempts: 3, attemptTimeoutMs: 15_000 });
        const body = await response.text();
        if (controller.signal.aborted) return;
        res.statusCode = response.status;
        res.end(response.ok ? body : JSON.stringify({ error: "OpenAI session creation failed", status: response.status }));
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("[realtime] session creation failed", error instanceof Error ? error.message : error);
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "Unable to reach OpenAI after several attempts. Please try again." }));
      } finally {
        req.off("aborted", abort);
        res.off("close", close);
      }
    });
  };
  return {
    name: "walk-the-past-realtime-session",
    configureServer: (server) => install(server.middlewares),
    configurePreviewServer: (server) => install(server.middlewares),
  };
}

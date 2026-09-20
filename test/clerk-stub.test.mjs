/**
 * The Clerk stub has to keep up with what the app imports.
 *
 * vite.config.ts aliases @clerk/react to src/shims/clerk-stub.tsx when
 * VITE_CLERK_PUBLISHABLE_KEY is absent. A developer with a key in .env.local never loads
 * that file, so importing a new Clerk component builds fine for them and then fails at
 * bundling wherever the key is missing — which is how a green local build reached CI
 * broken. This compares the two lists directly.
 *
 * It reads the sources rather than importing them: node's type stripping does not handle
 * the JSX in the stub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const stub = readFileSync(new URL("../src/shims/clerk-stub.tsx", import.meta.url), "utf8");

/** Names imported from @clerk/react anywhere in a source file. */
function clerkImports(source) {
  const names = new Set();
  for (const m of source.matchAll(/import\s+\{([^}]*)\}\s+from\s+["']@clerk\/react["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Names the stub exports, whether declared as a function or bound to a const. */
function stubExports(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

test("the keyless Clerk stub exports everything App.tsx imports", () => {
  const wanted = clerkImports(app);
  assert.ok(wanted.size > 0, "expected App.tsx to import from @clerk/react");
  const provided = stubExports(stub);
  const missing = [...wanted].filter((name) => !provided.has(name));
  assert.deepEqual(
    missing,
    [],
    `src/shims/clerk-stub.tsx is missing ${missing.join(", ")}. A build without VITE_CLERK_PUBLISHABLE_KEY aliases @clerk/react to that file and will fail to bundle.`,
  );
});

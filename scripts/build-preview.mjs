// Builds public/scene.js: the pure frame renderer (the same code that draws the MP4) for the dashboard's animation preview.
// Run `npm run build:preview` after changing anything under src/animation/scene; a test fails if public/scene.js is stale.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleScene() {
  const result = await build({
    entryPoints: [path.join(root, "src/animation/scene/preview-entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild produced no output for the preview bundle.");
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { writeFile } = await import("node:fs/promises");
  const code = await bundleScene();
  await writeFile(path.join(root, "public/scene.js"), code);
  console.log(`public/scene.js written (${(code.length / 1024).toFixed(0)} KB)`);
}

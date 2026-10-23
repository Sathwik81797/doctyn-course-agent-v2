# npm audit review (V2)

`npm audit` reports **11 vulnerabilities (5 high, 6 moderate)**, all in production dependencies.
**Nothing has been applied** to `package.json` or `package-lock.json` for these. `npm audit fix --force` is not used.

## Why `npm audit fix --force` is wrong here

It proposes `pptxgenjs@4.0.0` and `mammoth@0.3.29`. Both are *downgrades* to older majors, and the
`mammoth` one would not even remove the advisory. Do not run it.

## The 11 findings collapse into 4 root causes

| Root cause | Pulls in | Used by | Reachable in this app? |
|---|---|---|---|
| `image-size` 0.6.3–2.0.2 (DoS in JXL/HEIF/ICNS parsers) | `pptxgenjs` | only the `test-services` smoke test builds a text-only deck | No: no images are ever parsed |
| `sharp` ≤0.35.5-rc.1 (libvips/libheif/librsvg CVEs) | nested copy `@huggingface/transformers/node_modules/sharp@0.34.5` → `kokoro-js` | Kokoro TTS (text → audio only) | No image decoding happens in TTS. Top-level `sharp@0.35.5` is already patched |
| `onnxruntime-node` 1.21.0 → `global-agent` → `roarr` → `sprintf-js` | `@huggingface/transformers` pins `onnxruntime-node@1.21.0` exactly | Kokoro TTS | Format-string DoS in a logging helper; not reachable with our inputs |
| `sprintf-js` (unbounded precision DoS) | `argparse@1.x` → `mammoth` | DOCX parsing | `argparse` is only used by mammoth's CLI, not its library API |

## Verified compatible fixes (proposed, not applied)

Tested in a scratch copy (`package.json` + lockfile only, `npm install --package-lock-only`, then `npm audit`):

```jsonc
// package.json
"overrides": {
  "sharp": "$sharp",                         // forces the nested sharp to the top-level 0.35.5
  "onnxruntime-node": "1.30.0",              // drops global-agent/roarr/sprintf-js from this branch
  "pptxgenjs": { "image-size": "^2.0.4" }    // 2.0.4 is outside the vulnerable range
}
```

Result in the scratch copy: **11 → 3 moderate** (`sprintf-js` ← `argparse` ← `mammoth`), and all 5 high-severity items gone.

The remaining 3 have **no fix available upstream** (`mammoth@1.13.0` is the latest and still depends on `argparse@1.x`).
Recommended: accept with the reachability note above, and re-check when mammoth releases.
Alternative if zero findings is required: replace mammoth for DOCX text extraction (for example parsing `word/document.xml` with JSZip, which is already a dependency).

### Not verified: runtime behaviour after the overrides

Lockfile resolution and `npm audit` were checked. These were **not** run against the overrides:

1. `onnxruntime-node` 1.21 → 1.30 under `@huggingface/transformers@3.8.1` — run one `npm run preview-tts -- --slides 1` with `TTS_PROVIDER=kokoro` before and after.
2. `sharp` 0.34 → 0.35 inside transformers — only matters for image features, which Kokoro does not use.
3. `image-size` 2.x with `pptxgenjs` — `npm run test-services` exercises the smoke test.

Suggested procedure: apply the overrides on a branch, `npm install`, then `npm run typecheck && npm test && npm run test-services`, and one Kokoro preview. Revert if any step fails.

### Not recommended

`npm update @huggingface/transformers` to 4.x: `kokoro-js@1.2.1` requires `^3.5.1`, so npm would install both and the vulnerable 3.x would remain for Kokoro.

## Change made to dependencies in this session

`esbuild@~0.28.0` was added as a devDependency. It was already installed through `tsx`; the studio server uses it to bundle the browser script. `npm audit` count is unchanged (11).

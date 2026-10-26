/**
 * npm run library:check [-- --full]
 *
 * Live, read-only check of library mode against the REAL private Vercel Blob store (token from .env.local / .env).
 * It starts the library endpoint in-process with a throw-away invited user, then verifies through HTTP:
 *   sign-in is required, the catalog lists the 52-slide enhanced DRAFT, HEAD/Range/download work, no token or
 *   blob URL is ever sent to the client, and (with --full) the streamed bytes equal the local MP4 exactly.
 * Nothing is uploaded or changed.
 */
import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { hashPassword } from "../cloud/auth.js";
import { createLibraryHandler, libraryConfig, vercelBlobReader } from "../cloud/library.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";
import { PROJECT_ROOT } from "./utils/config.js";

loadEnv({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });
loadEnv({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN is not set in .env.local / .env (run `vercel env pull .env.local`).");
  process.exit(1);
}
const full = process.argv.includes("--full");
const email = "check@example.com";
const password = `check-${Date.now()}-password`;
const env = { BLOB_READ_WRITE_TOKEN: token, APP_SECRET: "c".repeat(48), LIBRARY_USERS: `${email}=${await hashPassword(password)}` };
const cfg = libraryConfig(env);
const handle = createLibraryHandler({ config: cfg, readBlob: vercelBlobReader(cfg.blobToken) });
const server = http.createServer((req, res) => void handle(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let failed = 0;
const check = (cond: unknown, what: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};
const H = { "x-requested-with": "doctyn" };
const video = LIBRARY_VIDEOS[0]!;
const file = `${base}/api/v3/courses/${video.id}/files/animated`;
const leaks = (text: string) => text.includes(token) || /blob\.vercel-storage\.com/i.test(text);

try {
  console.log("Library mode against the real private Blob store");
  const anon = await fetch(file, { headers: H });
  const anonBody = await anon.text();
  check(anon.status === 401 && !anonBody.includes("ftyp"), "no video without signing in (401)");
  check((await fetch(`${base}/api/v3/courses`, { headers: H })).status === 401, "catalog needs sign-in too");

  const bad = await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong password!" }) });
  check(bad.status === 401, "wrong password rejected");
  const login = await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  check(login.status === 200 && cookie.startsWith("doctyn_session="), "invited user signs in");
  check(/HttpOnly/i.test(login.headers.get("set-cookie") ?? ""), "session cookie is HttpOnly");
  const auth = { ...H, cookie };

  const list = (await (await fetch(`${base}/api/v3/courses`, { headers: auth })).json()) as { courses: any[] };
  const c = list.courses[0];
  check(list.courses.length === 1 && c.slideCount === 52 && Math.round(c.durationSeconds) === 915, "catalog: 52 slides, 15:15");
  check(c.animatedDraft === true && c.available.animated === true, "registered as an enhanced DRAFT");

  const head = await fetch(file, { method: "HEAD", headers: auth });
  check(head.status === 200 && Number(head.headers.get("content-length")) === 82287474, `HEAD reports the real size (${head.headers.get("content-length")} bytes)`);
  check(head.headers.get("cache-control")?.includes("no-store") && head.headers.get("cache-control")?.includes("private"), "responses are private, not cacheable");

  const r1 = await fetch(file, { headers: { ...auth, range: "bytes=0-1023" } });
  const b1 = Buffer.from(await r1.arrayBuffer());
  check(r1.status === 206 && b1.length === 1024 && b1.subarray(4, 8).toString() === "ftyp", "Range 0-1023 -> 206 with a real MP4 header");
  check(r1.headers.get("content-range") === "bytes 0-1023/82287474", "Content-Range is correct");
  const r2 = await fetch(file, { headers: { ...auth, range: "bytes=41000000-41000999" } });
  check(r2.status === 206 && (await r2.arrayBuffer()).byteLength === 1000, "seeking into the middle works");
  const r3 = await fetch(file, { headers: { ...auth, range: "bytes=999999999-" } });
  check(r3.status === 416, "range past the end -> 416");
  const dl = await fetch(file + "?download=1", { headers: { ...auth, range: "bytes=0-9" } });
  check(/attachment; filename=".*DRAFT.*animated-video\.mp4"/.test(dl.headers.get("content-disposition") ?? ""), "download is named as a DRAFT attachment");

  const allText = JSON.stringify([...login.headers, ...head.headers, ...r1.headers, ...dl.headers]) + JSON.stringify(list);
  check(!leaks(allText), "no Blob token or blob URL appears in any response header or JSON");

  if (full) {
    console.log("  streaming the whole file and comparing it with the local MP4 …");
    const res = await fetch(file, { headers: auth });
    const remote = createHash("sha256");
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      remote.update(chunk);
      bytes += chunk.length;
    }
    const local = createHash("sha256");
    const localFile = path.join(PROJECT_ROOT, "output", "risk-factors-for-diabetes-from-genetics-to-lifestyle", "animation", "enhanced", "animated-video.enhanced.draft.mp4");
    if (await fs.stat(localFile).then(() => true, () => false)) {
      for await (const chunk of createReadStream(localFile)) local.update(chunk);
      check(bytes === 82287474 && remote.digest("hex") === local.digest("hex"), `full stream (${bytes} bytes) is identical to the local file`);
    } else {
      check(bytes === 82287474, `full stream delivered ${bytes} bytes (local copy not found to compare)`);
    }
  }
  console.log(failed ? `\nLIBRARY CHECK FAIL (${failed})` : "\nLIBRARY CHECK PASS");
} finally {
  server.close();
}
process.exitCode = failed ? 1 : 0;

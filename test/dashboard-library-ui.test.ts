import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { hashPassword } from "../cloud/auth.js";
import { createLibraryHandler, libraryConfig } from "../cloud/library.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";

/** The real public/app.js in a simulated browser, talking to the real library-mode API (private Blob video library). */
let server: http.Server;
let base = "";
let bundle = "";
let html = "";
const jars: string[] = [];
const requested: string[] = [];

const until = async (fn: () => unknown, what: string, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};

function open(cookie = "") {
  const dom = new JSDOM(html, { url: `${base}/`, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as any;
  win.fetch = async (input: string, init: RequestInit = {}) => {
    requested.push(String(input));
    const res = await fetch(new URL(input, base), { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get("set-cookie");
    if (set) jars.push(set.split(";")[0]!);
    return res;
  };
  win.confirm = () => true;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  win.HTMLMediaElement.prototype.load = () => {};
  win.HTMLMediaElement.prototype.pause = () => {};
  win.eval(bundle);
  return { dom, win, doc: win.document as Document };
}

before(async () => {
  const users = `doc@example.com=${await hashPassword("correct horse battery")}`;
  const config = libraryConfig({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_X_y", APP_SECRET: "u".repeat(48), LIBRARY_USERS: users });
  const handle = createLibraryHandler({ config, readBlob: async () => null });
  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  html = (await fs.readFile(path.resolve("public/index.html"), "utf8")).replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, "");
  bundle = (await build({ entryPoints: [path.resolve("public/app.js")], bundle: true, format: "iife", write: false })).outputFiles[0]!.text;
});
after(() => server.close());

describe("dashboard in private video-library mode", () => {
  it("asks for sign-in first, by invitation only, and shows no video", async () => {
    const { doc, win } = open();
    await until(() => !(doc.getElementById("auth-gate") as HTMLElement).hidden, "sign-in card");
    const gate = doc.getElementById("auth-gate")!;
    assert.match(gate.textContent ?? "", /Access is by invitation/);
    assert.ok(!/Create an account/.test(gate.textContent ?? ""), "no self-registration");
    assert.equal((doc.getElementById("app-main") as HTMLElement).hidden, true, "the library is hidden until sign-in");
    assert.equal(doc.querySelectorAll(".video-card").length, 0);

    // sign in through the form; the page then reloads (not implemented in jsdom), so check the cookie it received
    (gate.querySelector("input[type=email]") as HTMLInputElement).value = "doc@example.com";
    (gate.querySelector("input[type=password]") as HTMLInputElement).value = "correct horse battery";
    (gate.querySelector("form") as HTMLFormElement).dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => jars.some((c) => c.startsWith("doctyn_session=")), "session cookie after sign-in");
    win.close();
  });

  it("then shows the 52-slide enhanced draft in Generated Videos with Play and Download", async () => {
    const cookie = jars.find((c) => c.startsWith("doctyn_session="))!;
    const { doc, win } = open(cookie);
    await until(() => doc.querySelectorAll("#videos .video-card").length === 1, "the library video card");
    const card = doc.querySelector("#videos .video-card") as HTMLElement;
    const text = card.textContent ?? "";
    assert.match(text, /Risk Factors for Diabetes – From Genetics to Lifestyle/);
    assert.match(text, /52 slides/);
    assert.match(text, /15m 15s/);
    assert.match(text, /Draft/);
    assert.deepEqual([...card.querySelectorAll(".version-chips .badge")].map((b) => b.textContent), ["Enhanced animated draft"]);
    const labels = [...card.querySelectorAll("button, a")].map((b) => b.textContent?.trim());
    assert.ok(labels.includes("Play"));
    assert.ok(labels.includes("↓ Download MP4"));
    assert.ok(!labels.includes("Edit Again"), "nothing to edit in a library-only entry");
    const id = LIBRARY_VIDEOS[0]!.id;
    assert.equal((card.querySelector("a[href*='files%2Fanimated']") as HTMLAnchorElement).getAttribute("href"), `/api/v3/route?p=courses%2F${id}%2Ffiles%2Fanimated&download=1`);

    // library mode is explained, not hidden: no engine, uploads disabled
    assert.equal((doc.getElementById("offline-banner") as HTMLElement).hidden, false);
    assert.match(doc.getElementById("banner-title")!.textContent ?? "", /Video library mode/);
    assert.equal((doc.getElementById("upload-btn") as HTMLButtonElement).disabled, true);
    assert.match(doc.getElementById("upload-notice")!.textContent ?? "", /not enabled on this site yet/);
    assert.equal((doc.getElementById("generate-btn") as HTMLButtonElement).disabled, true);

    // Play opens the embedded player on the protected endpoint
    [...card.querySelectorAll("button")].find((b) => b.textContent === "Play")!.click();
    assert.ok(doc.getElementById("player")!.hasAttribute("open"));
    assert.equal(doc.getElementById("player-video")!.getAttribute("src"), `/api/v3/route?p=courses%2F${id}%2Ffiles%2Fanimated`);
    assert.match(doc.getElementById("player-title")!.textContent ?? "", /Enhanced animated draft/);
    assert.match(doc.getElementById("player-meta")!.textContent ?? "", /DRAFT: not clinically approved — private to your account/);
    win.close();
  });

  it("only ever uses API paths the Vercel deployment routes (single segment) — the production bug", () => {
    assert.ok(requested.length >= 6, `requests were made (${requested.length})`);
    assert.deepEqual(requested.filter((u) => /^\/api\/v3\/[^/?#]+\//.test(u)), []);
    assert.ok(requested.some((u) => u.startsWith("/api/v3/route?p=auth%2Fme")), "session check goes through /route");
    assert.ok(requested.some((u) => u.startsWith("/api/v3/route?p=auth%2Flogin")), "sign-in goes through /route");
  });
});

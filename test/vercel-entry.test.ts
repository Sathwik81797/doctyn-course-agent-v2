import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { hashPassword } from "../cloud/auth.js";

/**
 * The real Vercel function file (api/v3/[...path].js), configured the way production is: BLOB_READ_WRITE_TOKEN +
 * APP_SECRET + LIBRARY_USERS and no DATABASE_URL. Requests use the single-segment form the dashboard sends, because
 * that is the only path shape the deployment routes (live: /api/v3/health works, /api/v3/auth/me is a platform 404).
 */
const TOKEN = "vercel_blob_rw_FAKESTORE_notarealtokenvalue000000000000000000";
let server: http.Server;
let base = "";
const H = { "x-requested-with": "doctyn" };
const R = (p: string, extra = "") => `${base}/api/v3/route?p=${encodeURIComponent(p)}${extra}`;

before(async () => {
  delete process.env.DATABASE_URL;
  process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
  process.env.APP_SECRET = "v".repeat(48);
  process.env.LIBRARY_USERS = `doc@example.com=${await hashPassword("correct horse battery")}`;
  process.env.VERCEL = "1"; // production flags: secure cookies etc.
  const mod = (await import("../api/v3/[...path].js")) as { default: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown> };
  // Mimic the Vercel Node runtime: it reads the request body itself and hands the function a parsed req.body with an
  // already-consumed stream (verified with `vercel dev`). A handler that reads only the stream sees an empty body.
  server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text && /json/.test(req.headers["content-type"] ?? "")) (req as unknown as { body: unknown }).body = JSON.parse(text);
      else (req as unknown as { body: unknown }).body = text || undefined;
      await mod.default(req, res);
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

describe("production function entry in library mode", () => {
  it("answers the health check as library mode", async () => {
    const body = (await (await fetch(`${base}/api/v3/health`, { headers: H })).json()) as Record<string, unknown>;
    assert.deepEqual(body, { ok: true, service: "doctyn-library", mode: "library", storage: "vercel-blob" });
  });

  it("serves what the dashboard asks for on load, through single-segment URLs", async () => {
    const meta = (await (await fetch(R("meta"), { headers: H })).json()) as Record<string, unknown>;
    assert.equal(meta.libraryMode, true);
    assert.equal(meta.registration, "closed");
    const me = await fetch(R("auth/me"), { headers: H });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { user: unknown }).user, null);
  });

  it("signs in (secure cookie), lists the 52-slide enhanced draft and keeps it behind the session", async () => {
    assert.equal((await fetch(R("courses"), { headers: H })).status, 401);
    const bad = await fetch(R("auth/login"), { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "doc@example.com", password: "nope nope nope" }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(R("auth/login"), { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "doc@example.com", password: "correct horse battery" }) });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/, "production cookies are Secure");
    const cookie = setCookie.split(";")[0]!;
    const { courses } = (await (await fetch(R("courses"), { headers: { ...H, cookie } })).json()) as { courses: Array<Record<string, any>> };
    assert.equal(courses.length, 1);
    assert.equal(courses[0]!.slideCount, 52);
    assert.equal(courses[0]!.animatedDraft, true);
    assert.equal(courses[0]!.publishedAt, null);
    assert.equal(Math.floor(courses[0]!.durationSeconds / 60), 15);
  });

  it("protects the video: 401 without a session, and an unreadable store never leaks the token", async () => {
    const id = "diabetes-enhanced-draft";
    const anon = await fetch(R(`courses/${id}/files/animated`), { headers: H });
    assert.equal(anon.status, 401);
    assert.ok(!(await anon.text()).includes("ftyp"));
    const login = await fetch(R("auth/login"), { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "doc@example.com", password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    // The token here is fake, so the real Blob service refuses it: the failure must be generic and token-free.
    const res = await fetch(R(`courses/${id}/files/animated`), { headers: { ...H, cookie, range: "bytes=0-9" } });
    const text = await res.text();
    assert.ok(res.status >= 400, `store refusal surfaces as an error (${res.status})`);
    assert.ok(!text.includes(TOKEN) && !text.includes("FAKESTORE") && !/blob\.vercel-storage\.com/i.test(text));
  });
});

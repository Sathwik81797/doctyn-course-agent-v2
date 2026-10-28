import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { hashPassword } from "../cloud/auth.js";
import {
  createLibraryHandler, libraryConfig, libraryModeConfigured, libraryProblems, parseLibraryUsers, signSession, verifySession, type LibraryContext,
} from "../cloud/library.js";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";

const SECRET = "s".repeat(48);
const TOKEN = "vercel_blob_rw_STORE123_supersecrettokenvalue";
const PATHNAME = "courses/diabetes/enhanced/animated-video.enhanced.draft.mp4";
const DATA = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(5000, 7)]);

let server: http.Server;
let base = "";
let users = "";
const reads: Array<{ pathname: string; range?: string | undefined }> = [];
let exists = true;

const H = { "x-requested-with": "doctyn" };
async function login(email = "doc@example.com", password = "correct horse battery") {
  const res = await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { res, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

before(async () => {
  users = `doc@example.com=${await hashPassword("correct horse battery")},other@example.com=${await hashPassword("another long password")}`;
  const config = libraryConfig({ BLOB_READ_WRITE_TOKEN: TOKEN, APP_SECRET: SECRET, LIBRARY_USERS: users });
  // A stand-in for the private Blob store with the same Range behaviour (the real store is checked by npm run library:check).
  const readBlob: LibraryContext["readBlob"] = async (pathname, { range }) => {
    reads.push({ pathname, range });
    if (!exists || pathname !== PATHNAME) return null;
    let body = DATA;
    const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes" });
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const start = m[1] === "" ? DATA.length - Number(m[2]) : Number(m[1]);
      const end = m[2] === "" || m[1] === "" ? DATA.length - 1 : Math.min(Number(m[2]), DATA.length - 1);
      if (start >= DATA.length) throw Object.assign(new Error("range"), { status: 416 });
      body = DATA.subarray(start, end + 1);
      headers.set("content-range", `bytes ${start}-${end}/${DATA.length}`);
    }
    headers.set("content-length", String(body.length));
    return { headers, stream: new Blob([new Uint8Array(body)]).stream() as ReadableStream<Uint8Array> };
  };
  const handle = createLibraryHandler({ config, readBlob: async (p, o) => { try { return await readBlob(p, o); } catch (e) { if ((e as { status?: number }).status === 416) { const { HttpError } = await import("../cloud/auth.js"); throw new HttpError(416, "That byte range is outside the video."); } throw e; } } });
  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

describe("migration helper: live sign-in check", () => {
  it("accepts the live password, rejects a wrong one, and never echoes either", async () => {
    const { checkLiveLogin } = await import("../src/migration/targets.js");
    const good = await checkLiveLogin(base, "doc@example.com", "correct horse battery");
    assert.equal(good.level, "info");
    const bad = await checkLiveLogin(base, "doc@example.com", "wrong password here");
    assert.equal(bad.level, "error");
    for (const f of [good, bad]) assert.ok(!/correct horse|wrong password here/.test(f.text));
    assert.equal((await checkLiveLogin("http://127.0.0.1:1", "doc@example.com", "x")).level, "error");
  });
});

describe("library configuration", () => {
  it("is used only when configured and no database is configured", () => {
    const ok = { BLOB_READ_WRITE_TOKEN: TOKEN, APP_SECRET: SECRET, LIBRARY_USERS: users };
    assert.equal(libraryModeConfigured(ok), true);
    assert.equal(libraryModeConfigured({ ...ok, DATABASE_URL: "postgres://x" }), false, "a full deployment takes precedence");
    assert.equal(libraryModeConfigured({ ...ok, BLOB_READ_WRITE_TOKEN: "" }), false);
    assert.equal(libraryModeConfigured({ ...ok, LIBRARY_USERS: "" }), false);
    assert.equal(libraryModeConfigured({ ...ok, APP_SECRET: "short" }), false);
    assert.equal(libraryProblems({}).length, 3);
  });

  it("parses invited users and ignores anything that is not a scrypt hash", () => {
    const parsed = parseLibraryUsers("A@x.org=scrypt$a$b, bad=plaintext\nb@y.org=scrypt$c$d,=scrypt$e$f");
    assert.deepEqual([...parsed.keys()], ["a@x.org", "b@y.org"]);
  });

  it("registers the diabetes video as a 52-slide, 15:15 enhanced draft", () => {
    const v = LIBRARY_VIDEOS[0]!;
    assert.equal(v.slideCount, 52);
    assert.equal(Math.floor(v.durationSeconds / 60), 15);
    assert.equal(Math.round(v.durationSeconds % 60), 15);
    assert.equal(v.files.animated?.pathname, PATHNAME);
    assert.equal(v.files.animated?.draft, true);
    assert.ok(!JSON.stringify(LIBRARY_VIDEOS).includes("http"), "the catalog holds pathnames only, never URLs");
  });
});

describe("sessions", () => {
  it("accepts a fresh signed session and rejects tampered, expired and foreign ones", () => {
    const t = signSession("doc@example.com", SECRET, 1);
    assert.equal(verifySession(t, SECRET), "doc@example.com");
    assert.equal(verifySession(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), SECRET), null);
    assert.equal(verifySession(t, "z".repeat(48)), null, "signed with a different secret");
    assert.equal(verifySession(t, SECRET, Date.now() + 2 * 86400_000), null, "expired");
    assert.equal(verifySession(null, SECRET), null);
    assert.equal(verifySession("garbage", SECRET), null);
  });
});

describe("authentication", () => {
  it("refuses everything without a session and never touches the blob store", async () => {
    reads.length = 0;
    for (const p of ["/courses", `/courses/${LIBRARY_VIDEOS[0]!.id}`, `/courses/${LIBRARY_VIDEOS[0]!.id}/files/animated`, "/engine", "/activity"]) {
      assert.equal((await fetch(`${base}/api/v3${p}`, { headers: H })).status, 401, p);
    }
    assert.equal(reads.length, 0);
    assert.equal((await (await fetch(`${base}/api/v3/auth/me`, { headers: H })).json() as { user: unknown }).user, null);
  });

  it("signs invited users in with an HttpOnly cookie and rejects wrong or unknown credentials", async () => {
    const ok = await login();
    assert.equal(ok.res.status, 200);
    const setCookie = ok.res.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal((await login("doc@example.com", "wrong wrong wrong")).res.status, 401);
    assert.equal((await login("stranger@example.com", "anything at all")).res.status, 401);
    const me = (await (await fetch(`${base}/api/v3/auth/me`, { headers: { ...H, cookie: ok.cookie } })).json()) as { user: { email: string } };
    assert.equal(me.user.email, "doc@example.com");
  });

  it("does not allow registration, uploads or other writes", async () => {
    const { cookie } = await login();
    const reg = await fetch(`${base}/api/v3/auth/register`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.org", name: "X", password: "long enough password" }) });
    assert.equal(reg.status, 403);
    const up = await fetch(`${base}/api/v3/courses`, { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    assert.equal(up.status, 501);
    assert.match(((await up.json()) as { error: string }).error, /library mode/);
  });

  it("blocks cross-site and header-less writes", async () => {
    assert.equal((await fetch(`${base}/api/v3/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/v3/auth/logout`, { method: "POST", headers: { ...H, origin: "https://evil.example" } })).status, 403);
  });

  it("ends access when a user is removed from LIBRARY_USERS, even with a valid cookie", async () => {
    const config = libraryConfig({ BLOB_READ_WRITE_TOKEN: TOKEN, APP_SECRET: SECRET, LIBRARY_USERS: `only@example.com=${await hashPassword("only one long password")}` });
    const handle = createLibraryHandler({ config, readBlob: async () => null });
    const s = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const forged = `doctyn_session=${encodeURIComponent(signSession("doc@example.com", SECRET, 1))}`; // valid signature, but not on the list
    assert.equal((await fetch(`${b}/api/v3/courses`, { headers: { ...H, cookie: forged } })).status, 401);
    s.close();
  });

  it("throttles repeated wrong passwords", async () => {
    const config = libraryConfig({ BLOB_READ_WRITE_TOKEN: TOKEN, APP_SECRET: SECRET, LIBRARY_USERS: users });
    const handle = createLibraryHandler({ config, readBlob: async () => null });
    const s = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await fetch(`${b}/api/v3/auth/login`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "doc@example.com", password: `wrong password ${i}` }) })).status);
    }
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
    assert.equal(codes[9], 429);
    s.close();
  });
});

describe("catalog and protected streaming", () => {
  let cookie = "";
  const url = (name = "animated") => `${base}/api/v3/courses/${LIBRARY_VIDEOS[0]!.id}/files/${name}`;
  before(async () => { cookie = (await login()).cookie; });

  it("lists the enhanced draft the way the dashboard expects", async () => {
    const { courses } = (await (await fetch(`${base}/api/v3/courses`, { headers: { ...H, cookie } })).json()) as { courses: any[] };
    assert.equal(courses.length, 1);
    const c = courses[0];
    assert.equal(c.slideCount, 52);
    assert.equal(c.status, "complete");
    assert.equal(c.animatedDraft, true);
    assert.equal(c.available.animated, true);
    assert.equal(c.available.video, false, "only the enhanced version is registered");
    assert.equal(c.publishedAt, null, "a draft is never shown as published");
    assert.equal(c.libraryOnly, true);
    const detail = (await (await fetch(`${base}/api/v3/courses/${c.id}`, { headers: { ...H, cookie } })).json()) as { course: any };
    assert.deepEqual(detail.course.slides, []);
  });

  it("streams the full video with the right headers and exact bytes", async () => {
    const res = await fetch(url(), { headers: { ...H, cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.match(res.headers.get("cache-control") ?? "", /private/);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(res.headers.get("x-doctyn-status"), "draft");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), DATA);
  });

  it("supports seeking (Range), HEAD and download", async () => {
    const part = await fetch(url(), { headers: { ...H, cookie, range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${DATA.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), DATA.subarray(100, 200));
    const open = await fetch(url(), { headers: { ...H, cookie, range: "bytes=4900-" } });
    assert.equal(open.status, 206);
    assert.equal((await open.arrayBuffer()).byteLength, DATA.length - 4900);
    const head = await fetch(url(), { method: "HEAD", headers: { ...H, cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(DATA.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const dl = await fetch(url() + "?download=1", { headers: { ...H, cookie } });
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename=".*DRAFT-animated-video\.mp4"$/);
    await dl.arrayBuffer();
  });

  it("rejects bad or out-of-range requests", async () => {
    assert.equal((await fetch(url(), { headers: { ...H, cookie, range: "bytes=0-1,5-9" } })).status, 416);
    assert.equal((await fetch(url(), { headers: { ...H, cookie, range: "bytes=999999-" } })).status, 416);
    assert.equal((await fetch(url("video"), { headers: { ...H, cookie } })).status, 404, "files that are not registered do not exist");
    assert.equal((await fetch(`${base}/api/v3/courses/nope/files/animated`, { headers: { ...H, cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/v3/courses/${LIBRARY_VIDEOS[0]!.id}/files/..%2F..%2Fsecret`, { headers: { ...H, cookie } })).status, 404);
  });

  it("only ever asks the store for the catalogued pathname", async () => {
    reads.length = 0;
    await (await fetch(url() + "?pathname=other/file.mp4&url=https://evil.example/x", { headers: { ...H, cookie } })).arrayBuffer();
    assert.deepEqual(reads.map((r) => r.pathname), [PATHNAME]);
  });

  it("never reveals the Blob token or a blob URL, in success or error responses", async () => {
    const seen: string[] = [];
    for (const p of [url(), url("video"), `${base}/api/v3/courses`, `${base}/api/v3/health`, `${base}/api/v3/courses/${LIBRARY_VIDEOS[0]!.id}`]) {
      const r = await fetch(p, { headers: { ...H, cookie, range: "bytes=0-9" } });
      seen.push(JSON.stringify([...r.headers]), p.includes("files/animated") ? "" : await r.text());
      if (p.includes("files/animated")) await r.arrayBuffer();
    }
    exists = false;
    const missing = await fetch(url(), { headers: { ...H, cookie } });
    seen.push(await missing.text());
    assert.equal(missing.status, 404);
    exists = true;
    const text = seen.join("\n");
    assert.ok(!text.includes(TOKEN) && !text.includes("supersecrettokenvalue"));
    assert.ok(!/blob\.vercel-storage\.com/i.test(text));
  });
});

describe("single-segment route form (what the dashboard sends in production)", () => {
  const R = (p: string, extra = "") => `${base}/api/v3/route?p=${encodeURIComponent(p)}${extra}`;

  it("signs in, checks the session and lists the catalog", async () => {
    assert.equal(((await (await fetch(R("auth/me"), { headers: H })).json()) as { user: unknown }).user, null);
    const res = await fetch(R("auth/login"), { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ email: "doc@example.com", password: "correct horse battery" }) });
    assert.equal(res.status, 200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const me = (await (await fetch(R("auth/me"), { headers: { ...H, cookie } })).json()) as { user: { email: string } };
    assert.equal(me.user.email, "doc@example.com");
    const list = (await (await fetch(R("courses"), { headers: { ...H, cookie } })).json()) as { courses: Array<{ title: string; slideCount: number }> };
    assert.equal(list.courses[0]!.slideCount, 52);
    assert.equal((await fetch(R("courses"), { headers: H })).status, 401, "still protected");
  });

  it("streams, seeks and downloads through the route form, and keeps other query parameters", async () => {
    const { cookie } = await login();
    const id = LIBRARY_VIDEOS[0]!.id;
    const full = await fetch(R(`courses/${id}/files/animated`), { headers: { ...H, cookie } });
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), DATA);
    const part = await fetch(R(`courses/${id}/files/animated`), { headers: { ...H, cookie, range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), DATA.subarray(10, 20));
    const dl = await fetch(R(`courses/${id}/files/animated`, "&download=1"), { headers: { ...H, cookie } });
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment; filename=".*DRAFT-animated-video\.mp4"/);
    await dl.arrayBuffer();
    assert.equal((await fetch(R(`courses/${id}/files/video`), { headers: { ...H, cookie } })).status, 404);
    assert.equal((await fetch(R(""), { headers: { ...H, cookie } })).status, 404, "an empty route is just an unknown route");
  });
});

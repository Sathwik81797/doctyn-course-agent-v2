/**
 * An in-memory stand-in for the Vercel Blob service, faithful to what the live private store was observed to do
 * (presigned PUT to /api/blob/, presigned GET with ranges, 403 without a valid signature, size cap enforced, no token needed
 * for presigned URLs). Lets the adapter and the whole website flow be tested without the network or a real store.
 */
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { BlobSdk } from "../../cloud/storage-blob.js";

export interface FakeBlob {
  sdk: BlobSdk;
  token: string;
  origin: string;
  store: Map<string, { buf: Buffer; type: string }>;
  /** every SDK call made with the server token, by name */
  calls: string[];
  /** options passed to put(), in order */
  puts: Array<{ pathname: string; opts: any }>;
  /** make the next N calls of `name` throw this error */
  failNext(name: string, times: number, err: Error): void;
  close(): Promise<void>;
}

class NotFound extends Error {
  override name = "BlobNotFoundError";
}

export async function startFakeBlob(token = `fake_rw_${randomBytes(6).toString("hex")}`): Promise<FakeBlob> {
  const secret = randomBytes(16).toString("hex");
  const store = new Map<string, { buf: Buffer; type: string }>();
  const calls: string[] = [];
  const puts: FakeBlob["puts"] = [];
  const failures = new Map<string, { n: number; err: Error }>();
  const sign = (parts: string[]): string => createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const q = url.searchParams;
      const fail = (status: number, message: string): void => void res.writeHead(status, { "Access-Control-Allow-Origin": "*", "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
      if (req.method === "OPTIONS") return void res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT,OPTIONS", "Access-Control-Allow-Headers": "content-type" }).end();
      const deleg = q.get("vercel-blob-delegation") ?? "";
      let scope: { pathname: string; ops: string[]; validUntil: number; max?: number } | null = null;
      try {
        scope = JSON.parse(Buffer.from(deleg, "base64url").toString("utf8"));
      } catch {
        /* unsigned */
      }
      const isPut = req.method === "PUT" && url.pathname === "/api/blob/";
      const pathname = isPut ? q.get("pathname") ?? "" : decodeURIComponent(url.pathname.replace(/^\//, ""));
      const op = isPut ? "put" : req.method === "HEAD" ? "head" : "get";
      const max = q.get("vercel-blob-maximum-size-in-bytes");
      const expected = sign([deleg, op, pathname, String(scope?.validUntil), max ?? ""]);
      if (!scope || q.get("vercel-blob-signature") !== expected || scope.pathname !== pathname || !scope.ops.includes(op === "head" ? "get" : op)) return fail(403, "invalid signature");
      if (Date.now() > scope.validUntil) return fail(403, "the presigned url has expired");

      if (isPut) {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) {
          n += (c as Buffer).length;
          if (max && n > Number(max)) return fail(403, `the file length cannot be greater than ${max} bytes`);
          chunks.push(c as Buffer);
        }
        if (q.get("vercel-blob-allow-overwrite") !== "1" && store.has(pathname)) return fail(400, "This blob already exists");
        store.set(pathname, { buf: Buffer.concat(chunks), type: String(req.headers["content-type"] ?? "application/octet-stream") });
        return void res.writeHead(200, { "Access-Control-Allow-Origin": "*", "content-type": "application/json" }).end(JSON.stringify({ pathname, size: n }));
      }
      const obj = store.get(pathname);
      if (!obj) return fail(404, "not found");
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      let [start, end] = [0, obj.buf.length - 1];
      if (m && (m[1] || m[2])) {
        if (!m[1]) start = Math.max(0, obj.buf.length - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(end, Number(m[2]));
        }
      }
      const partial = Boolean(m);
      res.writeHead(partial ? 206 : 200, {
        "content-type": obj.type,
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        "Access-Control-Allow-Origin": "*",
        ...(partial ? { "content-range": `bytes ${start}-${end}/${obj.buf.length}` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : obj.buf.subarray(start, end + 1));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const guard = (name: string, o: { token?: string } | undefined): void => {
    if (o?.token !== token) throw Object.assign(new Error("No token found"), { name: "BlobError" });
    calls.push(name);
    const f = failures.get(name);
    if (f && f.n > 0) {
      f.n--;
      throw f.err;
    }
  };

  const sdk: BlobSdk = {
    async issueSignedToken(o) {
      guard("issueSignedToken", o);
      const validUntil = o.validUntil as number;
      const scope = { pathname: o.pathname, ops: o.operations, validUntil, ...(o.maximumSizeInBytes ? { max: o.maximumSizeInBytes } : {}) };
      return { delegationToken: Buffer.from(JSON.stringify(scope)).toString("base64url"), clientSigningToken: "unused", validUntil };
    },
    async presignUrl(st, o) {
      const params = new URLSearchParams({ "vercel-blob-delegation": st.delegationToken });
      const max = o.maximumSizeInBytes ? String(o.maximumSizeInBytes) : "";
      if (max) params.set("vercel-blob-maximum-size-in-bytes", max);
      if (o.operation === "put") params.set("vercel-blob-allow-overwrite", o.allowOverwrite ? "1" : "0");
      params.set("vercel-blob-signature", sign([st.delegationToken, o.operation, o.pathname, String(o.validUntil), max]));
      if (o.operation === "put") {
        params.set("pathname", o.pathname);
        return { presignedUrl: `${origin}/api/blob/?${params}` };
      }
      return { presignedUrl: `${origin}/${o.pathname.split("/").map(encodeURIComponent).join("/")}?${params}` };
    },
    async put(pathname, body, o) {
      guard("put", o);
      puts.push({ pathname, opts: o });
      const chunks: Buffer[] = [];
      for await (const c of Readable.from(body as AsyncIterable<Buffer>)) chunks.push(Buffer.from(c as Buffer));
      if (!o.allowOverwrite && store.has(pathname)) throw new Error("This blob already exists");
      store.set(pathname, { buf: Buffer.concat(chunks), type: o.contentType ?? "application/octet-stream" });
      return { pathname };
    },
    async get(pathname, o) {
      guard("get", o);
      const obj = store.get(pathname);
      if (!obj) return null;
      return { statusCode: 200, stream: Readable.toWeb(Readable.from([obj.buf])) as ReadableStream<Uint8Array>, headers: new Headers({ "content-length": String(obj.buf.length), "content-type": obj.type }) };
    },
    async head(pathname, o) {
      guard("head", o);
      const obj = store.get(pathname);
      if (!obj) throw new NotFound("The requested blob does not exist");
      return { size: obj.buf.length };
    },
    async list(o) {
      guard("list", o);
      const all = [...store.entries()].filter(([k]) => k.startsWith(o.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b));
      const from = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 1000;
      const page = all.slice(from, from + limit);
      return { blobs: page.map(([pathname, v]) => ({ pathname, size: v.buf.length })), hasMore: from + limit < all.length, ...(from + limit < all.length ? { cursor: String(from + limit) } : {}) };
    },
    async del(pathname, o) {
      guard("del", o);
      for (const p of Array.isArray(pathname) ? pathname : [pathname]) store.delete(p);
    },
  };

  return {
    sdk,
    token,
    origin,
    store,
    calls,
    puts,
    failNext: (name, times, err) => void failures.set(name, { n: times, err }),
    close: () => new Promise<void>((r) => void server.close(() => r())),
  };
}

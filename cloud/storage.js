// @ts-check
// Private object storage. Production uses any S3-compatible bucket (AWS S3, Cloudflare R2,
// Backblaze B2, MinIO...) with short-lived signed URLs; nothing is ever public.
// The "fs" driver exists for local development and tests only and is refused in production.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { HttpError } from "./auth.js";

/**
 * @typedef {Object} Storage
 * @property {"s3" | "fs"} driver
 * @property {(key: string, o: { contentType: string, size: number }) => Promise<string>} presignPut
 * @property {(key: string, o: { filename?: string, contentType?: string }) => Promise<string>} presignGet
 * @property {(key: string) => Promise<{ size: number } | null>} head
 * @property {(key: string, maxBytes: number) => Promise<Buffer>} readBuffer
 * @property {(key: string, file: string) => Promise<void>} downloadToFile
 * @property {(key: string, file: string, contentType: string) => Promise<number>} uploadFromFile
 * @property {(key: string) => Promise<void>} remove
 * @property {(prefix: string) => Promise<number>} removePrefix
 * @property {(prefix: string) => Promise<Array<{ key: string, size: number }>>} list
 * @property {(token: string, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>} [serveFs]
 */

/** Keys are built by the server from ids; this guards the fs driver and S3 against odd input anyway. @param {string} key */
function assertKey(key) {
  if (!key || key.length > 600 || key.startsWith("/") || key.split("/").some((s) => s === ".." || s === "." || s === "") || /[\\\0]/.test(key)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

/** @param {import("./config.js").CloudConfig} config @returns {Promise<Storage>} */
export async function createStorage(config) {
  if (config.storageDriver === "fs") {
    if (config.production) throw new Error("STORAGE_DRIVER=fs is for local development only.");
    return createFsStorage(config);
  }
  return createS3Storage(config);
}

/** @param {import("./config.js").CloudConfig} config @returns {Promise<Storage>} */
async function createS3Storage(config) {
  const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } =
    await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const { bucket, accessKeyId, secretAccessKey } = config.s3;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Object storage is not configured: set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (and S3_ENDPOINT for R2/B2/MinIO).");
  }
  const client = new S3Client({
    region: config.s3.region,
    ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
  const expiresIn = config.signedUrlSeconds;
  /** @param {string} prefix */
  const list = async (prefix) => {
    /** @type {Array<{ key: string, size: number }>} */
    const out = [];
    /** @type {string | undefined} */
    let token;
    do {
      /** @type {import("@aws-sdk/client-s3").ListObjectsV2CommandOutput} */
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  };
  return {
    driver: "s3",
    list,
    async presignPut(key, o) {
      assertKey(key);
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: o.contentType, ContentLength: o.size }), {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      });
    },
    async presignGet(key, o) {
      assertKey(key);
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(o.filename ? { ResponseContentDisposition: `attachment; filename="${o.filename.replace(/[^\w.-]/g, "_")}"` } : {}),
          ...(o.contentType ? { ResponseContentType: o.contentType } : {}),
        }),
        { expiresIn },
      );
    },
    async head(key) {
      assertKey(key);
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0) };
      } catch (e) {
        if (/** @type {any} */ (e)?.$metadata?.httpStatusCode === 404 || /** @type {any} */ (e)?.name === "NotFound") return null;
        throw e;
      }
    },
    async readBuffer(key, maxBytes) {
      assertKey(key);
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (Number(r.ContentLength ?? 0) > maxBytes) throw new Error("Object too large to read into memory.");
      return Buffer.from(await /** @type {any} */ (r.Body).transformToByteArray());
    },
    async downloadToFile(key, file) {
      assertKey(key);
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await pipeline(/** @type {NodeJS.ReadableStream} */ (r.Body), createWriteStream(file));
    },
    async uploadFromFile(key, file, contentType) {
      assertKey(key);
      const { Upload } = await import("@aws-sdk/lib-storage");
      const size = (await fs.stat(file)).size;
      await new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(file), ContentType: contentType } }).done();
      return size;
    },
    async remove(key) {
      assertKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async removePrefix(prefix) {
      const objects = await list(prefix);
      for (let i = 0; i < objects.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000).map((o) => ({ Key: o.key })) } }));
      }
      return objects.length;
    },
  };
}

/** @param {import("./config.js").CloudConfig} config @returns {Storage} */
function createFsStorage(config) {
  if (!config.secret) throw new Error("APP_SECRET is required (it signs the local storage URLs).");
  const secret = config.secret;
  const root = path.resolve(config.fsRoot);
  /** @param {string} key */
  const file = (key) => {
    assertKey(key);
    const f = path.resolve(root, ...key.split("/"));
    if (!f.startsWith(root + path.sep)) throw new Error("Unsafe storage key.");
    return f;
  };
  /** @param {string} body */
  const sign = (body) => createHmac("sha256", secret).update(body).digest("base64url");
  /** @param {object} claims */
  const token = (claims) => {
    const body = Buffer.from(JSON.stringify({ ...claims, e: Math.floor(Date.now() / 1000) + config.signedUrlSeconds })).toString("base64url");
    return `${body}.${sign(body)}`;
  };

  return {
    driver: "fs",
    async presignPut(key, o) {
      assertKey(key);
      return `/api/v3/storage/${token({ k: key, m: "PUT", s: o.size, t: o.contentType })}`;
    },
    async presignGet(key, o) {
      assertKey(key);
      return `/api/v3/storage/${token({ k: key, m: "GET", f: o.filename, t: o.contentType })}`;
    },
    async head(key) {
      try {
        return { size: (await fs.stat(file(key))).size };
      } catch {
        return null;
      }
    },
    async readBuffer(key, maxBytes) {
      const f = file(key);
      if ((await fs.stat(f)).size > maxBytes) throw new Error("Object too large to read into memory.");
      return fs.readFile(f);
    },
    async downloadToFile(key, dest) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(file(key), dest);
    },
    async uploadFromFile(key, src) {
      const dest = file(key);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      return (await fs.stat(dest)).size;
    },
    async remove(key) {
      await fs.rm(file(key), { force: true });
    },
    async list(prefix) {
      /** @type {Array<{ key: string, size: number }>} */
      const out = [];
      /** @param {string} dir */
      const walk = async (dir) => {
        for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else {
            const key = path.relative(root, p).split(path.sep).join("/");
            if (key.startsWith(prefix)) out.push({ key, size: (await fs.stat(p)).size });
          }
        }
      };
      await walk(root);
      return out;
    },
    async removePrefix(prefix) {
      const objects = await this.list(prefix);
      for (const o of objects) await fs.rm(file(o.key), { force: true });
      return objects.length;
    },
    async serveFs(tok, req, res) {
      const [body = "", sig = ""] = tok.split(".");
      const a = Buffer.from(sign(body));
      const b = Buffer.from(sig);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, "Invalid storage link.");
      /** @type {{ k: string, m: string, e: number, s?: number, f?: string, t?: string }} */
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (claims.e < Date.now() / 1000) throw new HttpError(403, "This link has expired.");
      const method = req.method === "HEAD" ? "GET" : req.method;
      if (method !== claims.m) throw new HttpError(405, "Wrong method for this link.");
      const target = file(claims.k);

      if (claims.m === "PUT") {
        const limit = claims.s ?? 0;
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.uploading-${process.pid}`;
        let bytes = 0;
        try {
          await pipeline(
            req,
            new Transform({
              transform(chunk, _e, cb) {
                bytes += chunk.length;
                cb(bytes > limit ? new HttpError(413, "Upload is larger than declared.") : null, chunk);
              },
            }),
            createWriteStream(tmp),
          );
          await fs.rename(tmp, target);
        } finally {
          await fs.rm(tmp, { force: true });
        }
        res.writeHead(200).end();
        return;
      }

      let st;
      try {
        st = await fs.stat(target);
      } catch {
        throw new HttpError(404, "Not found.");
      }
      res.setHeader("Content-Type", claims.t ?? CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, no-store");
      if (claims.f) res.setHeader("Content-Disposition", `attachment; filename="${claims.f.replace(/[^\w.-]/g, "_")}"`);
      let start = 0;
      let end = st.size - 1;
      const m = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
      if (m && st.size > 0 && (m[1] || m[2])) {
        if (!m[1]) start = Math.max(0, st.size - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(end, Number(m[2]));
        }
        if (start > end || start >= st.size) {
          res.setHeader("Content-Range", `bytes */${st.size}`);
          res.writeHead(416).end();
          return;
        }
        res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
        res.setHeader("Content-Length", String(end - start + 1));
        res.writeHead(206);
      } else {
        res.setHeader("Content-Length", String(st.size));
        res.writeHead(200);
      }
      if (req.method === "HEAD" || st.size === 0) return void res.end();
      await pipeline(createReadStream(target, { start, end }), res).catch(() => {});
    },
  };
}

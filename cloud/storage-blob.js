// @ts-check
// Private object storage on Vercel Blob, behind the same interface as the S3 and local-disk drivers.
//
//   browser  -- presigned PUT / GET (short-lived, scoped to ONE file, size-capped) --> private Blob store
//   worker   -- BLOB_READ_WRITE_TOKEN (server side only): streams files down and up, multipart for large files
//   website  -- BLOB_READ_WRITE_TOKEN (server side only): signs the URLs above after the ownership check
//
// Nothing is public and the token never leaves the server or the Windows PC. Every file this adapter writes, lists or deletes
// lives under one folder of the store (BLOB_PREFIX, default "v2"), so the private video library that already sits in the
// same store ("courses/...") can never be touched by it. The only way to reach a library file is the read-only
// `library:<pathname>` key form, and only for the exact pathnames registered in cloud/library-catalog.js.
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LIBRARY_VIDEOS } from "./library-catalog.js";
import { assertKey } from "./storage-keys.js";

export const LIBRARY_KEY_PREFIX = "library:";

/**
 * The part of @vercel/blob this adapter uses (injectable so tests can run without the network).
 * @typedef {Object} BlobSdk
 * @property {(o: any) => Promise<any>} issueSignedToken
 * @property {(token: any, o: any) => Promise<{ presignedUrl: string }>} presignUrl
 * @property {(pathname: string, body: any, o: any) => Promise<any>} put
 * @property {(pathname: string, o: any) => Promise<{ statusCode: number, stream: ReadableStream<Uint8Array>, headers: Headers } | null>} get
 * @property {(pathname: string, o: any) => Promise<{ size: number }>} head
 * @property {(o: any) => Promise<{ blobs: Array<{ pathname: string, size: number }>, cursor?: string, hasMore: boolean }>} list
 * @property {(pathname: string | string[], o: any) => Promise<void>} del
 * @property {new (...a: any[]) => Error} [BlobNotFoundError]
 */

export async function loadBlobSdk() {
  return /** @type {BlobSdk} */ (/** @type {unknown} */ (await import("@vercel/blob")));
}

/** Pathnames of the files library mode serves: readable through `library:` keys, never writable. */
export function libraryPathnames() {
  return new Set(LIBRARY_VIDEOS.flatMap((v) => Object.values(v.files).map((f) => f.pathname)));
}

const TRANSIENT = /BlobServiceNotAvailable|BlobServiceRateLimited|BlobUnknownError|BlobRequestAbortedError|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i;

/**
 * @param {import("./config.js").CloudConfig} config
 * @param {{ sdk?: BlobSdk, libraryPaths?: Set<string>, retryDelayMs?: number }} [opts]
 * @returns {Promise<import("./storage.js").Storage>}
 */
export async function createBlobStorage(config, opts = {}) {
  const token = config.blob.token;
  if (!token) throw new Error("Vercel Blob storage is not configured: set BLOB_READ_WRITE_TOKEN (the read-write token of your private Blob store).");
  const sdk = opts.sdk ?? (await loadBlobSdk());
  const root = config.blob.prefix;
  const library = opts.libraryPaths ?? libraryPathnames();
  const retryDelay = opts.retryDelayMs ?? 400;
  const ttlMs = config.signedUrlSeconds * 1000;

  /** Where a key we may WRITE lives in the store. @param {string} key */
  const writePath = (key) => {
    if (key.startsWith(LIBRARY_KEY_PREFIX)) throw new Error("Library files are read-only.");
    assertKey(key);
    return `${root}/${key}`;
  };
  /** Where a key we may READ lives: our own folder, or one registered library file. @param {string} key */
  const readPath = (key) => {
    if (!key.startsWith(LIBRARY_KEY_PREFIX)) return writePath(key);
    const p = key.slice(LIBRARY_KEY_PREFIX.length);
    if (!library.has(p)) throw new Error(`Not a registered library file: ${p}`);
    return p;
  };
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  /** Retry transient service/network failures with a short backoff. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const retry = async (fn) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const text = `${/** @type {any} */ (e)?.name ?? ""} ${/** @type {any} */ (e)?.message ?? ""} ${/** @type {any} */ (e)?.cause?.code ?? ""}`;
        if (attempt >= 4 || !TRANSIENT.test(text)) throw e;
        await sleep(retryDelay * 2 ** (attempt - 1));
      }
    }
  };
  /** @param {unknown} e */
  // The live SDK throws BlobNotFoundError ("The requested blob does not exist"); its `name` is not always set, so check all three.
  const isMissing = (e) =>
    /** @type {any} */ (e)?.name === "BlobNotFoundError" || (typeof sdk.BlobNotFoundError === "function" && e instanceof sdk.BlobNotFoundError) || /requested blob does not exist/i.test(String(/** @type {any} */ (e)?.message));

  /** @param {string} prefix */
  const list = async (prefix) => {
    if (!prefix) throw new Error("A prefix is required to list stored files.");
    const base = `${root}/${prefix}`;
    /** @type {Array<{ key: string, size: number }>} */
    const out = [];
    /** @type {string | undefined} */
    let cursor;
    do {
      const page = await retry(() => sdk.list({ prefix: base, limit: 1000, token, ...(cursor ? { cursor } : {}) }));
      for (const b of page.blobs) out.push({ key: b.pathname.slice(root.length + 1), size: b.size });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  };

  /** A one-file, one-operation, short-lived signed token. @param {string} pathname @param {Array<"get" | "put" | "head" | "delete">} operations @param {number} validUntil @param {{ maximumSizeInBytes?: number, allowedContentTypes?: string[] }} [limits] */
  const signed = (pathname, operations, validUntil, limits = {}) => retry(() => sdk.issueSignedToken({ token, pathname, operations, validUntil, ...limits }));

  return {
    driver: "blob",
    list,

    async presignPut(key, o) {
      const pathname = writePath(key);
      const validUntil = Date.now() + ttlMs;
      const limits = { maximumSizeInBytes: o.size, allowedContentTypes: [o.contentType] };
      const st = await signed(pathname, ["put"], validUntil, limits);
      const { presignedUrl } = await sdk.presignUrl(st, { access: "private", operation: "put", pathname, validUntil, allowOverwrite: false, addRandomSuffix: false, ...limits });
      return presignedUrl;
    },

    async presignGet(key, _o) {
      // A downloaded file is named after its stored name (Blob sets Content-Disposition from the pathname).
      const pathname = readPath(key);
      const validUntil = Date.now() + ttlMs;
      const st = await signed(pathname, ["get"], validUntil);
      // useCache:false so a re-generated video (same key) is never served stale from the CDN.
      const { presignedUrl } = await sdk.presignUrl(st, { access: "private", operation: "get", pathname, validUntil, useCache: false });
      return presignedUrl;
    },

    async head(key) {
      try {
        const h = await retry(() => sdk.head(readPath(key), { token }));
        return { size: Number(h.size) };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },

    async readBuffer(key, maxBytes) {
      const pathname = readPath(key);
      const r = await retry(() => sdk.get(pathname, { access: "private", token }));
      if (!r || r.statusCode !== 200) throw new Error(`Stored file not found: ${key}`);
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > maxBytes) {
        await r.stream.cancel().catch(() => {});
        throw new Error("Object too large to read into memory.");
      }
      const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
      if (buf.length > maxBytes) throw new Error("Object too large to read into memory.");
      return buf;
    },

    async downloadToFile(key, file) {
      const pathname = readPath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.downloading-${process.pid}`;
      try {
        await retry(async () => {
          const r = await sdk.get(pathname, { access: "private", token });
          if (!r || r.statusCode !== 200) throw new Error(`Stored file not found: ${key}`);
          await pipeline(Readable.fromWeb(/** @type {any} */ (r.stream)), createWriteStream(tmp));
        });
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    },

    async uploadFromFile(key, file, contentType) {
      const pathname = writePath(key);
      const size = (await fs.stat(file)).size;
      await retry(() =>
        sdk.put(pathname, createReadStream(file), {
          access: "private",
          token,
          contentType,
          allowOverwrite: true,
          addRandomSuffix: false,
          // files over a few MB go up in parallel parts, so a 100 MB video needs no special handling
          multipart: size > 4 * 1024 * 1024,
        }),
      );
      return size;
    },

    async remove(key) {
      await retry(() => sdk.del(writePath(key), { token }));
    },

    async removePrefix(prefix) {
      if (!prefix.endsWith("/") || prefix.startsWith(LIBRARY_KEY_PREFIX) || prefix.split("/").filter(Boolean).length < 2) {
        throw new Error(`Refusing to remove "${prefix}": a prefix must be a folder such as users/<id>/courses/<id>/.`);
      }
      const objects = await list(prefix);
      for (let i = 0; i < objects.length; i += 100) {
        const batch = objects.slice(i, i + 100).map((o) => `${root}/${o.key}`);
        await retry(() => sdk.del(batch, { token }));
      }
      return objects.length;
    },
  };
}

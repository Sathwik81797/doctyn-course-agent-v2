import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { readJsonBody } from "../cloud/auth.js";

/** A request the way the Vercel Node runtime hands it over: stream already consumed, parsed body in req.body. */
const vercelReq = (body: unknown) => {
  const req = Readable.from([]);
  for (const [k, value] of Object.entries({ body, readableEnded: true, readable: false })) Object.defineProperty(req, k, { value, configurable: true });
  return req as unknown as IncomingMessage;
};
/** A request the way plain Node hands it over: the body is still in the stream. */
const plainReq = (text: string) => Readable.from([Buffer.from(text)]) as unknown as IncomingMessage;

describe("readJsonBody (plain Node and Vercel runtime)", () => {
  it("reads the pre-parsed req.body when the runtime already consumed the stream", async () => {
    assert.deepEqual(await readJsonBody(vercelReq({ email: "a@b.c", password: "x" }), 1024), { email: "a@b.c", password: "x" });
    assert.deepEqual(await readJsonBody(vercelReq('{"a":1}'), 1024), { a: 1 });
    assert.deepEqual(await readJsonBody(vercelReq(Buffer.from('{"a":2}')), 1024), { a: 2 });
    assert.deepEqual(await readJsonBody(vercelReq(""), 1024), {});
  });

  it("reads the stream on a plain Node server", async () => {
    assert.deepEqual(await readJsonBody(plainReq('{"email":"x@y.z"}'), 1024), { email: "x@y.z" });
    assert.deepEqual(await readJsonBody(plainReq(""), 1024), {});
  });

  it("rejects oversize and malformed bodies the same way in both", async () => {
    await assert.rejects(readJsonBody(vercelReq({ big: "x".repeat(2000) }), 1024), { status: 413 });
    await assert.rejects(readJsonBody(plainReq("x".repeat(2000)), 1024), { status: 413 });
    await assert.rejects(readJsonBody(vercelReq("{not json"), 1024), { status: 400 });
    await assert.rejects(readJsonBody(plainReq("{not json"), 1024), { status: 400 });
  });
});

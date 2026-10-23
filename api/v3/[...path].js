import { ConfigError, getContext } from "../../cloud/context.js";
import { handleApi, sendJson } from "../../cloud/routes.js";

// One function serves the whole /api/v3 API (keeps within the free-plan function limit).
export const config = { maxDuration: 30 };

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
export default async function handler(req, res) {
  let ctx;
  try {
    ctx = await getContext();
  } catch (err) {
    if (err instanceof ConfigError) {
      return sendJson(res, 503, { error: "The cloud backend is not configured yet.", problems: err.problems });
    }
    console.error("[api] startup failed", err);
    return sendJson(res, 503, { error: "The cloud backend could not start. Check DATABASE_URL and the storage settings." });
  }
  return handleApi(ctx, req, res);
}

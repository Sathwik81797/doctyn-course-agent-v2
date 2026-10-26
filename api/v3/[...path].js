import { ConfigError, getContext } from "../../cloud/context.js";
import { createLibraryHandler, libraryConfig, libraryModeConfigured, libraryProblems, vercelBlobReader } from "../../cloud/library.js";
import { handleApi, sendJson } from "../../cloud/routes.js";

// One function serves the whole /api/v3 API (keeps within the free-plan function limit).
// Videos are streamed through it, so allow time for a full download on a slow connection.
export const config = { maxDuration: 60 };

let library;

/** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
export default async function handler(req, res) {
  // Library mode: a private Blob video library with invited users, no database needed (used when DATABASE_URL is not set).
  if (libraryModeConfigured(process.env)) {
    library ??= createLibraryHandler({ config: libraryConfig(process.env), readBlob: vercelBlobReader(libraryConfig(process.env).blobToken) });
    return library(req, res);
  }
  let ctx;
  try {
    ctx = await getContext();
  } catch (err) {
    if (err instanceof ConfigError) {
      return sendJson(res, 503, {
        error: "The backend is not configured yet.",
        problems: err.problems,
        alternative: ["Or, for the private-Blob video library without a database, set:", ...libraryProblems(process.env)],
      });
    }
    console.error("[api] startup failed", err);
    return sendJson(res, 503, { error: "The backend could not start. Check DATABASE_URL and the storage settings." });
  }
  return handleApi(ctx, req, res);
}

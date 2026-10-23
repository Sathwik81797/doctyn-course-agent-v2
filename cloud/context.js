// @ts-check
import { cloudConfig, configProblems } from "./config.js";
import { createDb } from "./db.js";
import { createStorage } from "./storage.js";

/** @typedef {import("./routes.js").Ctx} Ctx */

/** @type {Promise<Ctx> | null} */
let cached = null;

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Cloud backend is not configured:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

/** Connect once per process (a warm serverless instance reuses it). @param {Record<string, string | undefined>} [env] @returns {Promise<Ctx>} */
export function getContext(env = process.env) {
  cached ??= (async () => {
    const config = cloudConfig(env);
    const problems = configProblems(config);
    if (problems.length) throw new ConfigError(problems);
    return { config, db: await createDb(config), storage: await createStorage(config) };
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

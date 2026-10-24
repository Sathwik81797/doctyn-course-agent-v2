/**
 * npm run cloud:import-course -- <output/course-folder> [--email you@example.com]
 *
 * Adds a course already built by the local pipeline to the dashboard's Generated Videos (original video,
 * captions, transcript and any enhanced animated video) without re-rendering anything. The course becomes
 * private to the given account (default: the local-mode user). The enhanced video keeps its Draft status.
 * Uses the database/storage from .env; with the in-process development database use npm run cloud:dev instead,
 * which imports ./output/* automatically.
 */
import "dotenv/config";
import { getContext } from "../cloud/context.js";
import { ensureLocalUser } from "../cloud/auth.js";
import { importCourse } from "./worker/import-course.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const emailAt = args.indexOf("--email");
if (!dir) {
  console.error("Usage: npm run cloud:import-course -- output/<course-folder> [--email you@example.com]");
  process.exit(2);
}
const ctx = await getContext();
let ownerId: string | undefined;
if (emailAt >= 0) {
  ownerId = (await ctx.db.query("SELECT id FROM users WHERE email = $1", [String(args[emailAt + 1]).toLowerCase()])).rows[0]?.id;
  if (!ownerId) {
    console.error("No account with that email. Register it first.");
    process.exit(1);
  }
} else {
  ownerId = await ensureLocalUser(ctx.db);
}
const r = await importCourse(ctx, { dir, ownerId: ownerId as string, log: console.log });
console.log(r ? (r.created ? `Imported "${r.title}". Run the engine (npm run engine) so it can finish reading the files.` : `"${r.title}" was already imported.`) : "No course.json found in that folder.");
await ctx.db.close();

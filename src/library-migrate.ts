/**
 * npm run library:migrate -- <plan|apply|verify|rollback> [options]
 *
 * Moves the private video library (library mode: LIBRARY_USERS + one video in Vercel Blob) into full mode
 * (Postgres accounts + private bucket library). Dry run by default: `plan` and `rollback` only report; `apply` writes and needs --yes.
 * It never touches Vercel Blob, Vercel settings or any deployment. See docs/MIGRATION.md.
 *
 *   --users-file FILE    LIBRARY_USERS entries (email=scrypt-hash, comma or newline separated); default: $LIBRARY_USERS
 *   --owner EMAIL        account that owns the imported video (default: the first library user)
 *   --share owner|all    give the video to the owner only (default) or to every migrated user as private copies
 *   --admin EMAIL        make this migrated account an administrator (repeatable; only for accounts created now)
 *   --course-dir DIR     finished course folder (default: the output/* folder whose title matches the library entry)
 *   --manifest FILE      where the undo record is kept (default .data/library-migration.json)
 *   --yes                required by `apply`
 *   --apply              required by `rollback` to actually remove things
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { LIBRARY_VIDEOS } from "../cloud/library-catalog.js";
import { cloudConfig, configProblems } from "../cloud/config.js";
import { getContext } from "../cloud/context.js";
import type { Ctx } from "../cloud/routes.js";
import { applyMigration, parseUsersStrict, planMigration, rollbackMigration, verifyMigration, type Finding, type MigrationInput } from "./migration/library-migration.js";
import { formatError } from "./utils/errors.js";
import { PROJECT_ROOT } from "./utils/config.js";

const [cmd = "plan", ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : "";
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));

const mark = { error: "ERROR", warn: "warn ", info: "ok   " } as const;
const print = (f: Finding): void => console.log(`  [${mark[f.level]}] ${f.text}`);

async function findCourseDir(): Promise<string> {
  const given = flag("course-dir");
  if (given) return path.resolve(given);
  const out = path.resolve(process.env.OUTPUT_DIR ?? path.join(PROJECT_ROOT, "output"));
  for (const d of await fs.readdir(out).catch(() => [])) {
    const meta = await fs.readFile(path.join(out, d, "course.json"), "utf8").then((t) => JSON.parse(t) as { courseTitle?: string }, () => null);
    if (meta?.courseTitle === LIBRARY_VIDEOS[0]?.title) return path.join(out, d);
  }
  throw new Error(`No folder under ${out} holds "${LIBRARY_VIDEOS[0]?.title}". Pass --course-dir output/<course-folder>.`);
}

async function main(): Promise<void> {
  if (!["plan", "apply", "verify", "rollback"].includes(cmd)) {
    console.error("Usage: npm run library:migrate -- <plan|apply|verify|rollback> [options]   (see the header of src/library-migrate.ts)");
    process.exit(2);
  }
  const manifestPath = path.resolve(flag("manifest") || path.join(PROJECT_ROOT, ".data", "library-migration.json"));
  const config = cloudConfig();
  const hasDb = Boolean(config.databaseUrl);

  let ctx: Ctx | null = null;
  if (hasDb) {
    const problems = configProblems(config);
    if (problems.length) throw new Error(`The database/storage settings are incomplete:\n- ${problems.join("\n- ")}`);
    ctx = await getContext();
  } else if (cmd !== "plan") {
    throw new Error(`${cmd} needs DATABASE_URL and the S3_* settings in .env (the production database and bucket). Only "plan" runs without them.`);
  }

  if (cmd === "rollback") {
    console.log(`Rollback (${args.includes("--apply") ? "APPLYING" : "dry run"}) using ${manifestPath}`);
    const r = await rollbackMigration(ctx!, manifestPath, { apply: args.includes("--apply"), log: console.log });
    console.log(`\n${r.applied ? "Removed" : "Would remove"}: ${r.removedCourses.length} imported course(s), ${r.removedUsers.length} account(s).`);
    for (const k of r.keptUsers) console.log(`  kept ${k.email}: ${k.reason}`);
    console.log("The private Vercel Blob store was not touched.");
    if (!r.applied) console.log("Run again with --apply to remove them.");
    await ctx?.db.close();
    return;
  }

  const usersFile = flag("users-file");
  const text = usersFile ? await fs.readFile(usersFile, "utf8") : process.env.LIBRARY_USERS ?? "";
  const { users, skipped } = parseUsersStrict(text);
  if (users.size === 0) {
    throw new Error(
      "No library users to migrate.\nThe production value of LIBRARY_USERS is a hidden Vercel secret and cannot be read back. Put the same entries\n(email=scrypt$…, one per person) in a file and pass --users-file FILE, or export LIBRARY_USERS in this shell.\nIf you no longer have them, create new ones with npm run library:hash-password.",
    );
  }
  const first = [...users.keys()][0]!;
  const share = flag("share") === "all" ? "all" : "owner";
  const input: MigrationInput = { users, owner: (flag("owner") || first).toLowerCase(), share, admins: all("admin"), courseDir: await findCourseDir() };

  if (skipped.length) console.log(`Skipped ${skipped.length} malformed LIBRARY_USERS entr${skipped.length === 1 ? "y" : "ies"}: ${skipped.join(", ")}`);

  if (cmd === "verify") {
    const findings = await verifyMigration(ctx!, input);
    findings.forEach(print);
    await ctx!.db.close();
    process.exit(findings.some((f) => f.level === "error") ? 1 : 0);
  }

  const plan = await planMigration(ctx, input);
  console.log(`Library migration — ${cmd === "apply" ? "APPLY" : "dry run (nothing is written)"}`);
  console.log(`  source folder : ${input.courseDir}`);
  console.log(`  database      : ${ctx ? "connected" : "not configured (assuming every account is new)"}`);
  console.log(`  owner         : ${input.owner}      video copies: ${share === "all" ? "one per user" : "owner only"}`);
  if (plan.video) console.log(`  video         : "${plan.video.title}" · ${plan.video.slideCount} slides · ${(plan.video.durationSeconds / 60).toFixed(1)} min · enhanced ${plan.video.enhanced.toUpperCase()} · ${(plan.video.totalBytes / 1048576).toFixed(0)} MB to upload per copy`);
  console.log("\nAccounts:");
  for (const u of plan.users) console.log(`  ${u.action === "create" ? "+ create " : "= keep   "} ${u.email}  (${u.role})${u.action === "exists-different-password" ? "  existing account has another password" : ""}`);
  console.log("\nVideo:");
  for (const i of plan.imports) console.log(`  ${i.action === "import" ? "+ import " : "= present"} → ${i.email}`);
  console.log("\nChecks:");
  plan.findings.forEach(print);

  if (cmd === "plan") {
    console.log(plan.ok ? "\nDry run complete. Nothing was changed." : "\nFix the errors above before applying.");
    await ctx?.db.close();
    process.exit(plan.ok ? 0 : 1);
  }
  if (!plan.ok) throw new Error("The plan has errors; nothing was written.");
  if (!args.includes("--yes")) throw new Error("apply writes to the production database and bucket named in .env. Re-run with --yes to proceed.");
  console.log(`\nApplying to bucket "${config.s3.bucket}" …`);
  const manifest = await applyMigration(ctx!, input, { manifestPath, log: console.log });
  console.log(`\nDone: ${manifest.users.length} account(s) and ${manifest.courses.length} course(s) recorded in ${manifestPath}.`);
  console.log("Start the engine (npm run engine) so it finishes reading the sources, then: npm run library:migrate -- verify");
  console.log("The live site is unchanged: it stays in library mode until DATABASE_URL is set on Vercel.");
  await ctx!.db.close();
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

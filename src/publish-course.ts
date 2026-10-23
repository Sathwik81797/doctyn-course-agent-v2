/**
 * npm run publish-course
 *
 * Admin-controlled publishing of finished courses to Vercel Blob so the website library can show them.
 * Nothing is uploaded unless --yes is passed. Without it the command only prints what would happen.
 *
 *   npm run publish-course                                list local courses and what is published
 *   npm run publish-course -- <slug>                      dry run: show exactly what would be uploaded
 *   npm run publish-course -- <slug> --yes                approve and upload
 *   npm run publish-course -- --unpublish <slug> [--yes]  remove a course from the website library
 */
import { listCourses } from "./server/library.js";
import {
  buildPlan,
  expectedCatalogUrl,
  findAuth,
  PUBLISHABLE,
  readCatalog,
  requireAuth,
  unpublish,
  uploadPlan,
} from "./services/publish.js";
import { loadConfig } from "./utils/config.js";
import { PipelineError, runMain } from "./utils/errors.js";

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

runMain(async () => {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const unpublishMode = args.includes("--unpublish");
  const slug = args.find((a) => !a.startsWith("--"));
  const config = loadConfig();

  if (unpublishMode) {
    if (!slug) throw new PipelineError("Which course should be unpublished?", "Usage: npm run publish-course -- --unpublish <slug> [--yes]");
    console.log(`UNPUBLISH "${slug}" from the website library`);
    console.log("Local files in output/ are not touched.");
    if (!yes) {
      console.log("\nDRY RUN — nothing was changed. Add --yes to remove it.");
      return 0;
    }
    const removed = await unpublish(requireAuth(), slug);
    console.log(removed.length ? `Removed ${removed.length} stored file(s):\n  ${removed.join("\n  ")}` : "No stored files were found for that course.");
    return 0;
  }

  if (!slug) {
    const auth = findAuth();
    const published = auth ? await readCatalog(auth).catch(() => null) : null;
    console.log("COURSES IN output/");
    console.log("");
    for (const c of await listCourses(config.outputDir)) {
      const state = published?.courses.some((p) => p.slug === c.slug) ? "published" : "not published";
      console.log(`  ${c.slug}\n    ${c.title} — ${c.status}${c.status === "complete" ? `, ${state}` : ""}`);
    }
    if (!auth) console.log("\n(No Vercel Blob credentials are set, so publish status is unknown.)");
    console.log("\nNext: npm run publish-course -- <slug>");
    return 0;
  }

  const plan = await buildPlan(config.outputDir, slug);
  console.log(`PUBLISH PLAN: ${plan.course.title}`);
  console.log(`Course folder: ${slug}`);
  console.log("");
  console.log("Files that WILL be uploaded (public: anyone with the link can view them):");
  for (const f of plan.files) console.log(`  ${f.localPath}\n    -> ${f.blobPath}  (${mb(f.bytes)})`);
  console.log(`\nTotal: ${mb(plan.totalBytes)}`);
  const absent = PUBLISHABLE.filter((s) => !plan.files.some((f) => f.key === s.key)).map((s) => s.file);
  if (absent.length) console.log(`Optional files not present: ${absent.join(", ")}`);
  console.log("Never uploaded: source PPTX/DOCX, presentation.pptx, voiceover-script.docx, audio, slides, segments, qa, checkpoint.json, .env");

  if (!yes) {
    console.log("\nDRY RUN — nothing was uploaded. To approve and upload, run:");
    console.log(`  npm run publish-course -- ${slug} --yes`);
    return 0;
  }

  const auth = requireAuth();
  console.log("\nUploading…");
  const lastPrinted = new Map<string, number>();
  const { entry, catalogUrl } = await uploadPlan(auth, plan, (file, pct) => {
    const step = Math.floor(pct / 10) * 10;
    if (step !== lastPrinted.get(file.blobPath)) {
      lastPrinted.set(file.blobPath, step);
      console.log(`  ${file.blobPath} ${Math.round(pct)}%`);
    }
  });

  console.log("\nPUBLISHED");
  console.log(`Video:   ${entry.files.video?.url}`);
  console.log(`Catalog: ${catalogUrl}`);
  const expected = expectedCatalogUrl(auth);
  if (expected && expected !== catalogUrl) {
    console.log("");
    console.log("NOTE: the catalog is not at the address the website derives from the credentials.");
    console.log(`Set this environment variable on the Vercel project, then redeploy:\n  LIBRARY_CATALOG_URL=${catalogUrl}`);
  }
  return 0;
});

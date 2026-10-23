/**
 * npm run validate
 *
 * Detects the PPTX and DOCX in ./input, counts slides, parses narration and
 * reports the slide-to-voiceover mapping. Makes no API calls and renders nothing.
 */
import path from "node:path";
import { loadCourse, writeValidationFiles } from "./services/course.js";
import { loadConfig } from "./utils/config.js";
import { runMain } from "./utils/errors.js";

runMain(async () => {
  const config = loadConfig();
  console.log("DOCTYN COURSE VALIDATION");
  console.log("");
  console.log(`Input folder: ${config.inputDir}`);

  const course = await loadCourse(config);
  const { inputs, pptx, docx, identity, validation: v, paths } = course;

  console.log(`PPTX: ${path.basename(inputs.pptx)}`);
  console.log(`DOCX: ${path.basename(inputs.docx)}`);
  if (inputs.ignored.length) console.log(`Ignored temporary files: ${inputs.ignored.join(", ")}`);
  console.log("");
  console.log(`Course title: ${identity.title}`);
  console.log(`Course slug:  ${identity.slug}`);
  console.log(`Output:       ${paths.root}`);
  if (pptx.slideSize) {
    const ratio = pptx.slideSize.cx / pptx.slideSize.cy;
    console.log(`Slide size:   ${(pptx.slideSize.cx / 914400).toFixed(2)}" x ${(pptx.slideSize.cy / 914400).toFixed(2)}" (${ratio.toFixed(3)}:1${Math.abs(ratio - 16 / 9) > 0.01 ? ", not 16:9 — slides will be padded" : ", 16:9"})`);
  }
  console.log(`Narration sections parsed: ${docx.records.length}`);
  console.log("");

  const report = await writeValidationFiles(course);
  console.log(report);
  console.log("");
  console.log(`Mapping report: ${paths.mappingReport}`);

  if (!v.ok) {
    console.log(`Error report:   ${paths.validationError}`);
    console.log("");
    console.log("VALIDATION FAILED — fix the voiceover document or presentation, then run again.");
    return 1;
  }
  console.log("");
  console.log(`VALIDATION PASSED — ${v.pptxCount} slides mapped to ${v.narrationCount} voiceover sections.`);
  console.log("Next: npm run build-course");
  return 0;
});

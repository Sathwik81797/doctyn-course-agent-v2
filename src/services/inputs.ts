import fs from "node:fs/promises";
import path from "node:path";
import { PipelineError } from "../utils/errors.js";
import { exists, isOfficeTempFile } from "../utils/files.js";

export interface InputFiles {
  pptx: string;
  docx: string;
  ignored: string[];
}

/** Find exactly one .pptx and one .docx in the input folder, ignoring Office temp files (~$...). */
export async function detectInputs(inputDir: string): Promise<InputFiles> {
  if (!(await exists(inputDir))) {
    throw new PipelineError(
      `The input folder does not exist:\n${inputDir}`,
      "Create it (mkdir -p input) and place exactly one .pptx and one .docx inside, or set INPUT_DIR in .env.",
    );
  }

  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const ignored = files.filter(isOfficeTempFile);
  const usable = files.filter((n) => !isOfficeTempFile(n) && !n.startsWith("."));
  const pptx = usable.filter((n) => /\.pptx$/i.test(n));
  const docx = usable.filter((n) => /\.docx$/i.test(n));

  const problems: string[] = [];
  if (pptx.length === 0) {
    const legacy = usable.filter((n) => /\.(ppt|pps|ppsx|odp|key)$/i.test(n));
    problems.push(
      "No .pptx presentation found." +
        (legacy.length ? ` Found ${legacy.join(", ")} — re-save it from PowerPoint as .pptx.` : ""),
    );
  } else if (pptx.length > 1) {
    problems.push(`Found ${pptx.length} .pptx files; expected exactly one:\n${pptx.map((n) => `  - ${n}`).join("\n")}`);
  }
  if (docx.length === 0) {
    const legacy = usable.filter((n) => /\.(doc|odt|rtf|pdf|txt)$/i.test(n));
    problems.push(
      "No .docx voiceover script found." +
        (legacy.length ? ` Found ${legacy.join(", ")} — re-save it from Word as .docx.` : ""),
    );
  } else if (docx.length > 1) {
    problems.push(`Found ${docx.length} .docx files; expected exactly one:\n${docx.map((n) => `  - ${n}`).join("\n")}`);
  }

  if (problems.length) {
    throw new PipelineError(
      `Input folder problem (${inputDir}):\n\n${problems.join("\n\n")}`,
      "The input folder must contain exactly one .pptx and exactly one .docx. Office temporary files (~$...) are ignored automatically.",
    );
  }

  return { pptx: path.join(inputDir, pptx[0]!), docx: path.join(inputDir, docx[0]!), ignored };
}

/**
 * Clinical review pack: everything a clinician needs to approve (or reject) each slide's
 * animation in one Markdown document. It lists what appears on screen, when, which phrase of the
 * narration triggers it, who wrote each pop-up, and the flags that must be acknowledged.
 */
import { elementSpecs } from "./scene/core.js";
import { isApproved, reviewSummary } from "./store.js";
import type { CoursePlan, SlidePlan } from "./types.js";

const ORIGIN: Record<string, string> = {
  source: "taken from the course source",
  glossary: "WRITTEN BY THE TOOL (glossary) — needs clinician sign-off",
  ai: "WRITTEN BY AI — needs clinician sign-off",
};

const clock = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function slideSection(s: SlidePlan, generic: boolean): string {
  const specs = new Map(elementSpecs(s).map((e) => [e.id, e]));
  const lines: string[] = [];
  const status = isApproved(s) ? `APPROVED by ${s.review.reviewer}` : s.review.status.toUpperCase().replace("_", " ");
  lines.push(`### Slide ${String(s.slide).padStart(2, "0")} — ${s.title}`);
  lines.push("");
  lines.push(`* Scene: \`${s.template}\`${generic ? " (**generic** — no topic-specific scene)" : ""} · ${s.durationSeconds.toFixed(1)} s · status: **${status}**`);
  lines.push(`* Why: ${s.rationale}`);
  lines.push("");
  lines.push("| Appears | On screen | Triggered by narration phrase |");
  lines.push("|---|---|---|");
  for (const e of [...s.events].filter((x) => x.action === "show").sort((a, b) => a.start - b.start)) {
    const label = (s.labels[e.element] ?? specs.get(e.element)?.label ?? e.element).replace(/\|/g, " — ").replace(/\n/g, " ");
    lines.push(`| ${clock(e.start)} | ${label} | ${e.cue ? `“${e.cue}”` : "_position only (no phrase)_"} |`);
  }
  if (s.popups.length) {
    lines.push("");
    lines.push("Pop-ups:");
    for (const p of s.popups) lines.push(`* ${clock(p.start)} **${p.title}** (${p.kind}) — ${p.text}  \n  _${ORIGIN[p.origin] ?? p.origin}_`);
  }
  lines.push("");
  lines.push("Acknowledge before approving:");
  if (s.flags.length === 0) lines.push("* [ ] _no automatic flags_");
  for (const f of s.flags) lines.push(`* [${f.acknowledged ? "x" : " "}] (${f.kind}) ${f.text}`);
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run animate -- approve --slide ${s.slide} --reviewer "Dr Name" --notes "optional"`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export function buildReviewPack(plan: CoursePlan, baseline?: CoursePlan): string {
  const r = reviewSummary(plan);
  const base = new Map((baseline?.slides ?? []).map((s) => [s.slide, s.template]));
  const changed = plan.slides.filter((s) => base.has(s.slide) && base.get(s.slide) !== s.template);
  const out: string[] = [];
  out.push(`# Clinical review pack — ${plan.courseTitle}`);
  out.push("");
  out.push(`Generated ${new Date().toISOString().slice(0, 10)} · ${plan.slides.length} slides · **${r.approved}/${r.total} approved**`);
  out.push("");
  out.push("Nothing in this pack is clinically approved until a named clinician approves each slide. The enhanced video cannot be rendered as a final (non-draft) video until every slide shows APPROVED.");
  out.push("");
  out.push("## How to review");
  out.push("");
  out.push("1. Read each slide below: the wording on screen, the narration phrase that triggers it, and the flags.");
  out.push("2. Edit anything in the studio: `npm run dashboard` → http://127.0.0.1:8788/#/studio (labels, timings, pop-ups; any edit resets that slide's approval).");
  out.push("3. Approve a slide in the studio, or with the command under it (it acknowledges all of that slide's flags).");
  out.push("4. When all are approved: `npm run animate -- render --enhanced` (final) — or `--enhanced --draft` for a watermarked draft before that.");
  out.push("");
  out.push("## What changed");
  out.push("");
  const byTemplate = new Map<string, number[]>();
  for (const s of plan.slides) byTemplate.set(s.template, [...(byTemplate.get(s.template) ?? []), s.slide]);
  out.push("| Scene | Slides |");
  out.push("|---|---|");
  for (const [t, ns] of byTemplate) out.push(`| \`${t}\` | ${ns.join(", ")} |`);
  out.push("");
  if (baseline) out.push(`${changed.length} slides moved from a generic scene to a topic-specific one; ${plan.slides.length - changed.length} keep their previous scene.`);
  out.push("");
  out.push("## Slides");
  out.push("");
  for (const s of plan.slides) out.push(slideSection(s, s.template === "key-points"));
  return out.join("\n");
}

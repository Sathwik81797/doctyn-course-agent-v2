import OpenAI from "openai";
import { z } from "zod";
import type { Config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import type { AnalysisOverride, SlideSource } from "./analyzer.js";
import { TEMPLATE_DEFS } from "./scene/core.js";
import { findPhrase, LEAD_IN, TAIL, wordTimings } from "./scene/timing.js";
import { DERIVABLE } from "./scene/derive.js";
import { CATEGORIES, TEMPLATES } from "./types.js";

/** Templates the AI may pick: the reusable components (filled from the slide's own words) and key-points. Diabetes-specific scenes are chosen by the deterministic rules. */
export const AI_TEMPLATES = [...DERIVABLE, "key-points"] as const;

const AiResponse = z.object({
  template: z.enum(TEMPLATES),
  rationale: z.string().max(400),
  category: z.enum(CATEGORIES).default("general"),
  topic: z.string().max(200).default(""),
  objective: z.string().max(300).default(""),
  mechanism: z.string().max(300).optional(),
  popups: z
    .array(z.object({ title: z.string().max(80), text: z.string().max(300), kind: z.enum(["definition", "clinical"]), cue: z.string().max(120) }))
    .max(2)
    .default([]),
});

export type Complete = (system: string, user: string) => Promise<string>;

export function buildPrompt(src: SlideSource): { system: string; user: string } {
  const catalog = AI_TEMPLATES.map((t) => `- ${t}: ${TEMPLATE_DEFS[t].name}`).join("\n");
  return {
    system:
      "You choose a medical explainer animation for one slide of a clinician-education course. " +
      "Reply with JSON only: {template, rationale, category, topic, objective, mechanism, popups:[{title,text,kind,cue}]}. " +
      `category is one of: ${CATEGORIES.join(", ")}. topic = the clinical topic in a few words; objective = the one thing the learner should take from the slide; mechanism = the medical mechanism or sequence the slide describes, only if it states one. ` +
      "Describe only what the slide text and voiceover say; never add facts, anatomy or relationships they do not state. " +
      "template must be one of the catalog ids: pick the one whose structure matches the slide (sequence of causes, contributors to one conclusion, two sides compared, time course, ordered steps or decisions, test interpretation, organs named, patient case); use key-points only when no catalog template fits. " +
      "popups: at most 2, each defining a term that appears in the narration; cue must be an exact 1-4 word phrase copied from the narration. " +
      "Never invent numbers, thresholds or drug doses.\n\nCatalog:\n" +
      catalog,
    user: `Slide ${src.slide}: ${src.title}\n\nOn-slide text:\n${src.slideText.join("\n")}\n\nVoiceover:\n${src.narration}`,
  };
}

/** Parse and validate a model reply. Pop-up cues that are not in the narration are dropped; timing comes from our own word timings. */
export function interpretAiReply(raw: string, src: SlideSource): AnalysisOverride {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("reply was not JSON");
  }
  const r = AiResponse.parse(json);
  const words = wordTimings(src.narration, Math.max(0.5, src.durationSeconds - LEAD_IN - TAIL));
  const extraPopups = r.popups.flatMap((p, i) => {
    const hit = findPhrase(words, p.cue);
    if (!hit) return [];
    const start = Math.max(0.4, hit.start - 0.1);
    return [
      { id: `pop-ai-${i + 1}`, title: p.title, text: p.text, kind: p.kind, start, end: Math.min(src.durationSeconds - 0.2, start + 5), cue: p.cue, origin: "ai" as const },
    ];
  });
  const analysis = { category: r.category, ...(r.topic ? { topic: r.topic } : {}), ...(r.objective ? { objective: r.objective } : {}), ...(r.mechanism ? { mechanism: r.mechanism } : {}) };
  return { template: r.template, rationale: `AI: ${r.rationale}`, extraPopups, analyzer: "ai", analysis };
}

export function aiAnalyzer(complete: Complete): (src: SlideSource) => Promise<AnalysisOverride> {
  return async (src) => {
    const { system, user } = buildPrompt(src);
    return interpretAiReply(await complete(system, user), src);
  };
}

/** OpenAI-backed completion. Paid; only used when `animate analyze --ai` is requested. */
export function openAiComplete(config: Config): Complete {
  if (!config.openaiApiKey) {
    throw new PipelineError("--ai needs OPENAI_API_KEY.", "Add OPENAI_API_KEY to .env, or run without --ai to use the offline rule-based analyzer.");
  }
  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const model = process.env["ANIMATION_AI_MODEL"]?.trim() || "gpt-4o-mini";
  return async (system, user) => {
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message.content ?? "";
  };
}

import { z } from "zod";

/** Scene templates the engine can draw. Every slide maps to exactly one. */
export const TEMPLATES = [
  "glucose-uptake",
  "visceral-fat",
  "continuum",
  "pathway",
  "converge",
  "balance",
  "body",
  "lab-branch",
  "homa",
  "ogtt",
  "stagemap",
  "timeline",
  "case",
  "algorithm",
  "compare",
  "workflow",
  "organ-map",
  "key-points",
] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export const REVIEW_STATUSES = ["draft", "needs_review", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const seconds = z.number().finite().min(0).max(36000);

export const TimelineEventSchema = z.object({
  id: z.string().min(1).max(60),
  /** Element id defined by the slide's template (e.g. "insulin", "stage3"). */
  element: z.string().min(1).max(60),
  /** show = the element animates in over [start,end] and stays; pulse = temporary emphasis. */
  action: z.enum(["show", "pulse"]),
  start: seconds,
  end: seconds,
  /** Narration phrase this event is anchored to (editor re-resolves it when narration changes). */
  cue: z.string().max(200).optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const PopupSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().max(80),
  text: z.string().min(1).max(400),
  kind: z.enum(["definition", "clinical", "warning"]),
  start: seconds,
  end: seconds,
  cue: z.string().max(200).optional(),
  /** Where the pop-up text came from; anything not "source" needs clinician sign-off. */
  origin: z.enum(["source", "glossary", "ai"]),
});
export type Popup = z.infer<typeof PopupSchema>;

export const ClinicalFlagSchema = z.object({
  id: z.string(),
  kind: z.enum(["numeric-claim", "drug", "ai-content", "template-assumption", "generic-animation"]),
  text: z.string().max(300),
  acknowledged: z.boolean(),
});
export type ClinicalFlag = z.infer<typeof ClinicalFlagSchema>;

export const ReviewSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  reviewer: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  updatedAt: z.string().optional(),
  /** Hash of the content (narration + template + events + popups + labels) that was approved. */
  approvedHash: z.string().optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** An on-screen element of a derived scene (text comes from the slide or narration; cues anchor it to the voice). */
export const ItemSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(240),
  cues: z.array(z.string().max(120)).max(6),
  free: z.boolean().optional(),
  frac: z.number().min(0).max(1).optional(),
  description: z.string().max(120).optional(),
});

export const CATEGORIES = ["anatomy", "pathophysiology", "physiology", "clinical-pathway", "timeline", "treatment-algorithm", "diagnostic-workflow", "laboratory", "comparison", "clinical-case", "general"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What the planner understood about the slide: shown to the reviewer next to the template choice. */
export const AnalysisSchema = z.object({
  category: z.enum(CATEGORIES),
  topic: z.string().max(200),
  objective: z.string().max(300),
  mechanism: z.string().max(300).optional(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const SlidePlanSchema = z.object({
  slide: z.number().int().min(1),
  title: z.string(),
  narration: z.string(),
  /** Text blocks read from the PPTX slide, in reading order (editable). */
  slideText: z.array(z.string().max(500)),
  template: z.enum(TEMPLATES),
  /** Why the analyzer chose this template. */
  rationale: z.string(),
  analyzer: z.enum(["rules", "ai"]),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Elements derived from this slide's own text/narration for reusable templates (authored diabetes scenes keep theirs in content.ts). */
  items: z.array(ItemSchema).max(40).optional(),
  analysis: AnalysisSchema.optional(),
  /** Element label overrides (element id -> text). */
  labels: z.record(z.string(), z.string().max(120)),
  durationSeconds: z.number().positive(),
  durationSource: z.enum(["audio", "estimated"]),
  /** True when narration was edited after the audio for this slide was generated. */
  audioStale: z.boolean(),
  events: z.array(TimelineEventSchema),
  popups: z.array(PopupSchema),
  flags: z.array(ClinicalFlagSchema),
  review: ReviewSchema,
});
export type SlidePlan = z.infer<typeof SlidePlanSchema>;

export const CoursePlanSchema = z.object({
  version: z.literal(1),
  courseTitle: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Normalised header / footer lines that repeat across the deck; ignored when a slide is re-analysed after an edit. */
  boilerplate: z.array(z.string()).optional(),
  slides: z.array(SlidePlanSchema),
});
export type CoursePlan = z.infer<typeof CoursePlanSchema>;

/** Editable subset accepted by PUT /api/v2/<slug>/slides/<n>. */
export const SlideEditSchema = z
  .object({
    narration: z.string().max(20000),
    slideText: z.array(z.string().max(500)).max(60),
    template: z.enum(TEMPLATES),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    labels: z.record(z.string(), z.string().max(120)),
    events: z.array(TimelineEventSchema).max(80),
    popups: z.array(PopupSchema).max(20),
  })
  .partial()
  .strict();
export type SlideEdit = z.infer<typeof SlideEditSchema>;

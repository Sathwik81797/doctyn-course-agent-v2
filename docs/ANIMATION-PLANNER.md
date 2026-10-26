# Animation planner — any medical topic, deterministic first, AI optional

For every slide the planner reads the PPTX text and the DOCX narration, decides what kind of explanation the slide is, and fills a
reusable medical component with the slide's **own words**. It writes no medical content of its own.

## Selection order

1. **Authored scene** for the diabetes course (matched by slide number *and* title; unchanged, so that video re-renders identically).
2. **Specialised mechanism** (GLUT-4 uptake, visceral fat, continuum) when its strong signals are present.
3. **Reusable component**, chosen by structure (`src/animation/scene/derive.ts`), highest score wins:

| Slide looks like | Component | Category |
|---|---|---|
| cause → effect chain ("leads to", "resulting in", bullets in sequence) | `pathway` | pathophysiology / physiology |
| a list of contributors to one conclusion (risk factors, causes) | `converge` | physiology |
| organs named with anatomical wording | `organ-map` (schematic markers on a body outline) | anatomy |
| a test whose high / low result is interpreted | `lab-branch` (gauge → meaning) | laboratory |
| two things contrasted (whereas / versus / unlike) | `compare` (two columns, row by row) | comparison |
| several time points (within minutes, 24 hours, weeks…) | `timeline` | timeline |
| ordered steps and "if…" decisions (First, Next, If, Finally) | `workflow` (steps + decision shapes) | treatment algorithm / diagnostic workflow |
| a patient case (58-year-old, presents with) | `case` (patient · findings · interpretation) | clinical case |

4. **Key-points cards** only when nothing above reaches its threshold (introductions, summaries).

Each plan records `analysis` (category, topic, objective, mechanism) next to the template; the dashboard shows it.

## How labels and timing are produced

* Labels are fragments of the slide bullets or the narration, cut at clause boundaries (`Head|detail`). A test fails if any label
  contains a word that is not in the slide's source (organ names and the three case panel titles excepted).
* Each element is anchored to a phrase of the narration (unique phrases preferred) so it appears as the voice reaches it; elements
  without a cue are placed by position. Timings come from the real audio duration.
* What a component adds is **structure only** (arrows, a gauge needle, a body outline). Each such device is listed as a
  `template-assumption` flag the reviewer must acknowledge. Numbers, doses, drugs and glossary pop-ups are flagged too.

## Editing before the MP4

In the dashboard's slide editor: a live preview (the same renderer that draws the MP4, scrub the slider), the animation type
(switching re-derives the scene from the slide), on-screen labels, overlay text, pop-ups and every timing. Any change withdraws
approval. Nothing is approved automatically; the final (non-watermarked) render is refused until a clinician approves each slide.

## AI planning (optional, off by default)

`ANIMATION_AI=true` and `OPENAI_API_KEY` in the engine's `.env` (or `npm run animate -- analyze --ai`). The model returns only the
template, category/topic/objective/mechanism and up to two glossary-style pop-ups; it cannot place elements or write labels. A
template the slide cannot fill (not enough matching text) is ignored, and any per-slide failure falls back to the deterministic plan.
Model: `ANIMATION_AI_MODEL` (default `gpt-4o-mini`). Cost is a few thousand tokens per slide — on the order of a cent or two per
52-slide course; check current OpenAI pricing.

## Limits

* Rule-based recognition reads English text and the patterns above; a slide that mixes several structures gets the strongest one.
* `organ-map` knows 11 organs at standard schematic positions (patient facing the viewer); anything else is not drawn.
* `pathway` shows up to 5 steps, `timeline` 4 points, `workflow` 6 steps, `compare` 4 rows, `converge` 6 contributors, `case` 3 panels.
  Extra material stays in the narration and pop-ups.
* The scenes are structural diagrams, not anatomical or pharmacological illustrations. The software flags AI-derived wording and
  gates publication on a reviewer's approval; it cannot judge clinical correctness.

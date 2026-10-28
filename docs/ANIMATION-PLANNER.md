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

## Reading the slide's own layout (added after the Sepsis demo)

A designed PPTX carries more structure than a flat text list. The planner now reads it (`scene/structure.ts`):

* Lines repeated on 40% or more of the slides (brand line, "Educational demonstration only…") and counters such as `03/09` are
  layout, never content. Soft line breaks (`<a:br/>`) split into separate lines.
* Numbered boxes and arrows (`01 → 02 → 03`) mark a sequence. It becomes a **pathway** (cause → effect), a **workflow**
  (title says assess / respond / manage / escalate…) or, when the slide or narration says the actions happen together
  ("parallel", "together"), items **converging** on one outcome, drawn side by side with no order implied.
* ALL-CAPS headings (CLINICAL PRESENTATION, RESPONSE PATHWAY) become the panels of a **patient case**; the line under the title is
  the subtitle and becomes the take-home note / conclusion.
* A short bullet list under a heading becomes contributors → conclusion, or ordered steps when the heading is procedural.
  Opening slides ("Welcome…", "Overview") are never read as a list.
* If the narration mentions the steps in a different order than the slide lists them, the cues are dropped and the steps are
  spread over the first part of the narration in the slide's order, so the diagram never piles up at the end.
* Pictograms (infection, inflammation, vessels, lungs, brain, kidney, heart, pressure gauge, flask, thermometer, drop, pulse, alert,
  person) are chosen from a label's own words. They are symbols, not anatomy, and are listed as template assumptions.

A slide that still ends up with generic key-point cards is **flagged** (`generic-animation` flag, a "generic" badge in the slide
list, an "Animation overview" panel of thumbnails in the editor, and a line on the video card such as "8 of 9 slides have a
topic-specific scene; generic key-point cards on slide 1"). In Generated Videos the **Enhanced animated draft** is the first and
default version; **Original narrated slides** is the optional second one. The enhanced video is rendered automatically right
after the narrated one; nothing has to be clicked.

Run any deck through the whole pipeline on this PC (Kokoro voice, nothing uploaded anywhere) and measure the motion:
`npm run cloud:demo -- slides.pptx voiceover.docx --out output/<folder>`.

## Limits

* Rule-based recognition reads English text and the patterns above; a slide that mixes several structures gets the strongest one.
* `organ-map` knows 11 organs at standard schematic positions (patient facing the viewer); anything else is not drawn.
* `pathway` shows up to 5 steps, `timeline` 4 points, `workflow` 6 steps, `compare` 4 rows, `converge` 6 contributors, `case` 3 panels.
  Extra material stays in the narration and pop-ups.
* **These scenes do not match the custom diabetes animations.** The diabetes video has hand-built illustrations (muscle cell, GLUT4,
  β-cell, OGTT curves, HOMA-IR scale…). A new topic gets structured clinical diagrams — flows, converging factors, steps, a case
  board, timelines, comparisons, organ markers — with symbolic icons and synchronised build-up. Bespoke mechanism artwork for a
  new topic still has to be authored.
* A cover slide, or a slide whose content is a free paragraph, still gets generic cards (and is flagged).
* The scenes are structural diagrams, not anatomical or pharmacological illustrations. The software flags AI-derived wording and
  gates publication on a reviewer's approval; it cannot judge clinical correctness.

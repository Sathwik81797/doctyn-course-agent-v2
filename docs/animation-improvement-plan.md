# Animation improvement plan — Risk Factors for Diabetes (52 slides)

## Where things stand

| | Slides |
|---|---|
| Topic-specific mechanism animation (existing) | 3 continuum · 12 visceral fat · 14, 16 muscle glucose uptake (4) |
| **Generic `key-points` cards** | **48 slides**: 1, 2, 4–11, 13, 15, 17–52 (slide 16 was already specialised) |
| Clinically approved | 0 / 52 |

The existing draft MP4 (`animation/animated-video.draft.mp4`, 15m 15s) is kept untouched.

## Approach

* The 48 generic slides are grouped by **clinical topic**, and each group gets a purpose-built scene.
* **No new clinical claims are authored.** On-screen wording comes from the slide text and narration. What the scene adds is
  *visual structure* (balance, body map, gauge, curves, timeline, flow chart). Each such device is flagged
  `template-assumption` so the clinician must acknowledge it.
* Every element is anchored to a phrase in the narration; every label is editable in the studio; every slide stays
  `needs_review` until a named clinician approves it.
* Nothing is rendered as "final" until approved. Unchanged slides (3, 12, 14, 16) re-use their existing segments.

## New scene templates → slides

| Template | What it shows | Slides |
|---|---|---|
| `pathway` | Cause → consequence chain with flowing particles, optional stat ring / big number | 1, 2, 7, 17, 18, 20, 21 |
| `converge` | Several contributors feeding one clinical conclusion, ↑/↓ trend glyphs | 6, 10, 11, 15, 22, 28, 29, 52 |
| `balance` | Tilting scale: insulin resistance vs β-cell reserve | 4, 5 |
| `body` | Body silhouette with organ / fat / muscle / waist call-outs | 8, 9, 13 |
| `lab-branch` | Test → gauge needle swings high / low → meaning | 23, 25 |
| `homa` | HOMA-IR formula assembling, result scale with the source's 2 and 3 markers | 24 |
| `ogtt` | Three glucose-vs-time panels (illustrative) for fasting / 2-h patterns | 26 |
| `ladder` | Staircase of metabolic stages with the finding that defines each | 27 |
| `timeline` | GDM → postpartum OGTT → lifelong screening, persistent-risk band | 19 |
| `case` | Case board: patient figure (lean / average / obese), lab chips with HIGH / LOW tags, interpretation, plan | 30–45 (16) |
| `algorithm` | Six-step progress rail + step detail cards / branches | 46–51 (6) |

## Slides that cannot get a *mechanistic* animation

These get structured, narration-synchronised visuals but no physiology — the content is a list or instruction, not a mechanism:

* **1** (title) · **47** (two tests to order) · **52** (take-home messages)
* **37, 41, 45** (management lists) — shown as `case` plan checklists

## Review items for the clinician (beyond per-slide flags)

1. Deck has Steps 1, 2, 4, 5, 6 — slide 48 ("Interpret Results") is **inferred** to be Step 3 (it points to Step 4).
2. Slide 2: "≈50 % of β-cell function lost at fasting glucose ≥126 mg/dL" is stated in the source; the ring only visualises that number.
3. Slide 24: HOMA-IR units are "as shown in the source"; markers at 2 and 3 are the source's.
4. Slide 26: curves are *illustrative shapes*, not patient data.
5. Narration timing uses estimated word timings (≈ ±0.25 s), not forced alignment.

## Process

1. `npm run animate -- analyze --force` (baseline plan backed up first) → new plan, all slides `needs_review`.
2. Preview stills + contact sheet: `output/<slug>/animation/preview/`.
3. Review / edit in the studio (`npm run dashboard` → `#/studio`) and approve each slide.
4. `npm run animate -- render --enhanced` writes **a separate** `animation/enhanced/` MP4; the old one is never overwritten.

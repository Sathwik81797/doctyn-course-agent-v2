/**
 * Frame renderer: (slide plan, time) -> SVG string. Pure and deterministic, no Node or DOM
 * dependencies, so the browser preview and the MP4 renderer draw identical frames.
 */
import type { Popup, SlidePlan, TemplateId } from "../types.js";
import { C, FONT, H, W, clamp01, ease, esc, fx, lerp, multiline, pulseAmount, showProgress, text, wrap } from "./kit.js";
import type { Ctx, ElementSpec, SceneInput, TemplateDef } from "./kit.js";
import { MEDICAL_TEMPLATES } from "./medical.js";
import { sentenceWindows, wordTimings, LEAD_IN, TAIL } from "./timing.js";

export { H, W, esc, wrap, showProgress, pulseAmount };
export type { ElementSpec, SceneInput };

export interface RenderOptions {
  /** Burned-in banner for content that has not been clinically approved. */
  watermark?: string;
  /** Show the narration caption bar (default true). */
  captions?: boolean;
}

// ---------- template: glucose uptake ----------
const GLUCOSE_ELEMENTS: ElementSpec[] = [
  { id: "blood", label: "Bloodstream", cues: [], dur: 0.8, description: "Bloodstream with circulating glucose" },
  { id: "muscle", label: "Skeletal muscle cell", cues: [], dur: 0.8, description: "Muscle cell (glucose sink)" },
  { id: "betaCell", label: "Pancreatic beta cell", cues: [], after: "muscle", gap: 0.2, dur: 0.8, description: "Beta cell appears" },
  { id: "insulin", label: "Insulin", cues: ["post-meal glucose", "glucose uptake"], after: "betaCell", gap: 0.3, dur: 1.0, frac: 0.12, description: "Insulin released and travels to muscle" },
  { id: "receptor", label: "Insulin receptor binds", cues: ["insulin receptor"], after: "insulin", gap: 0.2, dur: 0.8, frac: 0.25, description: "Insulin binds receptors" },
  { id: "glut4", label: "GLUT4 moves to membrane", cues: [], after: "receptor", gap: 0.1, dur: 1.2, frac: 0.38, description: "GLUT4 vesicles translocate to the membrane" },
  { id: "uptake", label: "Glucose enters the cell", cues: [], after: "glut4", gap: 0.1, dur: 1.0, frac: 0.5, description: "Glucose uptake through GLUT4" },
  { id: "sink", label: "Low muscle mass: smaller glucose sink", cues: ["muscle mass is low", "low muscle mass"], dur: 1.4, optional: true, description: "Muscle mass falls: glucose sink shrinks" },
  { id: "rise", label: "Post-prandial glucose rises", cues: ["glucose can rise", "post-prandial glucose", "glucose rise", "hyperglyc"], dur: 1.4, optional: true, description: "Blood glucose rises" },
  { id: "demand", label: "Insulin demand rises", cues: ["insulin demand"], dur: 1.2, optional: true, description: "Beta cell must secrete more insulin" },
];

function drawGlucoseUptake(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const blood = c.p("blood");
  const muscleP = c.p("muscle");
  const sink = c.p("sink");
  const rise = c.p("rise");
  const demand = c.p("demand");
  const reduced = c.param("reducedGlut4", false);
  const resistant = c.param("resistant", false);

  // bloodstream band
  s.push(`<g opacity="${fx(blood)}">`);
  s.push(`<rect x="90" y="175" width="1740" height="150" rx="75" fill="${C.blood}" opacity=".55"/>`);
  s.push(text(420, 212, c.label("blood", "Bloodstream"), 26, C.dim, { weight: 600 }));
  const nGlu = Math.round(12 + 14 * rise);
  for (let i = 0; i < nGlu; i++) {
    const x = 110 + ((i * 197 + t * (60 + (i % 3) * 14)) % 1700);
    const y = 235 + ((i * 41) % 70);
    s.push(`<circle cx="${fx(x)}" cy="${fx(y)}" r="11" fill="${C.glucose}"/>`);
  }
  s.push(`</g>`);

  // muscle cell geometry shrinks with "sink"
  const cx = 1000;
  const halfW = lerp(560, 360, sink);
  const top = 560;
  const bottom = lerp(860, 780, sink);
  s.push(`<g opacity="${fx(muscleP)}">`);
  s.push(`<rect x="${fx(cx - halfW)}" y="${top}" width="${fx(halfW * 2)}" height="${fx(bottom - top)}" rx="46" fill="${C.muscle}" opacity=".85"/>`);
  for (let i = 1; i < 6; i++) {
    const y = top + ((bottom - top) / 6) * i;
    s.push(`<line x1="${fx(cx - halfW + 36)}" y1="${fx(y)}" x2="${fx(cx + halfW - 36)}" y2="${fx(y)}" stroke="#00000033" stroke-width="3"/>`);
  }
  s.push(`<line x1="${fx(cx - halfW + 20)}" y1="${top}" x2="${fx(cx + halfW - 20)}" y2="${top}" stroke="${C.ink}" stroke-width="6" opacity=".8"/>`);
  s.push(text(cx, bottom + 38, c.label("muscle", "Skeletal muscle cell"), 26, C.dim, { anchor: "middle", weight: 600 }));
  s.push(`</g>`);

  const sites = [-0.5, 0, 0.5].map((f) => cx + f * halfW * 1.55);
  const receptorP = c.p("receptor");
  const glutP = c.p("glut4");
  const uptakeP = c.p("uptake");
  const insulinP = c.p("insulin");

  // beta cell
  const bx = 250;
  const by = 250;
  const bp = c.p("betaCell");
  const bPulse = Math.max(c.pulse("betaCell"), demand * (0.5 + 0.5 * Math.sin(t * 5)));
  s.push(`<g opacity="${fx(bp)}">`);
  s.push(`<circle cx="${bx}" cy="${by}" r="${fx(66 + 8 * bPulse)}" fill="${C.insulin}" opacity=".25"/>`);
  s.push(`<circle cx="${bx}" cy="${by}" r="58" fill="#1D5FA8" stroke="${C.insulin}" stroke-width="5"/>`);
  s.push(`<circle cx="${bx - 14}" cy="${by - 8}" r="14" fill="#0E3A6B"/>`);
  s.push(text(bx, by + 110, c.label("betaCell", "Pancreatic beta cell"), 24, C.dim, { anchor: "middle", weight: 600 }));
  s.push(`</g>`);
  if (demand > 0.02) s.push(text(bx, by - 86, c.label("demand", "Insulin demand ↑"), 28, C.insulin, { anchor: "middle", weight: 700, opacity: demand }));

  // receptors
  sites.forEach((x, i) => {
    const bound = receptorP > 0.5 + i * 0.1 ? 1 : 0;
    s.push(`<g opacity="${fx(muscleP)}">`);
    s.push(`<path d="M ${fx(x - 16)} ${top - 30} L ${fx(x)} ${top - 4} L ${fx(x + 16)} ${top - 30}" stroke="${bound ? C.insulin : "#C9D6E8"}" stroke-width="7" fill="none" stroke-linecap="round"/>`);
    if (bound) s.push(`<circle cx="${fx(x)}" cy="${top - 18}" r="${fx(26 + 6 * Math.sin(t * 6))}" fill="none" stroke="${C.insulin}" stroke-width="3" opacity=".7"/>`);
    s.push(`</g>`);
  });
  if (receptorP > 0.05) s.push(text(sites[0]! - 50, top - 20, c.label("receptor", "Insulin receptor binds"), 24, C.insulin, { anchor: "end", weight: 600, opacity: receptorP }));

  // insulin particles
  if (insulinP > 0.02) {
    const n = 3 + Math.round(6 * demand);
    for (let k = 0; k < n; k++) {
      const phase = (((t * 0.28 + k / n) % 1) + 1) % 1;
      const target = sites[k % 3]!;
      let x: number;
      let y: number;
      if (phase < 0.6) {
        const u = ease(phase / 0.6);
        x = lerp(bx + 60, target, u);
        y = 250 + Math.sin(u * 6 + k) * 14;
      } else {
        const u = ease((phase - 0.6) / 0.4);
        x = target;
        y = lerp(250, top - 36, u);
      }
      s.push(`<path d="M ${fx(x)} ${fx(y - 12)} L ${fx(x + 11)} ${fx(y)} L ${fx(x)} ${fx(y + 12)} L ${fx(x - 11)} ${fx(y)} Z" fill="${C.insulin}" opacity="${fx(insulinP)}"/>`);
    }
    s.push(text(760, 380, c.label("insulin", "Insulin"), 24, C.insulin, { weight: 700, opacity: insulinP }));
  }

  // GLUT4 vesicles rise to the membrane
  sites.forEach((x, i) => {
    const active = reduced ? i === 1 : true;
    const k = active ? glutP : 0;
    const y = lerp(top + 140 + (i % 2) * 40, top + 2, k);
    const resting = !active;
    if (muscleP < 0.05) return;
    s.push(`<g opacity="${fx(muscleP)}">`);
    if (k > 0.95) {
      s.push(`<rect x="${fx(x - 14)}" y="${top - 6}" width="28" height="22" rx="6" fill="${C.green}"/>`);
    } else {
      s.push(`<circle cx="${fx(x)}" cy="${fx(y)}" r="22" fill="${resting ? "#6A7A8C" : C.green}" opacity=".9"/>`);
    }
    s.push(`</g>`);
  });
  if (glutP > 0.05) s.push(text(sites[2]! + 40, top + 90, c.label("glut4", "GLUT4 moves to membrane"), 24, C.green, { weight: 700, opacity: glutP }));

  // glucose entering through GLUT4
  if (uptakeP > 0.02) {
    const flow = 1 - 0.55 * sink;
    const n = Math.max(1, Math.round(6 * flow));
    sites.forEach((x, i) => {
      if (reduced && i !== 1) return;
      for (let k = 0; k < n; k++) {
        const phase = (((t * 0.35 * flow + k / n + i * 0.17) % 1) + 1) % 1;
        const y = lerp(335, top + 120, phase);
        s.push(`<circle cx="${fx(x + Math.sin(phase * 9) * 5)}" cy="${fx(y)}" r="10" fill="${C.glucose}" opacity="${fx(uptakeP * (phase > 0.9 ? 1 - (phase - 0.9) * 10 : 1))}"/>`);
      }
    });
  }

  // uptake meter (right)
  if (uptakeP > 0.02) {
    const mx = 1640;
    const my = 340;
    const mh = 300;
    const frac = 0.7 * (1 - 0.35 * sink);
    s.push(`<g opacity="${fx(uptakeP)}">`);
    s.push(`<rect x="${mx}" y="${my}" width="70" height="${mh}" rx="14" fill="#FFFFFF18" stroke="${C.dim}" stroke-width="2"/>`);
    s.push(`<rect x="${mx}" y="${fx(my + mh * (1 - frac * uptakeP))}" width="70" height="${fx(mh * frac * uptakeP)}" rx="14" fill="${sink > 0.5 ? C.glucose : C.teal}"/>`);
    s.push(text(mx + 35, my - 24, sink > 0.5 ? "↓ sink" : "~70%", 40, sink > 0.5 ? C.glucose : C.teal, { anchor: "middle", weight: 800 }));
    s.push(multiline(mx + 35, my + mh + 40, wrap(c.label("uptake", "Glucose enters the cell"), 14), 22, C.dim, { anchor: "middle", weight: 600 }));
    s.push(`</g>`);
  }
  if (rise > 0.05) s.push(text(1760, 160, c.label("rise", "Post-prandial glucose rises"), 26, C.glucose, { anchor: "end", weight: 700, opacity: rise }));
  if (sink > 0.05) s.push(text(cx, top - 96, c.label("sink", "Low muscle mass: smaller glucose sink"), 28, C.red, { anchor: "middle", weight: 700, opacity: sink }));
  if (resistant) s.push(text(cx, 540, "Insulin resistance", 24, C.red, { anchor: "middle", weight: 700 }));
  return s.join("");
}

// ---------- template: visceral fat ----------
const VISCERAL_ELEMENTS: ElementSpec[] = [
  { id: "fat", label: "Visceral fat", cues: ["visceral fat"], dur: 0.9, frac: 0.0, description: "Visceral (central) fat depot" },
  { id: "ffa", label: "Free fatty acids", cues: ["free fatty acids"], after: "fat", gap: 0.3, dur: 1.2, frac: 0.1, description: "Free fatty acids released into portal vein" },
  { id: "liver", label: "Liver", cues: ["portal circulation", "portal"], after: "ffa", gap: 0.4, dur: 1.0, frac: 0.2, description: "Liver receives FFAs" },
  { id: "gluco", label: "↑ Hepatic gluconeogenesis", cues: ["hepatic gluconeogenesis", "gluconeogenesis"], after: "liver", gap: 0.4, dur: 1.2, frac: 0.35, description: "Liver makes more glucose" },
  { id: "cytokines", label: "Inflammatory cytokines", cues: ["inflammatory cytokines", "cytokines"], after: "gluco", gap: 0.4, dur: 1.2, frac: 0.55, description: "Cytokines released from fat" },
  { id: "result", label: "Profound insulin resistance", cues: ["profound insulin resistance", "insulin resistance"], after: "cytokines", gap: 0.5, dur: 1.2, frac: 0.7, description: "Result banner" },
  { id: "bmi", label: "BMI alone can miss central fat", cues: ["BMI alone", "BMI"], dur: 1.2, optional: true, description: "BMI caveat chip" },
];

function bezier(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], u: number): [number, number] {
  const a = 1 - u;
  return [
    a * a * a * p0[0] + 3 * a * a * u * p1[0] + 3 * a * u * u * p2[0] + u * u * u * p3[0],
    a * a * a * p0[1] + 3 * a * a * u * p1[1] + 3 * a * u * u * p2[1] + u * u * u * p3[1],
  ];
}

function drawVisceral(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const fat = c.p("fat");
  const ffa = c.p("ffa");
  const liver = c.p("liver");
  const gluco = c.p("gluco");
  const cyt = c.p("cytokines");
  const result = c.p("result");
  const bmi = c.p("bmi");
  const P0: [number, number] = [380, 470];
  const P1: [number, number] = [600, 470];
  const P2: [number, number] = [650, 420];
  const P3: [number, number] = [880, 420];

  // fat depot
  s.push(`<g opacity="${fx(fat)}">`);
  const blobs: Array<[number, number, number]> = [[230, 440, 80], [310, 500, 70], [180, 530, 62], [270, 380, 64], [340, 420, 56], [220, 600, 56], [310, 590, 52]];
  for (const [x, y, r] of blobs) s.push(`<circle cx="${x}" cy="${y}" r="${fx(r * (0.97 + 0.03 * Math.sin(t * 2 + x)))}" fill="${C.fat}" opacity=".9" stroke="#C9A227" stroke-width="3"/>`);
  s.push(text(250, 700, c.label("fat", "Visceral fat"), 30, C.fat, { anchor: "middle", weight: 700 }));
  s.push(`</g>`);

  // portal vein
  if (ffa > 0.02) {
    s.push(`<path d="M ${P0[0]} ${P0[1]} C ${P1[0]} ${P1[1]}, ${P2[0]} ${P2[1]}, ${P3[0]} ${P3[1]}" stroke="${C.blood}" stroke-width="26" fill="none" stroke-linecap="round" opacity="${fx(ffa)}"/>`);
    for (let k = 0; k < 9; k++) {
      const u = (((t * 0.22 + k / 9) % 1) + 1) % 1;
      const [x, y] = bezier(P0, P1, P2, P3, u);
      s.push(`<ellipse cx="${fx(x)}" cy="${fx(y)}" rx="11" ry="8" fill="${C.fat}" opacity="${fx(ffa)}"/>`);
    }
    s.push(text(620, 540, c.label("ffa", "Free fatty acids"), 26, C.fat, { anchor: "middle", weight: 700, opacity: ffa }));
    s.push(text(620, 574, "via the portal circulation", 22, C.dim, { anchor: "middle", opacity: liver }));
  }

  // liver
  if (liver > 0.02) {
    s.push(`<g opacity="${fx(liver)}">`);
    s.push(`<path d="M 880 380 C 900 270, 1100 250, 1280 300 C 1380 330, 1390 430, 1300 500 C 1180 580, 960 560, 900 480 C 880 450, 870 410, 880 380 Z" fill="${C.liver}" stroke="#C98C62" stroke-width="5"/>`);
    s.push(text(1110, 420, c.label("liver", "Liver"), 34, C.ink, { anchor: "middle", weight: 700 }));
    s.push(`</g>`);
  }
  if (gluco > 0.02) {
    for (let k = 0; k < 7; k++) {
      const u = (((t * 0.3 + k / 7) % 1) + 1) % 1;
      const x = 1000 + k * 55;
      const y = lerp(270, 150, u);
      s.push(`<circle cx="${fx(x)}" cy="${fx(y)}" r="11" fill="${C.glucose}" opacity="${fx(gluco * (1 - u))}"/>`);
    }
    s.push(text(1110, 215, c.label("gluco", "↑ Hepatic gluconeogenesis"), 28, C.glucose, { anchor: "middle", weight: 700, opacity: gluco }));
  }

  // cytokines -> tissue with blocked insulin signalling
  if (cyt > 0.02) {
    const tx = 1560;
    const ty = 560;
    s.push(`<g opacity="${fx(cyt)}">`);
    s.push(`<rect x="${tx - 140}" y="${ty - 60}" width="280" height="150" rx="30" fill="${C.muscle}" opacity=".85"/>`);
    s.push(text(tx, ty + 8, "Muscle / liver cell", 24, C.ink, { anchor: "middle", weight: 600 }));
    s.push(`<path d="M ${tx - 20} ${ty - 90} l 40 -30 M ${tx + 20} ${ty - 90} l -40 -30" stroke="${C.red}" stroke-width="7" stroke-linecap="round"/>`);
    s.push(text(tx, ty + 60, "insulin signalling blocked", 22, C.red, { anchor: "middle", weight: 700 }));
    s.push(`</g>`);
    for (let k = 0; k < 6; k++) {
      const u = (((t * 0.18 + k / 6) % 1) + 1) % 1;
      const [x, y] = bezier([360, 400], [700, 250], [1200, 900], [tx - 60, ty - 70], u);
      s.push(`<path d="M ${fx(x)} ${fx(y - 13)} l 4 9 l 10 1 l -8 7 l 2 10 l -8 -6 l -8 6 l 2 -10 l -8 -7 l 10 -1 Z" fill="${C.purple}" opacity="${fx(cyt)}"/>`);
    }
    s.push(text(900, 770, c.label("cytokines", "Inflammatory cytokines"), 26, C.purple, { anchor: "middle", weight: 700, opacity: cyt }));
  }

  if (bmi > 0.02) {
    s.push(`<g opacity="${fx(bmi)}">`);
    s.push(`<rect x="90" y="790" width="560" height="64" rx="32" fill="#FFFFFF1F" stroke="${C.dim}" stroke-width="2"/>`);
    s.push(text(370, 832, c.label("bmi", "BMI alone can miss central fat"), 26, C.ink, { anchor: "middle", weight: 600 }));
    s.push(`</g>`);
  }

  if (result > 0.02) {
    s.push(`<g opacity="${fx(result)}"><rect x="460" y="800" width="1060" height="70" rx="35" fill="${C.red}"/>`);
    s.push(text(990, 847, "RESULT  →  " + c.label("result", "Profound insulin resistance").toUpperCase(), 32, "#FFFFFF", { anchor: "middle", weight: 800 }));
    s.push(`</g>`);
  }
  return s.join("");
}

// ---------- template: continuum ----------
const STAGE_NAMES = ["Normal glucose tolerance", "Compensated insulin resistance", "Prediabetes", "Overt diabetes", "Insulin-dependent diabetes"];
const STAGE_COLORS = ["#3DDC97", "#C6D84B", "#FFB84D", "#FF7A59", "#E8505B"];
const STAGE_TAGS = ["Glucose and insulin normal", "Insulin ↑ to compensate", "Dysglycaemia", "Hyperglycaemia", "C-peptide ↓"];
const STAGE_CUES = [
  ["normal glucose tolerance", "normal"],
  ["compensated insulin resistance", "compensated"],
  ["prediabetes"],
  ["overt diabetes", "overt"],
  ["insulin-dependent diabetes", "insulin dependent", "insulin-dependent"],
];

const CONTINUUM_ELEMENTS: ElementSpec[] = [
  ...STAGE_NAMES.map<ElementSpec>((name, i) => ({
    id: `stage${i + 1}`,
    label: name,
    cues: STAGE_CUES[i]!,
    ...(i > 0 ? { after: `stage${i}`, gap: 0.5 } : {}),
    dur: 0.9,
    frac: 0.02 + i * 0.13,
    description: `Stage ${i + 1}: ${name}`,
  })),
  { id: "signatures", label: "Each stage has distinct laboratory signatures", cues: ["laboratory signatures", "distinct laboratory"], maxGap: 99, after: "stage5", gap: 0.4, dur: 1.4, frac: 0.8, description: "Laboratory signature tags per stage" },
];

function drawContinuum(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const x0 = 110;
  const w = 340;
  let reveal = 0;
  STAGE_NAMES.forEach((name, i) => {
    const p = c.p(`stage${i + 1}`);
    reveal += p;
    const x = x0 + i * (w + 15);
    const pulse = c.pulse(`stage${i + 1}`);
    s.push(`<g opacity="${fx(p)}" transform="translate(0 ${fx((1 - p) * 20)})">`);
    s.push(`<path d="M ${x} 190 L ${x + w - 30} 190 L ${x + w} 250 L ${x + w - 30} 310 L ${x} 310 L ${x + 30} 250 Z" fill="${STAGE_COLORS[i]}" opacity="${fx(0.85 + 0.15 * pulse)}"/>`);
    const lines = wrap(c.label(`stage${i + 1}`, name), 18);
    s.push(multiline(x + w / 2 + 6, 245 - (lines.length - 1) * 14, lines, 27, "#0A1B33", { anchor: "middle", weight: 800 }));
    s.push(`</g>`);
  });

  // chart
  const cx0 = x0;
  const cx1 = x0 + 5 * (w + 15) - 15;
  const cy0 = 400;
  const cy1 = 800;
  s.push(`<line x1="${cx0}" y1="${cy1}" x2="${cx1}" y2="${cy1}" stroke="${C.dim}" stroke-width="3"/>`);
  s.push(`<line x1="${cx0}" y1="${cy0}" x2="${cx0}" y2="${cy1}" stroke="${C.dim}" stroke-width="3"/>`);
  s.push(text(cx0 + 10, cy0 - 12, "Relative level (illustrative)", 22, C.dim, { italic: true }));
  const rx = cx0 + (reveal / 5) * (cx1 - cx0);
  const curve = (pts: number[]): string => {
    const n = pts.length;
    return pts
      .map((v, i) => `${i === 0 ? "M" : "L"} ${fx(cx0 + ((cx1 - cx0) * i) / (n - 1))} ${fx(cy1 - v * (cy1 - cy0 - 20))}`)
      .join(" ");
  };
  const series: Array<{ name: string; color: string; pts: number[]; ly: number }> = [
    { name: "Insulin resistance", color: C.glucose, pts: [0.12, 0.35, 0.55, 0.7, 0.8, 0.85, 0.88, 0.9], ly: 0 },
    { name: "Insulin secretion (β-cell reserve)", color: C.insulin, pts: [0.2, 0.45, 0.7, 0.72, 0.5, 0.3, 0.12, 0.05], ly: 1 },
    { name: "Glycaemia", color: C.red, pts: [0.1, 0.1, 0.12, 0.2, 0.45, 0.7, 0.85, 0.95], ly: 2 },
  ];
  s.push(`<clipPath id="rv"><rect x="${cx0}" y="${cy0 - 10}" width="${fx(Math.max(0, rx - cx0))}" height="${cy1 - cy0 + 20}"/></clipPath>`);
  for (const se of series) {
    s.push(`<path d="${curve(se.pts)}" stroke="${se.color}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#rv)"/>`);
    s.push(`<circle cx="${cx0 + 640 + se.ly * 380}" cy="${cy0 - 20}" r="9" fill="${se.color}"/>`);
    s.push(text(cx0 + 658 + se.ly * 380, cy0 - 12, se.name, 21, C.ink, { weight: 600 }));
  }
  if (reveal > 0.05 && reveal < 4.98) {
    s.push(`<line x1="${fx(rx)}" y1="${cy0}" x2="${fx(rx)}" y2="${cy1}" stroke="#FFFFFF" stroke-width="3" stroke-dasharray="10 8" opacity="${fx(0.6 + 0.3 * Math.sin(t * 6))}"/>`);
  }

  // lab signature tags
  const sig = c.p("signatures");
  if (sig > 0.02) {
    STAGE_TAGS.forEach((tag, i) => {
      const x = x0 + i * (w + 15);
      const label = c.label(`stage${i + 1}.tag`, tag);
      s.push(`<g opacity="${fx(sig)}" transform="translate(0 ${fx((1 - sig) * 14)})">`);
      s.push(`<rect x="${x + 10}" y="830" width="${w - 20}" height="52" rx="26" fill="#FFFFFF1F" stroke="${STAGE_COLORS[i]}" stroke-width="3"/>`);
      s.push(text(x + w / 2, 864, label, 22, C.ink, { anchor: "middle", weight: 600 }));
      s.push(`</g>`);
    });
  }
  return s.join("");
}

// ---------- template: key points (generic fallback) ----------
const FOOTER_RE = /risk factors for diabetes\s*[•·|]|^[•·|\-–—→←↑↓⇒➜>\s]*$/i;

export interface Card {
  heading: string;
  body: string;
  badge: string;
}

/** Turn the PPTX text blocks into cards: drops footer/page number/title, pairs CAPS headings with sub-lines. */
export function deriveCards(slideText: string[], title: string, slide: number): Card[] {
  const norm = (x: string): string => x.replace(/\s+/g, " ").trim().toLowerCase();
  // the slide's own page number appears twice, e.g. "03" (badge) and "3" (footer); for 10+ both forms are identical
  const numberLabels = [String(slide).padStart(2, "0"), String(slide)];
  const blocks: string[] = [];
  for (const raw of slideText) {
    const b = raw.trim();
    if (!b || FOOTER_RE.test(b) || norm(b) === norm(title)) continue;
    const at = numberLabels.indexOf(b);
    if (at >= 0) {
      numberLabels.splice(at, 1);
      continue;
    }
    blocks.push(b);
  }
  const isStep = (b: string): boolean => /^0\d$/.test(b);
  const isCaps = (b: string): boolean => b.length <= 48 && b === b.toUpperCase() && /[A-Z]/.test(b);
  const cards: Card[] = [];
  let badge = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (isStep(b)) {
      badge = b;
      continue;
    }
    const next = blocks[i + 1];
    const nextIsBody = next !== undefined && !isStep(next) && !isCaps(next);
    if (isCaps(b) && nextIsBody) {
      cards.push({ heading: b, body: next, badge });
      i++;
    } else if (badge && !isCaps(b) && nextIsBody && b.length <= 36 && next.length <= 60) {
      cards.push({ heading: b, body: next, badge });
      i++;
    } else cards.push({ heading: isCaps(b) ? b : "", body: isCaps(b) ? "" : b, badge });
    badge = "";
  }
  return cards.slice(0, 8);
}

function keyPointElements(plan: SceneInput): ElementSpec[] {
  const cards = deriveCards(plan.slideText, plan.title, plan.slide);
  return cards.map<ElementSpec>((card, i) => {
    const phrase = (card.heading || card.body).replace(/[→↑↓~%]/g, " ").replace(/\s+/g, " ").trim();
    const words = phrase.split(" ");
    const cues = [phrase, words.slice(0, 2).join(" "), words[0] ?? ""].filter((x) => x.length >= 4);
    return {
      id: `card${i + 1}`,
      label: card.heading || card.body,
      cues: [...new Set(cues.map((x) => x.toLowerCase()))],
      ...(i > 0 ? { after: `card${i}`, gap: 0.3 } : {}),
      dur: 0.8,
      frac: i / Math.max(1, cards.length),
      description: `Concept ${i + 1}: ${(card.heading || card.body).slice(0, 40)}`,
    };
  });
}

function drawKeyPoints(c: Ctx): string {
  const cards = deriveCards(c.plan.slideText, c.plan.title, c.plan.slide);
  const s: string[] = [];
  if (cards.length === 0) {
    s.push(multiline(960, 460, wrap(c.plan.title, 34), 64, C.ink, { anchor: "middle", weight: 700 }));
    return s.join("");
  }
  const n = cards.length;
  const cols = n <= 3 ? n : n <= 4 ? 4 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const gx = 36;
  const cw = Math.min(520, (1700 - gx * (cols - 1)) / cols);
  const ch = rows === 1 ? 300 : 250;
  const totalW = cols * cw + (cols - 1) * gx;
  const sx = (W - totalW) / 2;
  const sy = rows === 1 ? 330 : 230;
  cards.forEach((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = sx + col * (cw + gx);
    const y = sy + row * (ch + 40);
    const p = c.p(`card${i + 1}`);
    const pulse = c.pulse(`card${i + 1}`);
    const label = c.label(`card${i + 1}`, card.heading || card.body);
    const heading = card.heading ? label : "";
    const body = card.heading ? card.body : label;
    if (p <= 0.01) return;
    s.push(`<g opacity="${fx(p)}" transform="translate(0 ${fx((1 - p) * 24)})">`);
    s.push(`<rect x="${fx(x)}" y="${fx(y)}" width="${fx(cw)}" height="${ch}" rx="26" fill="${C.panel}" stroke="${pulse > 0 ? C.teal : "#2B5A8E"}" stroke-width="${fx(3 + 3 * pulse)}"/>`);
    if (card.badge) s.push(text(x + 28, y + 56, card.badge, 38, C.teal, { weight: 800 }));
    const hy = y + (card.badge ? 104 : 70);
    if (heading) {
      s.push(multiline(x + 28, hy, wrap(heading, Math.floor(cw / 17.5)), 28, C.teal, { weight: 800 }));
      s.push(multiline(x + 28, hy + 64, wrap(body, Math.floor(cw / 16.5)), 30, C.ink, { weight: 500 }));
    } else {
      s.push(multiline(x + 28, hy + 10, wrap(body, Math.floor(cw / 17.5)), 32, C.ink, { weight: 600 }));
    }
    s.push(`</g>`);
    if (cols > 1 && col < cols - 1 && i + 1 < n && c.p(`card${i + 2}`) > 0.01) {
      const ax = x + cw + 4;
      const ay = y + ch / 2;
      s.push(`<path d="M ${fx(ax)} ${fx(ay)} l ${gx - 10} 0 m -12 -10 l 12 10 l -12 10" stroke="${C.teal}" stroke-width="5" fill="none" stroke-linecap="round" opacity="${fx(c.p(`card${i + 2}`))}"/>`);
    }
  });
  return s.join("");
}

export const TEMPLATE_DEFS: Record<TemplateId, TemplateDef> = {
  "glucose-uptake": { name: "Muscle glucose uptake (insulin → receptor → GLUT4)", elements: () => GLUCOSE_ELEMENTS, draw: drawGlucoseUptake },
  "visceral-fat": { name: "Visceral fat → FFA → liver → insulin resistance", elements: () => VISCERAL_ELEMENTS, draw: drawVisceral },
  continuum: { name: "Diabetes continuum (stages + curves)", elements: () => CONTINUUM_ELEMENTS, draw: drawContinuum },
  ...MEDICAL_TEMPLATES,
  "key-points": { name: "Key concepts (generic)", elements: keyPointElements, draw: drawKeyPoints },
};

// ---------- frame ----------
function popupLayer(popups: Popup[], t: number): string {
  const active = popups.filter((p) => t >= p.start && t <= p.end).sort((a, b) => b.start - a.start)[0];
  if (!active) return "";
  const fadeIn = clamp01((t - active.start) / 0.35);
  const fadeOut = clamp01((active.end - t) / 0.35);
  const o = Math.min(fadeIn, fadeOut);
  const color = active.kind === "warning" ? C.red : active.kind === "clinical" ? C.teal : C.insulin;
  const lines = wrap(active.text, 44);
  const h = 78 + lines.length * 34;
  const x = 1920 - 560 - 40;
  const y = 888 - h + (1 - ease(fadeIn)) * 20;
  const tag = active.kind === "warning" ? "CLINICAL WARNING" : active.kind === "clinical" ? "CLINICAL PEARL" : "DEFINITION";
  return (
    `<g opacity="${fx(o)}">` +
    `<rect x="${x}" y="${fx(y)}" width="560" height="${h}" rx="22" fill="#0A1B33" fill-opacity=".94" stroke="${color}" stroke-width="4"/>` +
    text(x + 24, y + 34, tag, 18, color, { weight: 800 }) +
    text(x + 24, y + 66, active.title, 26, C.ink, { weight: 800 }) +
    multiline(x + 24, y + 102, lines, 23, C.dim, {}) +
    `</g>`
  );
}

function captionBar(plan: SceneInput, t: number): string {
  const speech = Math.max(0.5, plan.durationSeconds - LEAD_IN - TAIL);
  const words = wordTimings(plan.narration, speech);
  const sentences = sentenceWindows(words);
  let cur = sentences.find((sn) => t >= sn.start - 0.05 && t <= sn.end + 0.35);
  if (!cur) cur = sentences.filter((sn) => sn.end < t).pop();
  let inner = "";
  if (cur && t >= LEAD_IN - 0.1 && t <= LEAD_IN + speech + 0.5) {
    const lines: Array<Array<{ word: string; on: boolean }>> = [[]];
    let len = 0;
    for (const w of cur.words) {
      if (len + w.word.length > 78 && lines[lines.length - 1]!.length) {
        lines.push([]);
        len = 0;
      }
      lines[lines.length - 1]!.push({ word: w.word, on: t >= w.start });
      len += w.word.length + 1;
    }
    const shown = lines.slice(-2);
    inner = shown
      .map(
        (ln, i) =>
          `<text xml:space="preserve" x="960" y="${fx(956 + i * 40)}" ${FONT} font-size="32" text-anchor="middle" fill="${C.dim}">${ln
            .map((w) => `<tspan fill="${w.on ? "#FFFFFF" : "#6F88A6"}" font-weight="${w.on ? 600 : 400}">${esc(w.word)} </tspan>`)
            .join("")}</text>`,
      )
      .join("");
  }
  return `<rect x="0" y="904" width="${W}" height="176" fill="#06101F" fill-opacity=".92"/>${inner}`;
}

export function elementSpecs(plan: SceneInput): ElementSpec[] {
  return TEMPLATE_DEFS[plan.template].elements(plan);
}

/** Render one frame of the explainer as an SVG document string. */
export function renderFrame(plan: SceneInput, t: number, opts: RenderOptions = {}): string {
  const ctx: Ctx = {
    t,
    plan,
    p: (id) => showProgress(plan.events, id, t),
    pulse: (id) => pulseAmount(plan.events, id, t),
    label: (id, d) => plan.labels[id] ?? d,
    param: <T extends string | number | boolean>(k: string, d: T): T => {
      const v = plan.params[k];
      return (typeof v === typeof d ? (v as T) : d) as T;
    },
  };
  const tpl = TEMPLATE_DEFS[plan.template];
  const title = plan.title.length > 64 ? `${plan.title.slice(0, 62)}…` : plan.title;
  const progress = clamp01(t / Math.max(0.1, plan.durationSeconds));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg2}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    `<rect x="60" y="48" width="96" height="56" rx="14" fill="${C.teal}"/>`,
    text(108, 88, String(plan.slide).padStart(2, "0"), 34, "#06101F", { anchor: "middle", weight: 800 }),
    text(180, 90, title, 42, C.ink, { weight: 700 }),
    tpl.draw(ctx),
    popupLayer(plan.popups, t),
    opts.captions === false ? "" : captionBar(plan, t),
    `<rect x="0" y="${H - 8}" width="${fx(W * progress)}" height="8" fill="${C.teal}"/>`,
    opts.watermark
      ? `<g opacity=".85"><rect x="${W - 560}" y="46" width="500" height="44" rx="10" fill="#B3261E"/>${text(W - 310, 77, opts.watermark, 22, "#FFFFFF", { anchor: "middle", weight: 800 })}</g>`
      : "",
    `</svg>`,
  ];
  return parts.join("");
}

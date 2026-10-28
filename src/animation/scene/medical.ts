/**
 * Topic-specific explainer scenes. Content (text + narration cues) comes from content.ts;
 * the functions here only decide how a slide's own wording is laid out and animated.
 * Pure SVG, no Node/DOM dependencies (shared with the browser studio).
 */
import { authoredFor, type Item } from "./content.js";
import { ORGANS } from "./derive.js";
import { pictogram } from "./icons.js";
import { C, clamp01, fx, lerp, multiline, text, wrap } from "./kit.js";
import type { Ctx, ElementSpec, SceneInput, TemplateDef } from "./kit.js";

// ---------- helpers ----------
function itemsFor(plan: SceneInput): Item[] {
  const a = authoredFor(plan.slide, plan.title);
  if (a && a.template === plan.template) return a.items;
  return (plan.items ?? []) as Item[];
}

function elementsFromItems(plan: SceneInput): ElementSpec[] {
  const items = itemsFor(plan);
  return items.map<ElementSpec>((it, i) => ({
    id: it.id,
    label: it.label.replace("|", " — "),
    cues: it.cues.filter(Boolean),
    ...(!it.free && i > 0 ? { after: items[i - 1]!.id, gap: 0.3 } : {}),
    maxGap: 8,
    dur: 0.9,
    frac: it.frac ?? i / Math.max(1, items.length),
    description: it.description ?? it.label.replace("|", " — ").slice(0, 60),
  }));
}

const has = (c: Ctx, id: string): boolean => itemsFor(c.plan).some((i) => i.id === id);
const idsOf = (c: Ctx, prefix: string): string[] => itemsFor(c.plan).filter((i) => new RegExp(`^${prefix}\\d+$`).test(i.id)).map((i) => i.id);
const dflt = (c: Ctx, id: string): string => itemsFor(c.plan).find((i) => i.id === id)?.label ?? "";
const lbl = (c: Ctx, id: string): string => c.label(id, dflt(c, id));
const split = (s: string): { head: string; sub: string } => {
  const k = s.indexOf("|");
  return k < 0 ? { head: s.trim(), sub: "" } : { head: s.slice(0, k).trim(), sub: s.slice(k + 1).trim() };
};
const parts = (c: Ctx, id: string): { head: string; sub: string } => split(lbl(c, id));
const prm = <T extends string | number | boolean>(c: Ctx, k: string, d: T): T => c.param(k, d);

function mix(a: string, b: string, k: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(lerp(v, pb[i]!, k)).toString(16).padStart(2, "0")).join("");
}

const rect = (x: number, y: number, w: number, h: number, r: number, fill: string, stroke = "none", sw = 0, op = 1): string =>
  `<rect x="${fx(x)}" y="${fx(y)}" width="${fx(w)}" height="${fx(h)}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${o2(op)}"/>`;

/** Text block wrapped to a pixel width; returns the svg and the number of lines drawn. */
function block(x: number, y: number, w: number, s: string, size: number, fill: string, weight = 600, anchor = "start"): { svg: string; lines: number; h: number } {
  const lines = wrap(s, Math.max(6, Math.floor(w / (size * 0.52))));
  return { svg: multiline(x, y, lines, size, fill, { weight, anchor }), lines: lines.length, h: lines.length * size * 1.25 };
}

/** Line from (x1,y1) towards (x2,y2) drawn to `prog`, with an arrow head near the end. */
function arrow(x1: number, y1: number, x2: number, y2: number, prog: number, color: string, width = 6): string {
  if (prog <= 0.01) return "";
  const x = lerp(x1, x2, prog);
  const y = lerp(y1, y2, prog);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hl = 20;
  let s = `<line x1="${fx(x1)}" y1="${fx(y1)}" x2="${fx(x)}" y2="${fx(y)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  if (prog > 0.85) {
    const a1 = ang + Math.PI * 0.82;
    const a2 = ang - Math.PI * 0.82;
    s += `<path d="M ${fx(x + Math.cos(a1) * hl)} ${fx(y + Math.sin(a1) * hl)} L ${fx(x)} ${fx(y)} L ${fx(x + Math.cos(a2) * hl)} ${fx(y + Math.sin(a2) * hl)}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return s;
}

function flowDots(x1: number, y1: number, x2: number, y2: number, prog: number, t: number, color: string, n = 3, r = 7): string {
  if (prog < 0.5) return "";
  let s = "";
  for (let k = 0; k < n; k++) {
    const u = (((t * 0.45 + k / n) % 1) + 1) % 1;
    s += `<circle cx="${fx(lerp(x1, x2, u))}" cy="${fx(lerp(y1, y2, u))}" r="${r}" fill="${color}" opacity="${o2(prog * Math.sin(Math.PI * u))}"/>`;
  }
  return s;
}

function note(c: Ctx, id: string, color: string = C.teal, x = 90, w = 1200, y = 786): string {
  const p = c.p(id);
  if (p < 0.02 || !has(c, id)) return "";
  const size = 30;
  const b = block(0, 0, w - 80, lbl(c, id), size, "#FFFFFF", 700);
  const h = 34 + b.h;
  const lines = wrap(lbl(c, id), Math.max(6, Math.floor((w - 80) / (size * 0.52))));
  return (
    `<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 18)})">` +
    rect(x, y, w, h, 20, mix("#0A1B33", color, 0.28), color, 3) +
    multiline(x + w / 2, y + 22 + size, lines, size, "#FFFFFF", { anchor: "middle", weight: 700 }) +
    `</g>`
  );
}

const o2 = (n: number): string => (Math.round(n * 100) / 100).toString();
const pulseGlow = (t: number, k: number): number => 0.5 + 0.5 * Math.sin(t * 4 + k);

// ---------- pathway ----------
function drawPathway(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const nodes = idsOf(c, "n");
  const hasStat = has(c, "stat");
  const compact = hasStat && nodes.length >= 4;
  const x0 = hasStat && !compact ? 650 : 110;
  const x1 = 1810;
  const gap = 84;
  const K = Math.max(1, nodes.length);
  const nw = (x1 - x0 - gap * (K - 1)) / K;
  const nh = compact ? 310 : 270;
  const y = compact ? 440 : 330;
  const escalate = prm(c, "escalate", false);

  if (hasStat) {
    const sp = c.p("stat");
    const label = lbl(c, "stat");
    const m = /^(\d{1,3})\s*%$/.exec(label);
    const cx = compact ? x0 + (nw + gap) * 1 + nw / 2 : 360;
    const cy = compact ? 290 : 450;
    const rad = compact ? 88 : 140;
    if (sp > 0.01) {
      s.push(`<g opacity="${o2(sp)}">`);
      if (m) {
        const val = Number(m[1]) / 100;
        const circ = 2 * Math.PI * rad;
        s.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="#FFFFFF1F" stroke-width="${compact ? 22 : 34}"/>`);
        s.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${C.red}" stroke-width="${compact ? 22 : 34}" stroke-linecap="round" stroke-dasharray="${fx(circ * val * sp)} ${fx(circ)}" transform="rotate(-90 ${cx} ${cy})"/>`);
        s.push(text(cx, cy + (compact ? 20 : 30), `${Math.round(Number(m[1]) * sp)}%`, compact ? 58 : 96, C.ink, { anchor: "middle", weight: 800 }));
      } else {
        s.push(rect(cx - 250, cy - 120, 500, 240, 40, C.panel, C.red, 4));
        s.push(text(cx, cy + 36, label, label.length > 6 ? 84 : 110, C.red, { anchor: "middle", weight: 800 }));
      }
      s.push(`</g>`);
    }
    const cp = c.p("statCap");
    if (cp > 0.01 && has(c, "statCap")) s.push(`<g opacity="${o2(cp)}">${compact ? block(cx + rad + 40, cy - 6, 520, lbl(c, "statCap"), 30, C.dim, 600).svg : multiline(cx, cy + (m ? 215 : 175), wrap(lbl(c, "statCap"), 24), 30, C.dim, { anchor: "middle", weight: 600 })}</g>`);
  }

  nodes.forEach((id, i) => {
    const p = c.p(id);
    const pulse = c.pulse(id);
    const x = x0 + i * (nw + gap);
    const color = escalate ? mix(C.teal, C.red, K === 1 ? 0 : i / (K - 1)) : C.teal;
    if (i > 0) {
      const ap = c.p(id);
      const px = x0 + (i - 1) * (nw + gap) + nw;
      s.push(arrow(px + 10, y + nh / 2, x - 12, y + nh / 2, ap, color, 7));
      s.push(flowDots(px + 10, y + nh / 2, x - 12, y + nh / 2, ap, t, color));
    }
    if (p <= 0.01) return;
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 30)})">`);
    s.push(rect(x, y, nw, nh, 28, C.panel, color, 4 + 3 * pulse));
    s.push(`<circle cx="${fx(x + 40)}" cy="${fx(y + 40)}" r="22" fill="${color}"/>`);
    s.push(text(x + 40, y + 49, String(i + 1), 26, "#06101F", { anchor: "middle", weight: 800 }));
    s.push(pictogram(prm<string>(c, `${id}.icon`, ""), x + nw - 52, y + 52, 58, color, 0.95 + 0.05 * Math.sin(t * 3 + i)));
    const hb = block(x + nw / 2, y + 108, nw - 50, head, head.length > 24 ? 30 : 34, C.ink, 800, "middle");
    s.push(hb.svg);
    if (sub) s.push(block(x + nw / 2, y + 108 + hb.h + 14, nw - 50, sub, compact ? 22 : 24, C.dim, 500, "middle").svg);
    s.push(`</g>`);
    if (i === K - 1 && p > 0.95) s.push(rect(x - 8, y - 8, nw + 16, nh + 16, 34, "none", color, 3, 0.35 + 0.4 * pulseGlow(t, i)));
  });
  s.push(note(c, "note", C.teal));
  return s.join("");
}

// ---------- converge ----------
function trendGlyph(sub: string): { glyph: string; color: string } | null {
  if (/declin|loss|lower|reduc|fail/i.test(sub)) return { glyph: "↓", color: C.red };
  if (/increas|rise|higher/i.test(sub)) return { glyph: "↑", color: C.glucose };
  return null;
}

function drawConverge(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const srcs = idsOf(c, "s");
  const K = Math.max(1, srcs.length);
  const bx = 110;
  const bw = 600;
  const bh = 116;
  const gapY = K <= 3 ? 46 : 30;
  const total = K * bh + (K - 1) * gapY;
  const top = 470 - total / 2;
  const ox = 1160;
  const ow = 650;
  const oh = 320;
  const oy = 470 - oh / 2;
  const op = c.p("out");
  s.push(rect(ox, oy, ow, oh, 34, "none", "#2B5A8E", 3, 0.5 * (1 - op)));
  srcs.forEach((id, i) => {
    const p = c.p(id);
    const y = top + i * (bh + gapY);
    const ty = oy + oh / 2 + (i - (K - 1) / 2) * 38;
    s.push(arrow(bx + bw + 8, y + bh / 2, ox - 12, ty, p, C.teal, 5));
    s.push(flowDots(bx + bw + 8, y + bh / 2, ox - 12, ty, p, t + i * 0.2, C.teal, 3, 6));
    if (p <= 0.01) return;
    const { head, sub } = parts(c, id);
    const trend = trendGlyph(sub);
    s.push(`<g opacity="${o2(p)}" transform="translate(${fx((1 - p) * -40)} 0)">`);
    s.push(rect(bx, y, bw, bh, 24, C.panel, trend ? trend.color : "#2B5A8E", 3 + 3 * c.pulse(id)));
    if (sub) {
      s.push(text(bx + 30, y + 50, head, 31, C.ink, { weight: 800 }));
      s.push(text(bx + 30, y + 88, sub, 26, C.dim, { weight: 500 }));
    } else {
      const hs = head.length > 30 ? 27 : 32;
      s.push(block(bx + 30, y + bh / 2 + (head.length > 30 ? 0 : 10), bw - 160, head, hs, C.ink, 800).svg);
    }
    if (!trend) s.push(pictogram(prm<string>(c, `${id}.icon`, ""), bx + bw - 56, y + bh / 2, 62, C.teal, 0.95));
    if (trend) s.push(text(bx + bw - 54, y + 76, trend.glyph, 70, trend.color, { anchor: "middle", weight: 800, opacity: 0.6 + 0.4 * Math.sin(t * 5 + i) }));
    s.push(`</g>`);
  });
  if (op > 0.01 && has(c, "out")) {
    const { head, sub } = parts(c, "out");
    s.push(`<g opacity="${o2(op)}" transform="translate(${fx((1 - op) * 50)} 0)">`);
    s.push(rect(ox, oy, ow, oh, 34, mix(C.panel, C.teal, 0.2), C.teal, 5 + 3 * c.pulse("out")));
    const hb = block(ox + ow / 2, oy + 96, ow - 80, head, 42, C.ink, 800, "middle");
    s.push(hb.svg);
    if (sub) s.push(block(ox + ow / 2, oy + 96 + hb.h + 22, ow - 90, sub, 29, C.dim, 500, "middle").svg);
    s.push(`</g>`);
    s.push(rect(ox - 10, oy - 10, ow + 20, oh + 20, 40, "none", C.teal, 3, op * (0.2 + 0.3 * pulseGlow(t, 0))));
  }
  return s.join("");
}

// ---------- balance ----------
function drawBalance(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const mode = prm<string>(c, "tilt", "level");
  const vp = c.p("verdict");
  const target = mode === "left" ? -1 : mode === "right" ? 1 : 0;
  const present = Math.min(c.p("L"), c.p("R"));
  const sway = mode === "level" ? Math.sin(t * 1.4) * 2.4 * present : 0;
  const ang = ((target * vp * 9) + sway) * (Math.PI / 180);
  const cx = 960;
  const cy = 290;
  const half = 500;
  const L: [number, number] = [cx - half * Math.cos(ang), cy - half * Math.sin(ang)];
  const R: [number, number] = [cx + half * Math.cos(ang), cy + half * Math.sin(ang)];

  s.push(`<rect x="${cx - 9}" y="${cy}" width="18" height="470" fill="#2B5A8E"/>`);
  s.push(`<path d="M ${cx - 130} 790 L ${cx + 130} 790 L ${cx + 60} 740 L ${cx - 60} 740 Z" fill="#2B5A8E"/>`);
  s.push(`<line x1="${fx(L[0])}" y1="${fx(L[1])}" x2="${fx(R[0])}" y2="${fx(R[1])}" stroke="${C.ink}" stroke-width="14" stroke-linecap="round" opacity="${o2(0.35 + 0.65 * Math.max(present, vp))}"/>`);
  s.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="${C.teal}"/>`);

  const side = (end: [number, number], titleId: string, prefix: string, color: string): void => {
    const tp = c.p(titleId);
    if (tp > 0.01) {
      const pw = 400;
      const py = end[1] + 340;
      s.push(`<g opacity="${o2(tp)}">`);
      s.push(`<line x1="${fx(end[0])}" y1="${fx(end[1])}" x2="${fx(end[0] - pw / 2 + 20)}" y2="${fx(py)}" stroke="${C.dim}" stroke-width="3"/>`);
      s.push(`<line x1="${fx(end[0])}" y1="${fx(end[1])}" x2="${fx(end[0] + pw / 2 - 20)}" y2="${fx(py)}" stroke="${C.dim}" stroke-width="3"/>`);
      s.push(rect(end[0] - pw / 2, py, pw, 20, 10, color));
      const { head } = parts(c, titleId);
      const tl = wrap(head, 22);
      s.push(multiline(end[0], end[1] - 40 - (tl.length - 1) * 38, tl, 31, color, { anchor: "middle", weight: 800 }));
      s.push(`</g>`);
      const items = idsOf(c, prefix);
      items.forEach((id, i) => {
        const ip = c.p(id);
        if (ip <= 0.01) return;
        const y = py - 10 - (i + 1) * 66 + (1 - ip) * -30;
        s.push(`<g opacity="${o2(ip)}">`);
        s.push(rect(end[0] - 180, y, 360, 56, 16, mix("#0A1B33", color, 0.3), color, 3));
        s.push(block(end[0], y + 37, 330, lbl(c, id), 26, C.ink, 700, "middle").svg);
        s.push(`</g>`);
      });
    }
  };
  side(L, "L", "l", C.glucose);
  side(R, "R", "r", C.insulin);

  const hp = c.p("head");
  if (hp > 0.01 && has(c, "head")) s.push(`<g opacity="${o2(hp)}">${text(960, 158, lbl(c, "head"), 40, C.teal, { anchor: "middle", weight: 800 })}</g>`);
  s.push(note(c, "verdict", C.red, 330, 1260));
  return s.join("");
}

// ---------- body ----------
const REGION_ANCHOR: Record<string, [number, number]> = {
  abdomen: [960, 470],
  muscle: [905, 690],
  liver: [915, 400],
  pancreas: [990, 438],
  waist: [1040, 492],
  tissue: [1010, 610],
  whole: [1030, 330],
  trend: [1085, 392],
  scale: [1130, 830],
  alert: [960, 300],
};

function drawBody(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const lean = prm(c, "lean", false);
  const cx = 960;
  const callouts = idsOf(c, "c");
  const region = (id: string): string => prm(c, `${id}.region`, "");
  const rp = (r: string): number => Math.max(0, ...callouts.filter((id) => region(id) === r).map((id) => c.p(id)));

  const shoulder = lean ? 92 : 124;
  const waistW = lean ? 70 : 118;
  const hip = lean ? 92 : 120;
  const skin = "#1E4272";
  const edge = "#4B7BB0";
  const thigh = lerp(86, 56, rp("muscle"));

  // legs, arms, torso, head
  for (const sg of [-1, 1]) {
    s.push(rect(cx + sg * 56 - thigh / 2, 560, thigh, 250, 34, skin, edge, 3));
    s.push(rect(cx + sg * (shoulder + 38) - 26, 306, 52, 250, 26, skin, edge, 3));
  }
  s.push(`<path d="M ${cx - shoulder} 318 Q ${cx} 268 ${cx + shoulder} 318 Q ${cx + shoulder + 6} 410 ${cx + waistW} 480 Q ${cx + hip} 520 ${cx + hip} 580 L ${cx - hip} 580 Q ${cx - hip} 520 ${cx - waistW} 480 Q ${cx - shoulder - 6} 410 ${cx - shoulder} 318 Z" fill="${skin}" stroke="${edge}" stroke-width="3"/>`);
  s.push(`<circle cx="${cx}" cy="212" r="54" fill="${skin}" stroke="${edge}" stroke-width="3"/>`);
  s.push(rect(cx - 18, 256, 36, 40, 10, skin));

  // regions
  const whole = rp("whole");
  if (whole > 0.01) s.push(`<ellipse cx="${cx}" cy="530" rx="${fx(250 + 10 * Math.sin(t * 3))}" ry="400" fill="none" stroke="${C.teal}" stroke-width="5" stroke-dasharray="14 12" opacity="${o2(whole * 0.8)}"/>`);
  const ab = rp("abdomen");
  if (ab > 0.01) s.push(`<ellipse cx="${cx}" cy="480" rx="${fx(lean ? 64 : lerp(66, 118, ab))}" ry="64" fill="${C.fat}" opacity="${o2(0.9 * ab)}" stroke="#C9A227" stroke-width="3"/>`);
  const mu = rp("muscle");
  if (mu > 0.01) {
    for (const sg of [-1, 1]) s.push(rect(cx + sg * 56 - thigh / 2 + 6, 610, thigh - 12, 160, 24, C.muscle, "none", 0, 0.9 * mu));
    s.push(text(cx + 188, 700, "↓", 66, C.red, { anchor: "middle", weight: 800, opacity: mu * (0.6 + 0.4 * Math.sin(t * 5)) }));
  }
  const lv = rp("liver");
  if (lv > 0.01) {
    s.push(`<ellipse cx="${cx - 44}" cy="402" rx="66" ry="34" transform="rotate(-10 ${cx - 44} 402)" fill="${C.liver}" stroke="#C98C62" stroke-width="3" opacity="${o2(lv)}"/>`);
    for (let k = 0; k < 8; k++) s.push(`<circle cx="${fx(cx - 84 + k * 11 + (k % 2) * 5)}" cy="${fx(396 + ((k * 7) % 22) - 9)}" r="${fx(5 * lv)}" fill="${C.fat}" opacity="${o2(lv)}"/>`);
  }
  const pa = rp("pancreas");
  if (pa > 0.01) {
    s.push(`<ellipse cx="${cx + 30}" cy="440" rx="58" ry="16" fill="${C.insulin}" stroke="#1D5FA8" stroke-width="3" opacity="${o2(pa * (0.55 + 0.45 * Math.abs(Math.sin(t * 3))))}"/>`);
    s.push(text(cx + 30, 447, "β", 20, "#FFFFFF", { anchor: "middle", weight: 800, opacity: pa }));
  }
  const ti = rp("tissue");
  if (ti > 0.01) {
    for (const [x, y] of [[cx - 70, 640], [cx + 70, 640], [cx, 520], [cx - 150, 420], [cx + 150, 420]] as Array<[number, number]>) {
      const k = (t * 0.8 + x * 0.01) % 1;
      s.push(`<circle cx="${x}" cy="${y}" r="${fx(14 + 26 * k)}" fill="none" stroke="${C.red}" stroke-width="4" opacity="${o2(ti * (1 - k))}"/>`);
    }
  }
  const wa = rp("waist");
  if (wa > 0.01) {
    const rx = lerp(waistW + 10, waistW + 56, wa);
    s.push(`<ellipse cx="${cx}" cy="492" rx="${fx(rx)}" ry="22" fill="none" stroke="${mix(C.fat, C.red, wa)}" stroke-width="11" opacity="${o2(wa)}"/>`);
    s.push(`<path d="M ${cx + rx - 4} 492 l 70 20 l 8 -26 z" fill="${C.fat}" opacity="${o2(wa)}"/>`);
  }
  const sc = rp("scale");
  if (sc > 0.01) {
    s.push(`<g opacity="${o2(sc)}">`);
    s.push(rect(cx - 170, 808, 340, 22, 10, "#2B5A8E", C.dim, 2));
    s.push(`<path d="M ${cx + 205} 800 A 55 55 0 0 1 ${cx + 315} 800" fill="none" stroke="${C.dim}" stroke-width="8"/>`);
    const na = Math.PI * (1 - 0.5 - 0.12 * Math.sin(t * 2));
    s.push(`<line x1="${cx + 260}" y1="800" x2="${fx(cx + 260 + Math.cos(na) * 48)}" y2="${fx(800 - Math.sin(na) * 48)}" stroke="${C.teal}" stroke-width="6" stroke-linecap="round"/>`);
    s.push(text(cx + 260, 830, "BMI", 22, C.dim, { anchor: "middle", weight: 700 }));
    s.push(`</g>`);
  }
  const tr = rp("trend");
  if (tr > 0.01) s.push(arrow(cx + 90, 440, cx + 250, 300, tr, C.red, 9));

  // call-outs
  const sideCount = [0, 0];
  callouts.forEach((id, i) => {
    const left = i % 2 === 0;
    const k = sideCount[left ? 0 : 1]!++;
    const bw = 470;
    const bh = 132;
    const x = left ? 110 : 1340;
    const y = 190 + k * 190 + (left ? 0 : 92);
    const p = c.p(id);
    if (p <= 0.01) return;
    const r = region(id);
    const a = REGION_ANCHOR[r];
    const color = r === "alert" ? C.red : r === "abdomen" ? C.fat : r === "pancreas" ? C.insulin : r === "waist" ? C.fat : C.teal;
    if (a) s.push(arrow(left ? x + bw : x, y + bh / 2, left ? Math.min(a[0] - 40, x + bw + 160) : Math.max(a[0] + 40, x - 160), lerp(y + bh / 2, a[1], 0.5), p, color, 4));
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(${fx((1 - p) * (left ? -40 : 40))} 0)">`);
    s.push(rect(x, y, bw, bh, 22, C.panel, color, 3 + 3 * c.pulse(id)));
    if (r === "alert") s.push(text(x + 28, y + 62, "⚠", 44, C.red, { weight: 800 }));
    const tx = r === "alert" ? x + 86 : x + 28;
    const hb = block(tx, y + (sub ? 48 : 74), bw - (tx - x) - 24, head, 29, C.ink, 800);
    s.push(hb.svg);
    if (sub) s.push(block(tx, y + 48 + hb.h + 4, bw - (tx - x) - 24, sub, 24, C.dim, 500).svg);
    s.push(`</g>`);
  });
  s.push(note(c, "note", C.teal, 330, 1260, 836));
  return s.join("");
}

// ---------- lab branch ----------
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, d0: number, d1: number): string {
  const a = polar(cx, cy, r, d0);
  const b = polar(cx, cy, r, d1);
  return `M ${fx(a[0])} ${fx(a[1])} A ${r} ${r} 0 0 1 ${fx(b[0])} ${fx(b[1])}`;
}

function drawLabBranch(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const gx = 960;
  const gy = 660;
  const r = 230;
  const tp = c.p("test");
  const hi = c.p("hi");
  const lo = c.p("lo");
  const g = Math.max(tp, hi, lo);
  s.push(`<g opacity="${o2(g)}">`);
  s.push(`<path d="${arcPath(gx, gy, r, 180, 125)}" stroke="${C.insulin}" stroke-width="40" fill="none"/>`);
  s.push(`<path d="${arcPath(gx, gy, r, 125, 55)}" stroke="#52667F" stroke-width="40" fill="none"/>`);
  s.push(`<path d="${arcPath(gx, gy, r, 55, 0)}" stroke="${C.glucose}" stroke-width="40" fill="none"/>`);
  s.push(text(gx - r, gy + 46, "LOW", 24, C.insulin, { anchor: "middle", weight: 800 }));
  s.push(text(gx + r, gy + 46, "HIGH", 24, C.glucose, { anchor: "middle", weight: 800 }));
  const a = hi * (1 - lo) - lo;
  const wob = tp > 0.9 && hi < 0.05 ? Math.sin(t * 2.2) * 0.12 : 0;
  const deg = 90 - (a + wob) * 68;
  const tip = polar(gx, gy, r - 38, deg);
  s.push(`<line x1="${gx}" y1="${gy}" x2="${fx(tip[0])}" y2="${fx(tip[1])}" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>`);
  s.push(`<circle cx="${gx}" cy="${gy}" r="18" fill="${C.ink}"/>`);
  s.push(`</g>`);

  if (tp > 0.01) {
    s.push(`<g opacity="${o2(tp)}" transform="translate(0 ${fx((1 - tp) * -24)})">`);
    s.push(rect(660, 170, 600, 120, 30, C.panel, C.teal, 5));
    s.push(text(960, 250, lbl(c, "test"), 50, C.ink, { anchor: "middle", weight: 800 }));
    s.push(`</g>`);
  }
  const wp = c.p("what");
  if (wp > 0.01 && has(c, "what")) s.push(`<g opacity="${o2(wp)}">${block(960, 338, 900, lbl(c, "what"), 30, C.dim, 600, "middle").svg}</g>`);

  const branch = (id: string, x: number, color: string, fromX: number): void => {
    const p = c.p(id);
    if (p <= 0.01) return;
    s.push(arrow(fromX, gy - 10, x < 960 ? x + 490 + 8 : x - 8, gy - 10, p, color, 6));
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(${fx((1 - p) * (x < 960 ? -40 : 40))} 0)">`);
    s.push(rect(x, 520, 490, 210, 28, C.panel, color, 4 + 3 * c.pulse(id)));
    const hb = block(x + 245, 570, 440, head, head.length > 34 ? 25 : 30, C.ink, 800, "middle");
    s.push(hb.svg);
    s.push(block(x + 245, 570 + hb.h + 14, 440, sub, sub.length > 48 ? 25 : sub.length > 26 ? 29 : 34, color, 800, "middle").svg);
    s.push(`</g>`);
  };
  branch("hi", 1320, C.glucose, gx + r + 26);
  branch("lo", 110, C.insulin, gx - r - 26);
  s.push(note(c, "note", C.teal, 330, 1260, 800));
  return s.join("");
}

// ---------- HOMA-IR ----------
function drawHoma(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const tiles: Array<{ id: string; w: number; op?: string }> = [
    { id: "glucose", w: 360 },
    { id: "insulin", w: 360, op: "×" },
    { id: "den", w: 230, op: "÷" },
    { id: "result", w: 470, op: "=" },
  ];
  const opW = 70;
  const total = tiles.reduce((a, b) => a + b.w, 0) + opW * 3;
  let x = (1920 - total) / 2;
  const y = 200;
  const h = 170;
  tiles.forEach((tl, i) => {
    if (i > 0) x += opW;
    const p = c.p(tl.id);
    if (p > 0.01) {
      const isRes = tl.id === "result";
      const { head, sub } = parts(c, tl.id);
      if (tl.op) s.push(text(x - opW / 2, y + h / 2 + 22, tl.op, 68, C.teal, { anchor: "middle", weight: 800, opacity: p }));
      s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 26)})">`);
      s.push(rect(x, y, tl.w, h, 28, isRes ? mix(C.panel, C.red, 0.25) : C.panel, isRes ? C.red : C.teal, 4 + 3 * c.pulse(tl.id)));
      s.push(text(x + tl.w / 2, y + (sub ? 82 : 104), head, tl.id === "den" ? 80 : 44, C.ink, { anchor: "middle", weight: 800 }));
      if (sub) s.push(text(x + tl.w / 2, y + 128, sub, 26, C.dim, { anchor: "middle", weight: 600 }));
      s.push(`</g>`);
    }
    x += tl.w;
  });

  const sx0 = 200;
  const sx1 = 1720;
  const sy = 600;
  const pos = (v: number): number => sx0 + (v / 4) * (sx1 - sx0);
  const m2 = c.p("m2");
  const m3 = c.p("m3");
  const sp = Math.max(m2, m3);
  if (sp > 0.01) {
    s.push(`<g opacity="${o2(sp)}">`);
    s.push(rect(sx0, sy, pos(2) - sx0, 38, 19, "#3A5A80"));
    s.push(rect(pos(2), sy, pos(3) - pos(2), 38, 0, C.glucose));
    s.push(rect(pos(3), sy, sx1 - pos(3), 38, 19, C.red));
    s.push(text(sx0, sy + 80, "0", 26, C.dim, { anchor: "middle", weight: 700 }));
    const bead = pos(Math.min(2, 2 * m2) + Math.min(1, m3));
    s.push(`<circle cx="${fx(bead)}" cy="${sy + 19}" r="${fx(22 + 3 * Math.sin(t * 6))}" fill="${C.ink}" stroke="#06101F" stroke-width="4"/>`);
    s.push(`</g>`);
  }
  for (const [id, v, color] of [["m2", 2, C.glucose], ["m3", 3, C.red]] as Array<[string, number, string]>) {
    const p = c.p(id);
    if (p <= 0.01) continue;
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 20)})">`);
    s.push(`<line x1="${pos(v)}" y1="${sy - 24}" x2="${pos(v)}" y2="${sy + 62}" stroke="${color}" stroke-width="5"/>`);
    s.push(text(pos(v), sy - 44, head, 64, color, { anchor: "middle", weight: 800 }));
    s.push(block(pos(v), sy + 102, 380, sub, 28, C.ink, 700, "middle").svg);
    s.push(`</g>`);
  }
  s.push(note(c, "note", C.teal, 330, 1260, 800));
  return s.join("");
}

// ---------- OGTT patterns ----------
function organIcon(kind: "muscle" | "liver", x: number, y: number, a: number, t: number): string {
  if (kind === "muscle") {
    return `<g opacity="${o2(a)}"><rect x="${x - 34}" y="${y - 20}" width="68" height="40" rx="20" fill="${C.muscle}"/><line x1="${x - 24}" y1="${y - 6}" x2="${x + 24}" y2="${y - 6}" stroke="#00000044" stroke-width="3"/><line x1="${x - 24}" y1="${y + 8}" x2="${x + 24}" y2="${y + 8}" stroke="#00000044" stroke-width="3"/></g>`;
  }
  const d = 3 * Math.sin(t * 5);
  return `<g opacity="${o2(a)}"><ellipse cx="${x}" cy="${fx(y + d * 0.2)}" rx="40" ry="22" fill="${C.liver}" stroke="#C98C62" stroke-width="3"/></g>`;
}

function drawOgtt(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const specs: Array<{ id: string; f: number; g: number | null; icons: Array<"muscle" | "liver"> }> = [
    { id: "p1", f: 0.26, g: 0.86, icons: ["muscle"] },
    { id: "p2", f: 0.86, g: null, icons: ["liver"] },
    { id: "p3", f: 0.86, g: 0.86, icons: ["muscle", "liver"] },
  ];
  specs.forEach((sp, i) => {
    const x = 110 + i * 590;
    const w = 560;
    const p = c.p(sp.id);
    if (p <= 0.01) return;
    const { head, sub } = parts(c, sp.id);
    const y = 190;
    const cx0 = x + 70;
    const cx1 = x + w - 50;
    const cy0 = y + 270;
    const cy1 = y + 500;
    const vy = (v: number): number => cy1 - v * (cy1 - cy0);
    const fxp = cx0 + 70;
    const gxp = cx1 - 70;
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 26)})">`);
    s.push(rect(x, y, w, 560, 28, C.panel, "#2B5A8E", 3 + 3 * c.pulse(sp.id)));
    s.push(block(x + 30, y + 56, w - 190, head, 31, C.ink, 800).svg);
    s.push(block(x + 30, y + 150, w - 60, sub, 32, C.teal, 800).svg);
    sp.icons.forEach((ic, k) => s.push(organIcon(ic, x + w - 60 - k * 90, y + 56, 1, t)));
    s.push(`<line x1="${cx0}" y1="${cy1}" x2="${cx1}" y2="${cy1}" stroke="${C.dim}" stroke-width="3"/><line x1="${cx0}" y1="${cy0 - 10}" x2="${cx0}" y2="${cy1}" stroke="${C.dim}" stroke-width="3"/>`);
    s.push(rect(cx0 + 4, vy(0.4), cx1 - cx0 - 8, vy(0.12) - vy(0.4), 6, "#3DDC9722", "#3DDC9788", 2, 1));
    s.push(text(cx1 - 6, vy(0.4) - 8, "normal zone (illustrative)", 18, C.green, { anchor: "end", weight: 600 }));
    s.push(text(fxp, cy1 + 34, "Fasting", 24, C.dim, { anchor: "middle", weight: 700 }));
    s.push(text(gxp, cy1 + 34, "2 h", 24, C.dim, { anchor: "middle", weight: 700 }));
    s.push(text(cx0 - 10, cy0 - 18, "glucose", 20, C.dim, { weight: 600 }));
    const k1 = clamp01(p * 2);
    const k2 = clamp01(p * 2 - 1);
    if (sp.g !== null) {
      const ex = lerp(fxp, gxp, k2);
      const ey = lerp(vy(sp.f), vy(sp.g), k2);
      s.push(`<line x1="${fxp}" y1="${fx(vy(sp.f))}" x2="${fx(ex)}" y2="${fx(ey)}" stroke="${C.glucose}" stroke-width="7" stroke-linecap="round"/>`);
    }
    const hot = (v: number): string => (v > 0.5 ? C.red : C.green);
    s.push(`<circle cx="${fxp}" cy="${fx(vy(sp.f))}" r="${fx(18 * k1)}" fill="${hot(sp.f)}" stroke="#fff" stroke-width="3"/>`);
    if (sp.g !== null) s.push(`<circle cx="${gxp}" cy="${fx(vy(sp.g))}" r="${fx(18 * k2)}" fill="${hot(sp.g)}" stroke="#fff" stroke-width="3"/>`);
    else s.push(text(gxp, vy(0.72), "2-h not specified", 20, C.dim, { anchor: "middle", italic: true, opacity: k2 }));
    s.push(`</g>`);
  });
  s.push(note(c, "note", C.teal, 330, 1260, 800));
  return s.join("");
}

// ---------- stage map ----------
function drawStageMap(c: Ctx): string {
  const s: string[] = [];
  const cols = ["Normal glucose", "Prediabetes", "Diabetes"];
  const rows = ["High insulin", "Low C-peptide"];
  const gx = 400;
  const cw = 470;
  const ch = 210;
  const gy = 280;
  cols.forEach((name, i) => s.push(text(gx + i * (cw + 20) + cw / 2, 250, name, 34, C.teal, { anchor: "middle", weight: 800 })));
  rows.forEach((name, j) => s.push(block(gx - 30, gy + j * (ch + 20) + ch / 2 + 6, 240, name, 32, C.dim, 800, "end").svg));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) s.push(rect(gx + i * (cw + 20), gy + j * (ch + 20), cw, ch, 24, "none", "#2B5A8E", 2, 0.45));
  const colors = [C.green, C.glucose, C.insulin, C.red];
  idsOf(c, "st").forEach((id, k) => {
    const p = c.p(id);
    if (p <= 0.01) return;
    const col = prm(c, `${id}.col`, 0);
    const row = prm(c, `${id}.row`, 0);
    const x = gx + col * (cw + 20);
    const y = gy + row * (ch + 20);
    const color = colors[k % colors.length]!;
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 24)})">`);
    s.push(rect(x, y, cw, ch, 24, mix(C.panel, color, 0.28), color, 4 + 3 * c.pulse(id)));
    s.push(block(x + cw / 2, y + 78, cw - 50, sub, 33, C.ink, 800, "middle").svg);
    s.push(block(x + cw / 2, y + ch - 52, cw - 50, head, 22, C.dim, 600, "middle").svg);
    s.push(`</g>`);
  });
  return s.join("");
}

// ---------- timeline ----------
function drawTimeline(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const ly = 470;
  const lx0 = 140;
  const lx1 = 1780;
  const pos: Record<string, number> = { m1: 290, m2: 730, m3: 1170, m4: 1610 };
  const reached = Math.max(0, ...Object.keys(pos).map((id) => c.p(id) * pos[id]!));
  s.push(`<line x1="${lx0}" y1="${ly}" x2="${lx1}" y2="${ly}" stroke="#2B5A8E" stroke-width="10" stroke-linecap="round"/>`);
  if (reached > 0) s.push(`<line x1="${lx0}" y1="${ly}" x2="${fx(reached)}" y2="${ly}" stroke="${C.teal}" stroke-width="10" stroke-linecap="round"/>`);
  const rp = c.p("risk");
  if (rp > 0.01) {
    const w = (lx1 - 260) * rp;
    s.push(`<g opacity="${o2(0.95)}">`);
    s.push(`<defs><linearGradient id="rk" x1="0" x2="1"><stop offset="0" stop-color="${C.glucose}"/><stop offset="1" stop-color="${C.red}"/></linearGradient></defs>`);
    s.push(rect(260, 318, w, 72, 36, "url(#rk)", "none", 0, 0.9));
    if (rp > 0.7) s.push(text(260 + (lx1 - 260) / 2, 366, lbl(c, "risk"), 32, "#FFFFFF", { anchor: "middle", weight: 800, opacity: clamp01((rp - 0.7) / 0.3) }));
    s.push(`</g>`);
  }
  (["m1", "m2", "m3", "m4"] as const).forEach((id, i) => {
    const p = c.p(id);
    if (p <= 0.01 || !has(c, id)) return;
    const x = pos[id]!;
    const { head, sub } = parts(c, id);
    const bw = 400;
    const bx = Math.min(Math.max(x - bw / 2, 90), 1830 - bw);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 24)})">`);
    s.push(`<line x1="${x}" y1="${ly}" x2="${x}" y2="${ly + 54}" stroke="${C.teal}" stroke-width="5"/>`);
    s.push(`<circle cx="${x}" cy="${ly}" r="${fx(20 + 4 * c.pulse(id))}" fill="${C.teal}" stroke="#06101F" stroke-width="5"/>`);
    s.push(rect(bx, ly + 54, bw, 215, 24, C.panel, C.teal, 3 + 3 * c.pulse(id)));
    const hb = block(bx + bw / 2, ly + 100, bw - 40, head, head.length > 24 ? 26 : 31, C.ink, 800, "middle");
    s.push(hb.svg);
    s.push(block(bx + bw / 2, ly + 100 + hb.h + 8, bw - 50, sub, 24, C.dim, 500, "middle").svg);
    s.push(`</g>`);
    if (id === "m1") s.push(`<circle cx="${x}" cy="${ly}" r="${fx(34 + 10 * Math.sin(t * 3))}" fill="none" stroke="${C.teal}" stroke-width="3" opacity=".5"/>`);
  });
  s.push(note(c, "note", C.red, 330, 1260, 765));
  return s.join("");
}

// ---------- case board ----------
const PANEL_COLORS: Record<string, string> = { profile: C.teal, labs: C.insulin, interp: C.glucose, plan: C.green, alert: C.red, history: C.purple };
const PANEL_ICON: Record<string, string> = { profile: "☺", labs: "⚗", interp: "✱", plan: "✓", alert: "!", history: "↺" };

function countUp(value: string, k: number): string {
  const m = /\d+(?:\.\d+)?/.exec(value);
  if (!m) return value;
  const dec = (m[0].split(".")[1] ?? "").length;
  return value.replace(m[0], (Number(m[0]) * clamp01(k)).toFixed(dec));
}

function figure(build: string, x: number, y: number, a: number, k = 0.6): string {
  const wf = build === "lean" ? 0.78 : build === "obese" ? 1.5 : 1;
  const col = "#6E9BCB";
  return (
    `<g opacity="${o2(a)}" transform="translate(${x} ${y}) scale(${k}) translate(${-x} ${-y})">` +
    `<circle cx="${x}" cy="${y}" r="15" fill="${col}"/>` +
    `<ellipse cx="${x}" cy="${y + 52}" rx="${fx(22 * wf)}" ry="36" fill="${col}"/>` +
    `<rect x="${fx(x - 18 * wf)}" y="${y + 80}" width="${fx(14 * wf)}" height="46" rx="6" fill="${col}"/>` +
    `<rect x="${fx(x + 4 * wf)}" y="${y + 80}" width="${fx(14 * wf)}" height="46" rx="6" fill="${col}"/>` +
    `</g>`
  );
}

function drawCase(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const np = Math.max(1, prm(c, "panels", 1));
  const build = prm<string>(c, "build", "average");
  const pw = Math.min(760, (1740 - 28 * (np - 1)) / np);
  const total = np * pw + (np - 1) * 28;
  const x0 = (1920 - total) / 2;
  const py = 170;
  const maxLines = Math.max(1, ...Array.from({ length: np }, (_, i) => idsOf(c, `p${i + 1}\\.l`).length));
  const small = np >= 4;
  const lineH = small ? 100 : 94;
  const ph = Math.min(640, 130 + maxLines * lineH + 20);

  for (let i = 0; i < np; i++) {
    const pid = `p${i + 1}`;
    const kind = prm<string>(c, `${pid}.kind`, "labs");
    const color = PANEL_COLORS[kind] ?? C.teal;
    const lines = idsOf(c, `${pid}\\.l`);
    const pp = Math.max(c.p(pid), ...lines.map((l) => c.p(l) * 0.6));
    const x = x0 + i * (pw + 28);
    if (i > 0) {
      const prevX = x0 + (i - 1) * (pw + 28) + pw;
      s.push(arrow(prevX + 3, py + 60, x - 3, py + 60, pp, color, 5));
    }
    if (pp <= 0.01) continue;
    const { head } = parts(c, pid);
    const isInterp = kind === "interp";
    s.push(`<g opacity="${o2(Math.min(1, pp * 1.2))}" transform="translate(0 ${fx((1 - pp) * 28)})">`);
    s.push(rect(x, py, pw, ph, 28, C.panel, color, 4 + (isInterp ? 2 * pulseGlow(t, i) : 0)));
    s.push(rect(x, py, pw, 96, 28, mix(C.panel, color, 0.35)));
    s.push(rect(x, py + 60, pw, 36, 0, mix(C.panel, color, 0.35)));
    s.push(`<circle cx="${fx(x + 52)}" cy="${py + 48}" r="26" fill="${color}"/>`);
    s.push(text(x + 52, py + 59, PANEL_ICON[kind] ?? "•", 30, "#06101F", { anchor: "middle", weight: 800 }));
    s.push(block(x + 96, py + 58, pw - (kind === "profile" ? 190 : 120), head, small ? 25 : 30, C.ink, 800).svg);
    if (kind === "profile") s.push(figure(build, x + pw - 52, py + 16, 1).replace(/<circle cx="[\d.]+" cy="[\d.]+" r="15"/, (m) => m));
    s.push(`</g>`);

    lines.forEach((lid, j) => {
      const lp = c.p(lid);
      if (lp <= 0.01) return;
      const y = py + 118 + j * lineH;
      const raw = lbl(c, lid);
      const m = /^([^:]{1,40}):\s*(.+)$/.exec(raw);
      const key = m ? m[1]!.trim() : "";
      let val = m ? m[2]!.trim() : raw;
      const tag = /\b(HIGH|LOW|NORMAL|POSITIVE)\b/.exec(val)?.[1];
      if (tag) val = val.replace(tag, "").trim();
      const tagColor = tag === "HIGH" ? C.red : tag === "LOW" ? C.insulin : tag === "NORMAL" ? C.green : C.glucose;
      const verb = /^(Stop|Start|Counsel)$/i.exec(key)?.[1]?.toLowerCase();
      s.push(`<g opacity="${o2(lp)}" transform="translate(${fx((1 - lp) * 36)} 0)">`);
      s.push(rect(x + 18, y, pw - 36, lineH - 14, 18, mix("#0A1B33", color, 0.16), mix(color, "#0A1B33", 0.35), 2));
      const vs = small || val.length > 40 ? 25 : 31;
      if (verb) {
        const vc = verb === "stop" ? C.red : verb === "start" ? C.green : C.teal;
        s.push(`<circle cx="${fx(x + 58)}" cy="${fx(y + (lineH - 14) / 2)}" r="22" fill="${vc}"/>`);
        s.push(text(x + 58, y + (lineH - 14) / 2 + 11, verb === "stop" ? "✕" : verb === "start" ? "✓" : "➤", 28, "#06101F", { anchor: "middle", weight: 800 }));
        s.push(block(x + 96, y + 42, pw - 150, `${key}: ${val}`, vs, C.ink, 700).svg);
      } else if (key) {
        s.push(text(x + 38, y + 30, key, small ? 19 : 22, C.dim, { weight: 600 }));
        s.push(block(x + 38, y + 66, pw - (tag ? 190 : 80), countUp(val, lp), vs, C.ink, 800).svg);
        if (tag) {
          s.push(rect(x + pw - 156, y + 22, 118, 40, 20, tagColor));
          s.push(text(x + pw - 97, y + 51, tag, 22, "#06101F", { anchor: "middle", weight: 800 }));
        }
      } else {
        s.push(`<circle cx="${fx(x + 44)}" cy="${fx(y + (lineH - 14) / 2)}" r="9" fill="${color}"/>`);
        s.push(block(x + 68, y + 42, pw - 110, val, vs, C.ink, 700).svg);
      }
      s.push(`</g>`);
    });
  }
  return s.join("");
}

// ---------- algorithm ----------
const STEP_NAMES = ["Identify risk", "First-line tests", "Interpret", "Mechanism", "Phenotype", "Action"];

function drawAlgorithm(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const cur = prm<number>(c, "step", 1);
  const w = 282;
  const y = 150;
  STEP_NAMES.forEach((name, i) => {
    const x = 90 + i * (w + 8);
    const n = i + 1;
    const reveal = clamp01((t - 0.1 * i) / 0.5);
    const state = n < cur ? "done" : n === cur ? "now" : "todo";
    const fill = state === "now" ? C.teal : state === "done" ? "#1D5FA8" : "none";
    const ink = state === "now" ? "#06101F" : C.ink;
    const grow = state === "now" ? 1 + 0.04 * Math.sin(t * 4) : 1;
    s.push(`<g opacity="${o2(reveal)}" transform="translate(${fx(x + w / 2)} ${y + 40}) scale(${Math.round(grow * 1000) / 1000}) translate(${fx(-(x + w / 2))} ${-(y + 40)})">`);
    s.push(`<path d="M ${x} ${y} L ${x + w - 26} ${y} L ${x + w} ${y + 40} L ${x + w - 26} ${y + 80} L ${x} ${y + 80} L ${x + 26} ${y + 40} Z" fill="${fill}" stroke="${state === "todo" ? "#2B5A8E" : fill}" stroke-width="3"/>`);
    s.push(text(x + w / 2 + 4, y + 36, `STEP ${n}`, 21, ink, { anchor: "middle", weight: 800, opacity: 0.85 }));
    s.push(text(x + w / 2 + 4, y + 63, name, 26, ink, { anchor: "middle", weight: 700 }));
    s.push(`</g>`);
  });

  const hp = c.p("head");
  if (hp > 0.01 && has(c, "head")) s.push(`<g opacity="${o2(hp)}">${text(110, 300, lbl(c, "head"), 46, C.ink, { weight: 800 })}</g>`);

  const cols = prm<number>(c, "cols", 3);
  const cards = idsOf(c, "d");
  const gap = 30;
  const cw = (1700 - gap * (cols - 1)) / cols;
  const rowsN = Math.ceil(cards.length / cols);
  const big = rowsN === 1;
  const chh = cols === 2 ? 230 : rowsN > 1 ? 160 : 250;
  cards.forEach((id, i) => {
    const p = c.p(id);
    if (p <= 0.01) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 110 + col * (cw + gap);
    const yy = 360 + row * (chh + gap);
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 26)})">`);
    s.push(rect(x, yy, cw, chh, 24, C.panel, C.teal, 3 + 3 * c.pulse(id)));
    s.push(`<circle cx="${fx(x + 38)}" cy="${fx(yy + 40)}" r="19" fill="${C.teal}"/>`);
    s.push(text(x + 38, yy + 48, String(i + 1), 22, "#06101F", { anchor: "middle", weight: 800 }));
    const hs = big || cols === 2 ? 36 : 29;
    const hb = block(x + 72, yy + 52, cw - 100, head, hs, C.ink, 800);
    s.push(hb.svg);
    if (sub) s.push(block(x + 72, yy + 52 + hb.h + 12, cw - 100, sub, big || cols === 2 ? 32 : 26, C.teal, 700).svg);
    s.push(`</g>`);
  });

  const np = c.p("next");
  if (np > 0.01 && has(c, "next")) {
    const lastRowBottom = 360 + chh;
    for (let i = 0; i < Math.min(cards.length, 2); i++) {
      const x = 110 + i * (cw + gap) + cw / 2;
      s.push(arrow(x, lastRowBottom + 6, 960 + (i === 0 ? -80 : 80), 640, np, C.teal, 5));
    }
    s.push(`<g opacity="${o2(np)}" transform="translate(0 ${fx((1 - np) * 20)})">`);
    s.push(rect(660, 650, 600, 90, 45, C.teal));
    s.push(text(960, 708, `→ ${lbl(c, "next")}`, 40, "#06101F", { anchor: "middle", weight: 800 }));
    s.push(`</g>`);
  }
  s.push(note(c, "note", C.teal, 330, 1260, 800));
  return s.join("");
}

// ---------- compare (two sides, row by row) ----------
function drawCompare(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const ax = 110;
  const bx = 1030;
  const pw = 780;
  const rows = Math.max(idsOf(c, "a").length, idsOf(c, "b").length, 1);
  const rh = Math.min(140, Math.floor(520 / rows));
  const sides: Array<[string, string, string, number]> = [["A", "a", C.insulin, ax], ["B", "b", C.glucose, bx]];
  for (const [head, prefix, color, x] of sides) {
    const hp = c.p(head);
    if (hp > 0.01 && has(c, head)) {
      s.push(`<g opacity="${o2(hp)}" transform="translate(${fx((1 - hp) * (x < 900 ? -40 : 40))} 0)">`);
      s.push(rect(x, 160, pw, 100, 28, mix(C.panel, color, 0.3), color, 4 + 3 * c.pulse(head)));
      s.push(block(x + pw / 2, 222, pw - 60, lbl(c, head), 40, C.ink, 800, "middle").svg);
      s.push(`</g>`);
    }
    idsOf(c, prefix).forEach((id, i) => {
      const p = c.p(id);
      if (p <= 0.01) return;
      const y = 290 + i * (rh + 14);
      s.push(`<g opacity="${o2(p)}" transform="translate(${fx((1 - p) * (x < 900 ? -50 : 50))} 0)">`);
      s.push(rect(x, y, pw, rh, 22, C.panel, color, 3 + 3 * c.pulse(id)));
      s.push(`<circle cx="${fx(x + 38)}" cy="${fx(y + rh / 2)}" r="12" fill="${color}"/>`);
      const size = rh < 110 ? 26 : 29;
      const n = wrap(lbl(c, id), Math.max(6, Math.floor((pw - 110) / (size * 0.52)))).length;
      s.push(block(x + 70, y + rh / 2 - ((n - 1) * size * 1.25) / 2 + size * 0.35, pw - 110, lbl(c, id), size, C.ink, 600).svg);
      s.push(`</g>`);
    });
  }
  const both = Math.min(c.p("A"), c.p("B"));
  if (both > 0.01) {
    s.push(`<g opacity="${o2(both)}"><circle cx="960" cy="210" r="46" fill="${C.teal}" opacity="${o2(0.85 + 0.15 * Math.sin(t * 3))}"/>${text(960, 226, "VS", 40, "#06101F", { anchor: "middle", weight: 800 })}</g>`);
    s.push(`<line x1="960" y1="270" x2="960" y2="${fx(290 + rows * (rh + 14))}" stroke="#2B5A8E" stroke-width="3" stroke-dasharray="10 10" opacity="${o2(both * 0.7)}"/>`);
  }
  s.push(note(c, "verdict", C.teal, 330, 1260, 800));
  return s.join("");
}

// ---------- workflow (ordered steps and decisions) ----------
function drawWorkflow(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const ids = idsOf(c, "w");
  const K = Math.max(1, ids.length);
  const perRow = K <= 3 ? K : 3;
  const rowsN = Math.ceil(K / perRow);
  const gap = 96;
  const cw = Math.min(540, Math.floor((1740 - gap * (perRow - 1)) / perRow));
  const ch = rowsN === 1 ? 300 : 250;
  const total = perRow * cw + (perRow - 1) * gap;
  const x0 = (1920 - total) / 2;
  const y0 = rowsN === 1 ? 330 : 190;
  const pos = (i: number): [number, number] => [x0 + (i % perRow) * (cw + gap), y0 + Math.floor(i / perRow) * (ch + 90)];
  ids.forEach((id, i) => {
    const [x, y] = pos(i);
    const p = c.p(id);
    const kind = prm<string>(c, `${id}.kind`, "action");
    const color = kind === "decision" ? C.glucose : kind === "start" ? C.green : C.teal;
    if (i > 0) {
      const [px, py] = pos(i - 1);
      const sameRow = Math.floor((i - 1) / perRow) === Math.floor(i / perRow);
      if (sameRow) {
        s.push(arrow(px + cw + 8, py + ch / 2, x - 10, y + ch / 2, p, color, 7));
        s.push(flowDots(px + cw + 8, py + ch / 2, x - 10, y + ch / 2, p, t, color));
      } else {
        if (p > 0.01) {
          const midY = py + ch + 45;
          s.push(`<path d="M ${fx(px + cw / 2)} ${fx(py + ch + 6)} L ${fx(px + cw / 2)} ${fx(midY)} L ${fx(x + cw / 2)} ${fx(midY)} L ${fx(x + cw / 2)} ${fx(y - 14)}" stroke="${color}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${o2(p)}"/>`);
          s.push(`<path d="M ${fx(x + cw / 2 - 14)} ${fx(y - 30)} L ${fx(x + cw / 2)} ${fx(y - 10)} L ${fx(x + cw / 2 + 14)} ${fx(y - 30)}" stroke="${color}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${o2(p)}"/>`);
        }
      }
    }
    if (p <= 0.01) return;
    const { head, sub } = parts(c, id);
    s.push(`<g opacity="${o2(p)}" transform="translate(0 ${fx((1 - p) * 28)})">`);
    s.push(rect(x, y, cw, ch, kind === "decision" ? 60 : 28, C.panel, color, 4 + 3 * c.pulse(id)));
    s.push(`<circle cx="${fx(x + 44)}" cy="${fx(y + 44)}" r="24" fill="${color}"/>`);
    s.push(text(x + 44, y + 54, kind === "decision" ? "?" : String(i + 1), 28, "#06101F", { anchor: "middle", weight: 800 }));
    if (kind === "decision") s.push(text(x + 82, y + 52, "DECISION", 20, color, { weight: 800 }));
    s.push(pictogram(prm<string>(c, `${id}.icon`, ""), x + cw - 52, y + 52, 58, color, 0.95));
    const hb = block(x + cw / 2, y + 118, cw - 60, head, head.length > 26 ? 29 : 33, C.ink, 800, "middle");
    s.push(hb.svg);
    if (sub) s.push(block(x + cw / 2, y + 118 + hb.h + 12, cw - 60, sub, 24, C.dim, 500, "middle").svg);
    s.push(`</g>`);
  });
  return s.join("");
}

// ---------- organ map (schematic markers on a body outline) ----------
const ORGAN_COLORS = [C.teal, C.insulin, C.glucose, C.purple, C.green, C.red];

function drawOrganMap(c: Ctx): string {
  const { t } = c;
  const s: string[] = [];
  const cx = 960;
  const skin = "#1E4272";
  const edge = "#4B7BB0";
  for (const sg of [-1, 1]) {
    s.push(rect(cx + sg * 56 - 43, 560, 86, 250, 34, skin, edge, 3));
    s.push(rect(cx + sg * 162 - 26, 306, 52, 250, 26, skin, edge, 3));
  }
  s.push(`<path d="M ${cx - 124} 318 Q ${cx} 268 ${cx + 124} 318 Q ${cx + 130} 410 ${cx + 118} 480 Q ${cx + 120} 520 ${cx + 120} 580 L ${cx - 120} 580 Q ${cx - 120} 520 ${cx - 118} 480 Q ${cx - 130} 410 ${cx - 124} 318 Z" fill="${skin}" stroke="${edge}" stroke-width="3"/>`);
  s.push(`<circle cx="${cx}" cy="212" r="54" fill="${skin}" stroke="${edge}" stroke-width="3"/>`);
  s.push(rect(cx - 18, 256, 36, 40, 10, skin));

  const ids = idsOf(c, "o");
  const left: string[] = [];
  const right: string[] = [];
  for (const id of ids) {
    const organ = ORGANS[prm<string>(c, `${id}.organ`, "")];
    const x = organ?.at[0]?.[0] ?? 960;
    (x < 955 ? left : x > 965 ? right : left.length <= right.length ? left : right).push(id);
  }
  ids.forEach((id, i) => {
    const p = c.p(id);
    const organ = ORGANS[prm<string>(c, `${id}.organ`, "")];
    if (!organ || p <= 0.01) return;
    const color = ORGAN_COLORS[i % ORGAN_COLORS.length]!;
    const isLeft = left.includes(id);
    const slot = (isLeft ? left : right).indexOf(id);
    const cardX = isLeft ? 110 : 1250;
    const cardW = 560;
    const cardH = 150;
    const cardY = 170 + slot * (cardH + 24);
    const { head, sub } = parts(c, id);
    for (const [mx, my] of organ.at) {
      const edgeX = isLeft ? cardX + cardW : cardX;
      s.push(`<line x1="${edgeX}" y1="${cardY + cardH / 2}" x2="${mx}" y2="${my}" stroke="${color}" stroke-width="3" stroke-dasharray="8 8" opacity="${o2(p * 0.8)}"/>`);
      s.push(`<circle cx="${mx}" cy="${my}" r="${fx(30 + 7 * Math.sin(t * 3 + i) * p + 6 * c.pulse(id))}" fill="${color}" opacity="${o2(0.28 * p)}"/>`);
      s.push(`<circle cx="${mx}" cy="${my}" r="14" fill="${color}" stroke="#06101F" stroke-width="4" opacity="${o2(p)}"/>`);
    }
    s.push(`<g opacity="${o2(p)}" transform="translate(${fx((1 - p) * (isLeft ? -40 : 40))} 0)">`);
    s.push(rect(cardX, cardY, cardW, cardH, 24, C.panel, color, 4 + 3 * c.pulse(id)));
    s.push(text(cardX + 30, cardY + 50, head, 36, color, { weight: 800 }));
    if (sub) s.push(block(cardX + 30, cardY + 90, cardW - 60, sub, 24, C.ink, 500).svg);
    s.push(`</g>`);
  });
  s.push(note(c, "note", C.teal, 330, 1260, 840));
  return s.join("");
}

// ---------- registry ----------
const def = (name: string, draw: (c: Ctx) => string): TemplateDef => ({ name, elements: elementsFromItems, draw });

export const MEDICAL_TEMPLATES = {
  pathway: def("Cause → consequence pathway (flow + stat)", drawPathway),
  converge: def("Contributors converging on a conclusion", drawConverge),
  balance: def("Balance scale: insulin resistance vs β-cell reserve", drawBalance),
  body: def("Body map with organ / fat / waist call-outs", drawBody),
  "lab-branch": def("Lab test gauge → high / low interpretation", drawLabBranch),
  homa: def("HOMA-IR formula and scale", drawHoma),
  ogtt: def("OGTT glucose-pattern panels", drawOgtt),
  stagemap: def("Metabolic stage map (glucose × insulin / C-peptide)", drawStageMap),
  timeline: def("Follow-up timeline with persistent-risk band", drawTimeline),
  case: def("Clinical case board (patient · labs · interpretation · plan)", drawCase),
  algorithm: def("Clinical algorithm rail with step details", drawAlgorithm),
  compare: def("Two-sided comparison (row by row)", drawCompare),
  workflow: def("Ordered workflow: steps and decisions (diagnostic / treatment)", drawWorkflow),
  "organ-map": def("Organ map: schematic markers on a body outline", drawOrganMap),
} satisfies Record<string, TemplateDef>;


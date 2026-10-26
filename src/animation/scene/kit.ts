/** Shared drawing helpers and scene types (no template logic). Pure: no Node or DOM dependencies. */
import type { SlidePlan, TimelineEvent } from "../types.js";

export const W = 1920;
export const H = 1080;

export type SceneInput = Pick<
  SlidePlan,
  "slide" | "title" | "narration" | "slideText" | "template" | "params" | "items" | "labels" | "events" | "popups" | "durationSeconds"
>;

export interface ElementSpec {
  id: string;
  label: string;
  /** Narration phrases that trigger this element, tried in order. */
  cues: string[];
  /** Start after this element (chains the mechanism steps in order). */
  after?: string;
  gap?: number;
  dur: number;
  /**
   * A cue later than this many seconds after the previous step is ignored (so a mechanism step
   * is not dragged to a distant, unrelated mention). Default 2.5.
   */
  maxGap?: number;
  /** Only created when one of the cues is found in the narration. */
  optional?: boolean;
  /** Fallback position (fraction of the speech window) when no cue is found. */
  frac?: number;
  /** Name shown in the timeline editor. */
  description: string;
}

export interface Ctx {
  t: number;
  p: (id: string) => number;
  pulse: (id: string) => number;
  label: (id: string, fallback: string) => string;
  param: <T extends string | number | boolean>(k: string, d: T) => T;
  plan: SceneInput;
}

export interface TemplateDef {
  name: string;
  elements: (plan: SceneInput) => ElementSpec[];
  draw: (c: Ctx) => string;
}

// ---------- helpers ----------
export const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const ease = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export const fx = (n: number): string => (Math.round(n * 10) / 10).toString();
export const FONT = `font-family="Segoe UI, Calibri, Arial, sans-serif"`;

export const C = {
  bg1: "#0A1B33",
  bg2: "#10294A",
  panel: "#16365F",
  ink: "#F2F7FC",
  dim: "#9FB6D0",
  teal: "#2EC4B6",
  glucose: "#FF9F43",
  insulin: "#4DA3FF",
  red: "#E8505B",
  blood: "#7A1F2B",
  muscle: "#B5483F",
  fat: "#F2C94C",
  liver: "#8B4A2B",
  purple: "#B38CFF",
  green: "#3DDC97",
};

export function text(x: number, y: number, s: string, size: number, fill: string, opts: { anchor?: string; weight?: number; opacity?: number; italic?: boolean } = {}): string {
  return `<text x="${fx(x)}" y="${fx(y)}" ${FONT} font-size="${size}" fill="${fill}" text-anchor="${opts.anchor ?? "start"}" font-weight="${opts.weight ?? 400}" opacity="${Math.round((opts.opacity ?? 1) * 1000) / 1000}"${opts.italic ? ' font-style="italic"' : ""}>${esc(s)}</text>`;
}

/** Wrap text into lines of at most maxChars characters. */
export function wrap(s: string, maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function multiline(x: number, y: number, lines: string[], size: number, fill: string, opts: { anchor?: string; weight?: number; opacity?: number } = {}): string {
  return lines.map((l, i) => text(x, y + i * size * 1.25, l, size, fill, opts)).join("");
}

// ---------- element state ----------
export function showProgress(events: TimelineEvent[], id: string, t: number): number {
  let best: TimelineEvent | undefined;
  for (const e of events) if (e.element === id && e.action === "show" && (!best || e.start < best.start)) best = e;
  if (!best) return 0;
  return ease(clamp01((t - best.start) / Math.max(0.05, best.end - best.start)));
}

export function pulseAmount(events: TimelineEvent[], id: string, t: number): number {
  let m = 0;
  for (const e of events) {
    if (e.element !== id || e.action !== "pulse") continue;
    const k = (t - e.start) / Math.max(0.05, e.end - e.start);
    if (k >= 0 && k <= 1) m = Math.max(m, Math.sin(Math.PI * k));
  }
  return m;
}

/**
 * Small symbolic pictograms (100 x 100 design grid) for scene cards: infection, inflammation, vessels, lungs, brain, kidney,
 * heart, pressure gauge, flask, thermometer, drop, pulse line, alert, person. They are symbols chosen from a label's own words
 * (see ICONS in derive.ts); they make no anatomical claim and carry no data. Pure SVG strings, shared by Node and the browser.
 */

const S = (color: string, w = 5): string => `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

const SHAPES: Record<string, (c: string) => string> = {
  infection: (c) =>
    `<circle cx="50" cy="50" r="17" fill="${c}" opacity=".9"/>` +
    [0, 60, 120, 180, 240, 300].map((a) => { const r = (a * Math.PI) / 180; return `<line x1="${50 + Math.cos(r) * 22}" y1="${50 + Math.sin(r) * 22}" x2="${50 + Math.cos(r) * 36}" y2="${50 + Math.sin(r) * 36}" ${S(c, 6)}/><circle cx="${50 + Math.cos(r) * 40}" cy="${50 + Math.sin(r) * 40}" r="5" fill="${c}"/>`; }).join(""),
  inflammation: (c) => `<path d="M50 6 C60 26 82 36 78 62 C76 82 60 94 46 92 C30 90 20 76 24 58 C26 48 34 44 38 34 C42 26 46 18 50 6 Z" fill="${c}" opacity=".92"/><path d="M50 44 C56 56 66 60 64 72 C62 82 54 86 48 84 C40 82 38 74 42 66 C46 60 48 52 50 44 Z" fill="#06101F" opacity=".35"/>`,
  alert: (c) => `<path d="M50 10 L92 86 L8 86 Z" ${S(c, 6)}/><line x1="50" y1="38" x2="50" y2="62" ${S(c, 7)}/><circle cx="50" cy="75" r="4.5" fill="${c}"/>`,
  brain: (c) => `<path d="M50 18 C38 8 18 16 18 36 C8 42 10 58 20 62 C20 78 34 88 46 82 L46 20 Z" ${S(c)}/><path d="M50 18 C62 8 82 16 82 36 C92 42 90 58 80 62 C80 78 66 88 54 82 L54 20 Z" ${S(c)}/><path d="M28 40 C36 40 38 48 34 54 M72 40 C64 40 62 48 66 54 M32 66 C40 62 44 68 44 74 M68 66 C60 62 56 68 56 74" ${S(c, 4)}/>`,
  lungs: (c) => `<line x1="50" y1="10" x2="50" y2="44" ${S(c, 6)}/><path d="M50 44 L36 56 M50 44 L64 56" ${S(c, 5)}/><path d="M38 28 C22 30 10 56 10 76 C10 88 22 90 30 84 C40 78 42 62 42 48 Z" ${S(c)}/><path d="M62 28 C78 30 90 56 90 76 C90 88 78 90 70 84 C60 78 58 62 58 48 Z" ${S(c)}/>`,
  kidney: (c) => `<path d="M62 12 C84 16 92 44 80 68 C70 88 46 94 34 78 C24 66 36 58 44 54 C34 48 30 36 38 24 C44 14 54 10 62 12 Z" ${S(c)}/><path d="M50 52 C58 54 62 60 60 68" ${S(c, 4)}/>`,
  heart: (c) => `<path d="M50 88 C20 66 10 48 10 32 C10 18 22 10 34 10 C42 10 48 14 50 20 C52 14 58 10 66 10 C78 10 90 18 90 32 C90 48 80 66 50 88 Z" fill="${c}" opacity=".92"/>`,
  pressure: (c) => `<path d="M14 70 A38 38 0 0 1 86 70" ${S(c, 7)}/><line x1="50" y1="70" x2="34" y2="42" ${S(c, 6)}/><circle cx="50" cy="70" r="7" fill="${c}"/><path d="M26 84 H74" ${S(c, 4)}/>`,
  vessel: (c) => `<path d="M8 50 H40 L62 24 H92 M40 50 L62 76 H92" ${S(c, 9)}/><circle cx="26" cy="50" r="6" fill="${c}"/><circle cx="76" cy="24" r="6" fill="${c}"/><circle cx="76" cy="76" r="6" fill="${c}"/>`,
  flask: (c) => `<path d="M38 8 H62 M42 8 V38 L14 84 C10 92 16 94 22 94 H78 C84 94 90 92 86 84 L58 38 V8" ${S(c, 6)}/><path d="M28 70 H72" ${S(c, 5)}/><circle cx="48" cy="82" r="4" fill="${c}"/><circle cx="62" cy="78" r="3" fill="${c}"/>`,
  thermometer: (c) => `<rect x="42" y="8" width="16" height="58" rx="8" ${S(c, 5)}/><circle cx="50" cy="76" r="16" fill="${c}"/><line x1="50" y1="30" x2="50" y2="70" ${S("#06101F", 6)}/>`,
  drop: (c) => `<path d="M50 8 C50 8 20 46 20 64 C20 80 33 92 50 92 C67 92 80 80 80 64 C80 46 50 8 50 8 Z" fill="${c}" opacity=".92"/><path d="M36 66 C36 74 42 80 50 80" ${S("#06101F", 5)} opacity=".4"/>`,
  pulse: (c) => `<path d="M4 54 H28 L38 28 L52 80 L64 40 L72 54 H96" ${S(c, 6)}/>`,
  person: (c) => `<circle cx="50" cy="24" r="14" fill="${c}"/><path d="M22 90 C22 60 34 46 50 46 C66 46 78 60 78 90 Z" fill="${c}" opacity=".92"/>`,
};

export const ICON_IDS = Object.keys(SHAPES);

/** A pictogram centred at (cx, cy), `size` px wide. Unknown ids draw nothing. */
export function pictogram(id: string | undefined, cx: number, cy: number, size: number, color: string, opacity = 1): string {
  const draw = id ? SHAPES[id] : undefined;
  if (!draw) return "";
  const k = size / 100;
  const r = (n: number): string => (Math.round(n * 10) / 10).toString();
  return `<g transform="translate(${r(cx - size / 2)} ${r(cy - size / 2)}) scale(${r(k * 1000) === "0" ? 0.01 : Math.round(k * 1000) / 1000})" opacity="${Math.round(opacity * 100) / 100}">${draw(color)}</g>`;
}

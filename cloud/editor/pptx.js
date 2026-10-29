// Reads the editable structure of a PPTX and writes an EDITED copy of it.
//
// The user's uploaded PPTX is never modified. Edits live in the database as plain data; when a video is built the worker
// calls buildEditedPptx(), which produces a new PPTX (slides reordered / duplicated / deleted / added, text and positions
// changed, shapes and flowcharts added). Everything downstream (LibreOffice rendering, the animation planner, captions)
// then reads that PPTX exactly as it reads an original upload, so approved edits can never be missing from the video.
//
// Plain XML string handling is used on purpose: it is dependency free (runs inside the Vercel function) and leaves every
// part of the file it does not understand byte-for-byte untouched.
// @ts-nocheck
import JSZip from "jszip";

export const EMU_PER_PT = 12700;

export const FONTS = ["Calibri", "Arial", "Segoe UI", "Verdana", "Tahoma", "Georgia", "Cambria", "Times New Roman", "Courier New", "Trebuchet MS"];
export const SHAPE_KINDS = ["text", "rect", "round", "ellipse", "diamond", "arrow", "line", "hexagon", "cylinder"];

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
export const escapeXml = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag ?? "");
  return m ? decodeXml(m[1]) : undefined;
};

const resolveTarget = (base, target) => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};
const relsPathOf = (part) => part.replace(/([^/]+)$/, "_rels/$1.rels");

function parseRels(xml) {
  const out = [];
  for (const tag of (xml ?? "").match(/<Relationship\b[^>]*>/g) ?? []) {
    out.push({ id: attr(tag, "Id"), type: attr(tag, "Type") ?? "", target: attr(tag, "Target") ?? "", mode: attr(tag, "TargetMode"), tag });
  }
  return out;
}

// ---------------------------------------------------------------- theme colours

function themeColors(themeXml) {
  const map = {};
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(themeXml ?? "")?.[0] ?? "";
  for (const m of scheme.matchAll(/<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g)) {
    const c = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(m[2]) ?? /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(m[2]);
    if (c) map[m[1]] = `#${c[1].toUpperCase()}`;
  }
  return map;
}

function colorOf(fragment, theme, clrMap) {
  if (!fragment) return undefined;
  const rgb = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(fragment);
  if (rgb) return `#${rgb[1].toUpperCase()}`;
  const sch = /<a:schemeClr\b[^>]*val="(\w+)"/.exec(fragment);
  if (sch) {
    const name = clrMap[sch[1]] ?? sch[1];
    return theme[name];
  }
  const sys = /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(fragment);
  return sys ? `#${sys[1].toUpperCase()}` : undefined;
}

// ---------------------------------------------------------------- top-level shape splitting

const TOP_TAGS = "p:sp|p:pic|p:graphicFrame|p:grpSp|p:cxnSp";

/** Slice of the slide XML between <p:spTree> children: [{ name, start, end }] for each TOP-LEVEL shape. */
export function topLevelShapes(xml) {
  const tree = /<p:spTree\b[^>]*>/.exec(xml);
  if (!tree) return [];
  const from = tree.index + tree[0].length;
  const to = xml.lastIndexOf("</p:spTree>");
  const out = [];
  const re = new RegExp(`<(/?)(${TOP_TAGS})\\b[^>]*?(/?)>`, "g");
  re.lastIndex = from;
  let depth = 0;
  let start = -1;
  let name = "";
  for (let m = re.exec(xml); m && m.index < (to < 0 ? xml.length : to); m = re.exec(xml)) {
    const closing = m[1] === "/";
    const selfClosing = m[3] === "/";
    if (!closing) {
      if (depth === 0) {
        start = m.index;
        name = m[2];
      }
      if (selfClosing) {
        if (depth === 0) out.push({ name, start, end: m.index + m[0].length });
      } else depth++;
    } else {
      depth--;
      if (depth === 0) out.push({ name, start, end: m.index + m[0].length });
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

const cNvPrOf = (chunk) => {
  const tag = /<p:cNvPr\b[^>]*>/.exec(chunk)?.[0] ?? "";
  return { id: attr(tag, "id"), name: attr(tag, "name") ?? "" };
};

function xfrmOf(chunk, kind) {
  const holder = kind === "p:graphicFrame" ? /<p:xfrm\b[\s\S]*?<\/p:xfrm>/.exec(chunk)?.[0] : /<a:xfrm\b[\s\S]*?<\/a:xfrm>/.exec(chunk)?.[0];
  if (!holder) return undefined;
  const off = /<a:off\b[^>]*>/.exec(holder)?.[0];
  const ext = /<a:ext\b[^>]*>/.exec(holder)?.[0];
  if (!off || !ext) return undefined;
  return { x: Number(attr(off, "x")), y: Number(attr(off, "y")), cx: Number(attr(ext, "cx")), cy: Number(attr(ext, "cy")) };
}

function placeholderXfrm(ph, layoutXml, masterXml) {
  const find = (xml) => {
    if (!xml || !ph) return undefined;
    for (const s of topLevelShapes(xml)) {
      const chunk = xml.slice(s.start, s.end);
      const tag = /<p:ph\b[^>]*>/.exec(chunk)?.[0];
      if (!tag) continue;
      const sameIdx = ph.idx !== undefined && attr(tag, "idx") === ph.idx;
      const sameType = ph.idx === undefined && (attr(tag, "type") ?? "body") === (ph.type ?? "body");
      if (sameIdx || sameType) return { x: xfrmOf(chunk, s.name), chunk };
    }
    return undefined;
  };
  const hit = find(layoutXml);
  if (hit?.x) return hit.x;
  const type = ph.type ?? "body";
  const master = find(masterXml);
  if (master?.x) return master.x;
  void type;
  return undefined;
}

function defaultSizePt(ph, masterXml) {
  const style = ph && (ph.type === "title" || ph.type === "ctrTitle") ? "titleStyle" : ph ? "bodyStyle" : "otherStyle";
  const block = new RegExp(`<p:${style}>[\\s\\S]*?</p:${style}>`).exec(masterXml ?? "")?.[0] ?? "";
  const sz = /<a:lvl1pPr\b[\s\S]*?<a:defRPr\b[^>]*\bsz="(\d+)"/.exec(block)?.[1];
  if (sz) return Number(sz) / 100;
  return ph && (ph.type === "title" || ph.type === "ctrTitle") ? 36 : 18;
}

function paragraphsOf(chunk) {
  const paras = [];
  for (const p of chunk.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
    let text = "";
    for (const m of p.matchAll(/<a:t(?: [^>]*)?>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\b[^>]*\/?>(?:<\/a:br>)?/g)) {
      if (m[0].startsWith("<a:br")) text += "\n";
      else text += decodeXml(m[1] ?? "");
    }
    paras.push(text);
  }
  return paras;
}

// ---------------------------------------------------------------- reading a deck

/**
 * Editable structure of every slide in presentation order.
 * @param {Buffer|Uint8Array} buffer
 */
export async function extractDeck(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const pres = await zip.file("ppt/presentation.xml")?.async("string");
  if (!pres) throw new Error("This file is not a valid PowerPoint presentation.");
  const sz = /<p:sldSz\b[^>]*>/.exec(pres)?.[0];
  const cx = Number(attr(sz, "cx")) || 12192000;
  const cy = Number(attr(sz, "cy")) || 6858000;
  const rels = parseRels(await zip.file("ppt/_rels/presentation.xml.rels")?.async("string"));
  const entries = [];
  for (const tag of /<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.exec(pres)?.[0]?.match(/<p:sldId\b[^>]*>/g) ?? []) {
    const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const rel = rels.find((r) => r.id === rid && /\/slide$/.test(r.type));
    if (rel) entries.push(resolveTarget("ppt/presentation.xml", rel.target));
  }

  const pages = {};
  const layoutCache = new Map();
  for (const [i, entry] of entries.entries()) {
    const xml = (await zip.file(entry)?.async("string")) ?? "";
    const srels = parseRels(await zip.file(relsPathOf(entry))?.async("string"));
    const layoutPart = srels.find((r) => /\/slideLayout$/.test(r.type));
    const layoutName = layoutPart ? resolveTarget(entry, layoutPart.target) : undefined;
    let ctx = layoutCache.get(layoutName);
    if (!ctx) {
      const layoutXml = layoutName ? ((await zip.file(layoutName)?.async("string")) ?? "") : "";
      const lrels = parseRels(layoutName ? await zip.file(relsPathOf(layoutName))?.async("string") : "");
      const masterPart = lrels.find((r) => /\/slideMaster$/.test(r.type));
      const masterName = masterPart ? resolveTarget(layoutName, masterPart.target) : undefined;
      const masterXml = masterName ? ((await zip.file(masterName)?.async("string")) ?? "") : "";
      const mrels = parseRels(masterName ? await zip.file(relsPathOf(masterName))?.async("string") : "");
      const themePart = mrels.find((r) => /\/theme$/.test(r.type));
      const themeXml = themePart ? ((await zip.file(resolveTarget(masterName, themePart.target))?.async("string")) ?? "") : "";
      const theme = themeColors(themeXml);
      const clrMap = {};
      const mapTag = /<p:clrMap\b[^>]*>/.exec(masterXml)?.[0] ?? "";
      for (const m of mapTag.matchAll(/(\w+)="(\w+)"/g)) clrMap[m[1]] = m[2];
      ctx = { layoutXml, masterXml, theme, clrMap, layoutName };
      layoutCache.set(layoutName, ctx);
    }
    const { layoutXml, masterXml, theme, clrMap } = ctx;

    const bgOf = (src) => {
      const bg = /<p:bg>[\s\S]*?<\/p:bg>/.exec(src)?.[0];
      if (!bg) return undefined;
      const fill = /<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(bg)?.[0];
      return colorOf(fill, theme, clrMap);
    };
    const bg = bgOf(xml) ?? bgOf(layoutXml) ?? bgOf(masterXml) ?? theme[clrMap.bg1 ?? "lt1"] ?? "#FFFFFF";

    const shapes = [];
    for (const s of topLevelShapes(xml)) {
      const chunk = xml.slice(s.start, s.end);
      const { id, name } = cNvPrOf(chunk);
      if (id === undefined) continue;
      const phTag = /<p:ph\b[^>]*>/.exec(chunk)?.[0];
      const ph = phTag ? { type: attr(phTag, "type"), idx: attr(phTag, "idx") } : undefined;
      let x = xfrmOf(chunk, s.name);
      if (!x && ph) x = placeholderXfrm(ph, layoutXml, masterXml);
      if (!x) continue;
      const frac = { x: x.x / cx, y: x.y / cy, w: x.cx / cx, h: x.cy / cy };
      const base = { id, name, ...frac };
      if (s.name === "p:sp") {
        const paras = paragraphsOf(chunk);
        const hasText = paras.some((p) => p.trim());
        // Run properties of the first run; some generators (python-pptx style) put them in the paragraph's <a:defRPr> instead.
        const rPr = /<a:(rPr|defRPr)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/.exec(chunk)?.[0] ?? "";
        const pPr = /<a:pPr\b[^>]*>/.exec(chunk)?.[0] ?? "";
        const szAttr = attr(rPr, "sz");
        const algn = attr(pPr, "algn");
        const spPr = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(chunk)?.[0] ?? "";
        const fill = colorOf(/<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, ""))?.[0], theme, clrMap);
        shapes.push({
          ...base,
          kind: hasText ? "text" : "shape",
          ...(ph ? { ph: ph.type ?? "body" } : {}),
          paras: hasText ? paras : [],
          size: szAttr ? Number(szAttr) / 100 : defaultSizePt(ph, masterXml),
          font: /<a:latin\b[^>]*typeface="([^"]*)"/.exec(rPr)?.[1] ?? "",
          bold: attr(rPr, "b") === "1",
          italic: attr(rPr, "i") === "1",
          color: colorOf(/<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(rPr)?.[0], theme, clrMap) ?? (ph ? undefined : undefined),
          align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left",
          ...(fill ? { fill } : {}),
        });
      } else if (s.name === "p:pic") shapes.push({ ...base, kind: "picture" });
      else if (s.name === "p:graphicFrame") shapes.push({ ...base, kind: /<a:tbl>/.test(chunk) ? "table" : "chart" });
      else if (s.name === "p:grpSp") shapes.push({ ...base, kind: "group" });
      else shapes.push({ ...base, kind: "line" });
    }
    pages[String(i + 1)] = { bg, shapes };
  }
  return { slideSize: { cx, cy }, pageCount: entries.length, pages };
}

// ---------------------------------------------------------------- writing an edited deck

const rgbOnly = (c) => String(c ?? "").replace("#", "").toUpperCase();
const emu = (frac, total) => Math.round(frac * total);

function fillXml(c) {
  return /^#[0-9A-Fa-f]{6}$/.test(c ?? "") ? `<a:solidFill><a:srgbClr val="${rgbOnly(c)}"/></a:solidFill>` : "<a:noFill/>";
}

function runPropsXml(e, tagName = "a:rPr") {
  const attrs = ['lang="en-US"'];
  if (e.size) attrs.push(`sz="${Math.round(e.size * 100)}"`);
  if (e.bold !== undefined) attrs.push(`b="${e.bold ? 1 : 0}"`);
  if (e.italic !== undefined) attrs.push(`i="${e.italic ? 1 : 0}"`);
  attrs.push('dirty="0"');
  const inner = [];
  if (/^#[0-9A-Fa-f]{6}$/.test(e.color ?? "")) inner.push(`<a:solidFill><a:srgbClr val="${rgbOnly(e.color)}"/></a:solidFill>`);
  if (e.font) inner.push(`<a:latin typeface="${escapeXml(e.font)}"/><a:cs typeface="${escapeXml(e.font)}"/>`);
  return inner.length ? `<${tagName} ${attrs.join(" ")}>${inner.join("")}</${tagName}>` : `<${tagName} ${attrs.join(" ")}/>`;
}

const ALGN = { left: "l", center: "ctr", right: "r", justify: "just" };

/** Paragraph XML. `base` is the original paragraph (to inherit bullets/indent/run look from), may be undefined. */
function paragraphXml(text, base, fmt) {
  const lines = String(text).split("\n");
  const basePPr = /<a:pPr\b[\s\S]*?(?:\/>|<\/a:pPr>)/.exec(base ?? "")?.[0] ?? "";
  let pPr = basePPr;
  if (fmt.align && ALGN[fmt.align]) {
    if (/\balgn="/.test(pPr)) pPr = pPr.replace(/\balgn="[^"]*"/, `algn="${ALGN[fmt.align]}"`);
    else if (pPr) pPr = pPr.replace(/^<a:pPr\b/, `<a:pPr algn="${ALGN[fmt.align]}"`);
    else pPr = `<a:pPr algn="${ALGN[fmt.align]}"/>`;
  }
  const baseRPr = /<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/.exec(base ?? "")?.[0];
  const hasFmt = fmt.size || fmt.bold !== undefined || fmt.italic !== undefined || fmt.color || fmt.font;
  const rPr = hasFmt ? mergeRPr(baseRPr, fmt) : (baseRPr ?? '<a:rPr lang="en-US" dirty="0"/>');
  const runs = lines.map((l, i) => `${i ? `<a:br>${rPr}</a:br>` : ""}<a:r>${rPr}<a:t>${escapeXml(l)}</a:t></a:r>`);
  return `<a:p>${pPr}${runs.join("")}</a:p>`;
}

/** Original run properties overlaid with the user's formatting. */
function mergeRPr(baseRPr, fmt) {
  if (!baseRPr) return runPropsXml(fmt);
  const open = /^<a:rPr\b([^>]*?)(\/?)>/.exec(baseRPr);
  let attrs = open?.[1] ?? "";
  const setAttr = (name, value) => {
    attrs = new RegExp(`\\b${name}="`).test(attrs) ? attrs.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`) : `${attrs} ${name}="${value}"`;
  };
  if (fmt.size) setAttr("sz", Math.round(fmt.size * 100));
  if (fmt.bold !== undefined) setAttr("b", fmt.bold ? 1 : 0);
  if (fmt.italic !== undefined) setAttr("i", fmt.italic ? 1 : 0);
  let inner = open?.[2] === "/" ? "" : baseRPr.replace(/^<a:rPr\b[^>]*>/, "").replace(/<\/a:rPr>$/, "");
  if (/^#[0-9A-Fa-f]{6}$/.test(fmt.color ?? "")) {
    inner = inner.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, "");
    inner = `<a:solidFill><a:srgbClr val="${rgbOnly(fmt.color)}"/></a:solidFill>` + inner;
  }
  if (fmt.font) {
    inner = inner.replace(/<a:latin\b[^>]*\/>/, "").replace(/<a:cs\b[^>]*\/>/, "");
    inner = inner + `<a:latin typeface="${escapeXml(fmt.font)}"/><a:cs typeface="${escapeXml(fmt.font)}"/>`;
  }
  return inner ? `<a:rPr${attrs}>${inner}</a:rPr>` : `<a:rPr${attrs}/>`;
}

function setXfrm(chunk, kind, g, size) {
  const x = emu(g.x, size.cx);
  const y = emu(g.y, size.cy);
  const cx = Math.max(1, emu(g.w, size.cx));
  const cy = Math.max(1, emu(g.h, size.cy));
  const off = `<a:off x="${x}" y="${y}"/>`;
  const ext = `<a:ext cx="${cx}" cy="${cy}"/>`;
  if (kind === "p:graphicFrame") {
    if (/<p:xfrm\b/.test(chunk)) return chunk.replace(/(<p:xfrm\b[^>]*>)[\s\S]*?(<\/p:xfrm>)/, `$1${off}${ext}$2`);
    return chunk;
  }
  if (/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/.test(chunk)) {
    return chunk.replace(/(<a:xfrm\b[^>]*>)([\s\S]*?)(<\/a:xfrm>)/, (_m, open, inner, close) => {
      const keep = inner.replace(/<a:off\b[^>]*\/>/, "").replace(/<a:ext\b[^>]*\/>/, "");
      return `${open}${off}${ext}${keep}${close}`;
    });
  }
  const spPr = kind === "p:grpSp" ? "p:grpSpPr" : "p:spPr";
  const holder = `<a:xfrm>${off}${ext}</a:xfrm>`;
  if (new RegExp(`<${spPr}\\s*/>`).test(chunk)) return chunk.replace(new RegExp(`<${spPr}\\s*/>`), `<${spPr}>${holder}</${spPr}>`);
  return chunk.replace(new RegExp(`(<${spPr}\\b[^>]*>)`), `$1${holder}`);
}

function applyShapeEdit(chunk, kind, edit, size, original) {
  let out = chunk;
  if (edit.x !== undefined || edit.y !== undefined || edit.w !== undefined || edit.h !== undefined) {
    const o = original ?? { x: 0, y: 0, w: 0.2, h: 0.1 };
    out = setXfrm(out, kind, { x: edit.x ?? o.x, y: edit.y ?? o.y, w: edit.w ?? o.w, h: edit.h ?? o.h }, size);
  }
  const fmt = { size: edit.size, bold: edit.bold, italic: edit.italic, color: edit.color, font: edit.font, align: edit.align };
  const hasFmt = Object.values(fmt).some((v) => v !== undefined && v !== "");
  if ((edit.text !== undefined || hasFmt) && kind === "p:sp" && /<p:txBody>|<p:txBody\s/.test(out)) {
    const body = /<p:txBody\b[\s\S]*?<\/p:txBody>/.exec(out)?.[0];
    if (body) {
      const origParas = body.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
      const texts = edit.text ?? paragraphsOf(body);
      const lead = body.replace(/<a:p\b[\s\S]*<\/a:p>/, "\u0000");
      const paras = texts.map((t, i) => paragraphXml(t, origParas[Math.min(i, origParas.length - 1)] ?? origParas[0], fmt));
      const rebuilt = lead.includes("\u0000") ? lead.replace("\u0000", paras.join("")) : body.replace("</p:txBody>", `${paras.join("")}</p:txBody>`);
      out = out.replace(body, () => rebuilt);
    }
  }
  if (edit.fill !== undefined && kind === "p:sp") {
    out = out.replace(/(<p:spPr\b[^>]*>)([\s\S]*?)(<\/p:spPr>)/, (_m, a, inner, z) => {
      const ln = /<a:ln\b[\s\S]*?<\/a:ln>|<a:ln\b[^>]*\/>/.exec(inner)?.[0] ?? "";
      let rest = ln ? inner.replace(ln, "\u0001") : inner;
      rest = rest.replace(/<a:(solidFill|gradFill|blipFill|pattFill)\b[\s\S]*?<\/a:\1>|<a:noFill\/>/g, "");
      const geom = /<a:prstGeom\b[\s\S]*?<\/a:prstGeom>|<a:custGeom\b[\s\S]*?<\/a:custGeom>/.exec(rest);
      const at = geom ? geom.index + geom[0].length : rest.includes("</a:xfrm>") ? rest.indexOf("</a:xfrm>") + 9 : 0;
      rest = rest.slice(0, at) + fillXml(edit.fill) + rest.slice(at);
      return a + (ln ? rest.replace("\u0001", () => ln) : rest) + z;
    });
  }
  return out;
}

export { applyShapeEdit, paragraphXml, fillXml, rgbOnly, emu, cNvPrOf, parseRels, resolveTarget, relsPathOf };


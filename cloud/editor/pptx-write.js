// Writes an EDITED copy of a PPTX from the editor's slide list (see pptx.js for the reader and the reasoning).
// @ts-nocheck
import JSZip from "jszip";
import {
  EMU_PER_PT, applyShapeEdit, cNvPrOf, emu, escapeXml, extractDeck, fillXml, paragraphXml, parseRels, relsPathOf, resolveTarget, rgbOnly, topLevelShapes,
} from "./pptx.js";

const PRST = { rect: "rect", text: "rect", round: "roundRect", ellipse: "ellipse", diamond: "diamond", hexagon: "hexagon", cylinder: "can" };
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** XML of one element added in the editor (text box, shape, flowchart box or connector). */
function addedElementXml(el, id, size) {
  const name = escapeXml(`${el.type === "line" || el.type === "arrow" ? "Arrow" : "Shape"} ${el.id}`);
  if (el.type === "line" || el.type === "arrow") {
    // A connector from (x1,y1) to (x2,y2): stored as a box plus flips so the arrow points the right way.
    const x1 = emu(el.x1 ?? el.x, size.cx);
    const y1 = emu(el.y1 ?? el.y, size.cy);
    const x2 = emu(el.x2 ?? el.x + el.w, size.cx);
    const y2 = emu(el.y2 ?? el.y + el.h, size.cy);
    const flip = `${x2 < x1 ? ' flipH="1"' : ""}${y2 < y1 ? ' flipV="1"' : ""}`;
    const color = rgbOnly(HEX.test(el.color ?? "") ? el.color : "#334155");
    const width = Math.round((el.lineWidth ?? 2.5) * EMU_PER_PT);
    return (
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
      `<p:spPr><a:xfrm${flip}><a:off x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}"/><a:ext cx="${Math.abs(x2 - x1)}" cy="${Math.abs(y2 - y1)}"/></a:xfrm>` +
      `<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="${width}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
      `${el.type === "arrow" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : ""}</a:ln></p:spPr></p:cxnSp>`
    );
  }
  const geom = PRST[el.type] ?? "rect";
  const isText = el.type === "text";
  const fill = isText ? (el.fill ? fillXml(el.fill) : "<a:noFill/>") : fillXml(el.fill || "#E0F2FE");
  const line = isText && !el.stroke
    ? "<a:ln><a:noFill/></a:ln>"
    : `<a:ln w="${Math.round(2 * EMU_PER_PT)}"><a:solidFill><a:srgbClr val="${rgbOnly(HEX.test(el.stroke ?? "") ? el.stroke : "#0369A1")}"/></a:solidFill></a:ln>`;
  const fmt = { size: el.size || 18, bold: el.bold, italic: el.italic, color: el.color || "#0F172A", font: el.font || "Calibri", align: el.align || (isText ? "left" : "center") };
  const body = String(el.text ?? "").split(/\n/).map((t) => paragraphXml(t, undefined, fmt)).join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${isText ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${emu(el.x, size.cx)}" y="${emu(el.y, size.cy)}"/><a:ext cx="${Math.max(1, emu(el.w, size.cx))}" cy="${Math.max(1, emu(el.h, size.cy))}"/></a:xfrm>` +
    `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${isText ? "t" : "ctr"}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
  );
}

const BLANK_SLIDE = (bg) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  `<p:cSld>${bg ? `<p:bg><p:bgPr>${fillXml(bg)}<a:effectLst/></p:bgPr></p:bg>` : ""}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>' +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";

export function hasVisualEdits(e) {
  return Boolean(e && ((e.shapes && Object.keys(e.shapes).length) || e.added?.length || e.bg));
}

/** True when the slide list differs from the untouched upload (order, count or any visual edit). */
export function hasDeckEdits(slides, originalPageCount) {
  if (!slides?.length) return false;
  if (originalPageCount !== undefined && slides.length !== originalPageCount) return true;
  return slides.some((s, i) => !s.origin || s.origin.page !== i + 1 || hasVisualEdits(s.edits));
}

/**
 * The edited PPTX.
 * @param {Buffer|Uint8Array} buffer original upload
 * @param {Array<{ origin: { page: number } | null, edits?: any }>} slides the slide list in final order
 * @param {{ pages?: Record<string, { shapes: any[] }>, slideSize?: { cx: number, cy: number } }} [deck] extracted structure (computed when omitted)
 */
export async function buildEditedPptx(buffer, slides, deck) {
  deck ??= await extractDeck(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const size = deck.slideSize;

  const pres = await zip.file("ppt/presentation.xml").async("string");
  const presRels = parseRels(await zip.file("ppt/_rels/presentation.xml.rels").async("string"));
  const pageEntries = [];
  for (const tag of /<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.exec(pres)?.[0]?.match(/<p:sldId\b[^>]*>/g) ?? []) {
    const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const rel = presRels.find((r) => r.id === rid && /\/slide$/.test(r.type));
    if (rel) pageEntries.push(resolveTarget("ppt/presentation.xml", rel.target));
  }
  const orig = [];
  for (const entry of pageEntries) {
    orig.push({ xml: await zip.file(entry).async("string"), rels: parseRels(await zip.file(relsPathOf(entry))?.async("string")) });
  }
  // New slides use the layout the first slide uses.
  const blankLayout = orig[0]?.rels.find((r) => /\/slideLayout$/.test(r.type))?.target ?? "../slideLayouts/slideLayout1.xml";

  // Remove the old slide parts, their relationships and notes (notes pages would be shared by duplicates and are not needed for video).
  for (const entry of pageEntries) {
    zip.remove(entry);
    zip.remove(relsPathOf(entry));
  }
  for (const name of Object.keys(zip.files)) if (/^ppt\/notesSlides\//.test(name)) zip.remove(name);

  const newParts = [];
  for (const [i, s] of slides.entries()) {
    const page = s.origin ? orig[s.origin.page - 1] : undefined;
    if (s.origin && !page) throw new Error(`Slide ${i + 1} refers to page ${s.origin.page}, which the uploaded presentation does not have.`);
    let xml = page ? page.xml : BLANK_SLIDE(s.edits?.bg);
    const rels = page
      ? page.rels.filter((r) => !/\/notesSlide$/.test(r.type)).map((r) => r.tag)
      : [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${blankLayout}"/>`];
    const edits = s.edits ?? {};

    if (page && edits.bg) {
      const bg = `<p:bg><p:bgPr>${fillXml(edits.bg)}<a:effectLst/></p:bgPr></p:bg>`;
      xml = /<p:bg>[\s\S]*?<\/p:bg>/.test(xml) ? xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, () => bg) : xml.replace(/(<p:cSld\b[^>]*>)/, (m) => m + bg);
    }
    const shapeDefs = new Map((deck.pages?.[String(s.origin?.page)]?.shapes ?? []).map((sh) => [String(sh.id), sh]));
    if (edits.shapes && page) {
      // Back to front so earlier offsets stay valid.
      for (const t of topLevelShapes(xml).reverse()) {
        const chunk = xml.slice(t.start, t.end);
        const id = cNvPrOf(chunk).id;
        const e = id !== undefined ? edits.shapes[id] : undefined;
        if (!e) continue;
        const next = e.deleted ? "" : applyShapeEdit(chunk, t.name, e, size, shapeDefs.get(String(id)));
        xml = xml.slice(0, t.start) + next + xml.slice(t.end);
      }
    }
    if (edits.added?.length) {
      let nextId = Math.max(1, ...[...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
      const added = edits.added.map((el) => addedElementXml(el, nextId++, size)).join("");
      xml = xml.replace(/<\/p:spTree>/, () => `${added}</p:spTree>`);
    }
    const part = `ppt/slides/slide${i + 1}.xml`;
    zip.file(part, xml);
    zip.file(relsPathOf(part), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
    newParts.push(part);
  }

  // presentation.xml: the new slide list. Sections and custom shows would still name the old slides, so they are dropped.
  const rels2 = presRels.filter((r) => !/\/slide$/.test(r.type)).map((r) => r.tag);
  const ids = [];
  newParts.forEach((_p, i) => {
    rels2.push(`<Relationship Id="rIdSlide${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`);
  });
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels2.join("")}</Relationships>`);
  let pres2 = pres.replace(/<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\s*\/>/, () => `<p:sldIdLst>${ids.join("")}</p:sldIdLst>`);
  pres2 = pres2.replace(/<p:custShowLst\b[\s\S]*?<\/p:custShowLst>/, "").replace(/<p:ext\b[^>]*uri="\{521415D9-36F7-43E2-AB2F-B90AF26B5E84\}"[\s\S]*?<\/p:ext>/, "");
  zip.file("ppt/presentation.xml", pres2);

  let ct = await zip.file("[Content_Types].xml").async("string");
  ct = ct.replace(/<Override\b[^>]*PartName="\/ppt\/(?:slides\/slide\d+|notesSlides\/[^"]*)\.xml"[^>]*\/>/g, "");
  const overrides = newParts.map((p) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  ct = ct.replace("</Types>", () => `${overrides}</Types>`);
  zip.file("[Content_Types].xml", ct);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

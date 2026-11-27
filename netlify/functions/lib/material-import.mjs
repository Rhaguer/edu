/**
 * Extracción segura de texto seleccionable desde PDF (unpdf) y PowerPoint .pptx (JSZip)
 * sin ejecutar contenido ni permitir XXE, macros VBA o path traversal.
 * Equivalencia exacta con apps/api/material_import.py y _extract_pdf de main.py.
 */

import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import { HttpError } from "./http-utils.mjs";
import { isSafeZipEntry, isXmlSafe } from "./native-core.mjs";

export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_PAGES = 100;
export const MAX_TEXT = 1_000_000;
export const MAX_UNCOMPRESSED = 200 * 1024 * 1024;

export const LEGACY_MAX_PDF_BYTES = 8 * 1024 * 1024;
export const LEGACY_MAX_PDF_PAGES = 40;
export const LEGACY_MAX_CONTEXT = 50_000;

function decodeXmlEntities(str) {
  return String(str || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function assertSafeXml(buf) {
  if (!isXmlSafe(buf)) {
    throw new Error("El archivo contiene una estructura XML no admitida.");
  }
  return Buffer.from(buf).toString("utf8");
}

function extractAttr(tagText, attrName) {
  const re = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = tagText.match(re);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? "") : "";
}

async function extractPdfPagesRaw(bytes, maxPages) {
  const header = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (header !== "%PDF-") {
    throw new Error("El archivo no es un PDF válido.");
  }
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const msg = String(err?.message || err || "").toLowerCase();
    if (msg.includes("password") || msg.includes("encrypt")) {
      throw new Error("El PDF está protegido. Carga una copia sin contraseña.");
    }
    throw err;
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  if (totalPages > maxPages) {
    throw new Error(`Divide el documento en archivos de hasta ${maxPages} páginas.`);
  }
  const list = Array.isArray(text) ? text : [String(text || "")];
  return list.map((pageText, idx) => ({
    number: idx + 1,
    label: `Página ${idx + 1}`,
    text: String(pageText || "").trim(),
  }));
}

async function extractPptxPagesRaw(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 5000) {
    throw new Error("La presentación contiene demasiados datos descomprimidos.");
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (!isSafeZipEntry(entry.name)) {
      if (entry.name.toLowerCase().includes("vbaproject")) {
        throw new Error("Carga una presentación .pptx sin macros.");
      }
      throw new Error("La presentación contiene archivos internos no admitidos.");
    }
    const estSize = Number(entry._data?.uncompressedSize || 0);
    totalUncompressed += estSize;
    if (totalUncompressed > MAX_UNCOMPRESSED) {
      throw new Error("La presentación contiene demasiados datos descomprimidos.");
    }
  }

  const presFile = zip.file("ppt/presentation.xml");
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  if (!presFile || !relsFile) {
    throw new Error("El archivo no es una presentación PowerPoint válida.");
  }

  const relsXml = assertSafeXml(await relsFile.async("uint8array"));
  const presXml = assertSafeXml(await presFile.async("uint8array"));

  const relations = new Map();
  const relRe = /<Relationship\b([^>]*?)\/?>/gi;
  let m;
  while ((m = relRe.exec(relsXml)) !== null) {
    const attrs = m[1];
    const targetMode = extractAttr(attrs, "TargetMode");
    if (targetMode === "External") continue;
    const id = extractAttr(attrs, "Id");
    const target = extractAttr(attrs, "Target");
    if (id && target) relations.set(id, target);
  }

  const slideRelIds = [];
  const sldRe = /<(?:\w+:)?sldId\b([^>]*?)\/?>/gi;
  while ((m = sldRe.exec(presXml)) !== null) {
    const attrs = m[1];
    const rid = extractAttr(attrs, "(?:[a-zA-Z0-9_]+:)?id");
    if (rid) slideRelIds.push(rid);
  }
  if (slideRelIds.length > MAX_PAGES) {
    throw new Error("Divide la presentación en archivos de hasta 100 diapositivas.");
  }

  const pages = [];
  for (let i = 0; i < slideRelIds.length; i++) {
    const target = relations.get(slideRelIds[i]);
    if (!target) {
      throw new Error("No se pudo localizar una diapositiva de la presentación.");
    }
    const part = target.startsWith("/") ? target.replace(/^\/+/, "") : `ppt/${target}`;
    if (!isSafeZipEntry(part) || !/^ppt\/slides\/slide\d+\.xml$/.test(part)) {
      throw new Error("La presentación contiene una referencia de diapositiva no admitida.");
    }
    const slideEntry = zip.file(part);
    if (!slideEntry) {
      throw new Error("No se pudo localizar una diapositiva de la presentación.");
    }
    const slideXml = assertSafeXml(await slideEntry.async("uint8array"));
    const pieces = [];
    const textRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
    let tm;
    while ((tm = textRe.exec(slideXml)) !== null) {
      const cleaned = decodeXmlEntities(tm[1]).trim();
      if (cleaned) pieces.push(cleaned);
    }
    pages.push({
      number: i + 1,
      label: `Diapositiva ${i + 1}`,
      text: pieces.join("\n").trim(),
    });
  }

  return pages;
}

export async function extractPages(filename, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
    throw new Error("Carga un archivo de hasta 40 MB que contenga texto seleccionable.");
  }
  const cleanName = String(filename || "").replace(/\\/g, "/");
  const dot = cleanName.lastIndexOf(".");
  const suffix = dot >= 0 ? cleanName.slice(dot).toLowerCase() : "";
  if (suffix !== ".pdf" && suffix !== ".pptx") {
    throw new Error("Usa un PDF o una presentación PowerPoint .pptx.");
  }

  let pages;
  try {
    pages = suffix === ".pdf" ? await extractPdfPagesRaw(bytes, MAX_PAGES) : await extractPptxPagesRaw(bytes);
  } catch (err) {
    if (err instanceof Error && /PDF|protegido|páginas|diapositivas|PowerPoint|macros|XML|no admitid/i.test(err.message)) {
      throw err;
    }
    throw new Error("No pudimos leer el archivo. Usa una copia válida con texto seleccionable.");
  }

  if (!pages.length || !pages.some((p) => p.text.trim().length > 0)) {
    throw new Error("El archivo no tiene texto seleccionable. Puedes pegar su contenido como texto.");
  }
  const totalLen = pages.reduce((acc, p) => acc + p.text.length, 0);
  if (totalLen > MAX_TEXT) {
    throw new Error("El documento contiene demasiado texto. Carga una sección más breve.");
  }
  return { kind: suffix.slice(1), pages };
}

export async function extractLegacySourcePdf(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (bytes.length > LEGACY_MAX_PDF_BYTES) {
    throw new HttpError(413, "El PDF supera el límite de 8 MB.");
  }
  const header = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (header !== "%PDF-") {
    throw new HttpError(422, "El archivo no es un PDF válido.");
  }
  let rawPages;
  try {
    rawPages = await extractPdfPagesRaw(bytes, LEGACY_MAX_PDF_PAGES);
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("protegido")) {
      throw new HttpError(422, "El PDF está protegido. Usa un PDF sin contraseña.");
    }
    if (msg.includes("páginas")) {
      throw new HttpError(413, "Carga una sección del PDF de hasta 40 páginas.");
    }
    throw new HttpError(422, "El PDF no se pudo leer. Puedes pegar el texto en su lugar.");
  }
  const pages = [];
  let length = 0;
  for (const p of rawPages) {
    if (p.text) {
      length += p.text.length + (pages.length ? 2 : 0);
      if (length > LEGACY_MAX_CONTEXT) {
        throw new HttpError(413, "Carga una sección del PDF de hasta 50.000 caracteres.");
      }
      pages.push(p.text);
    }
  }
  if (!pages.length) {
    throw new HttpError(422, "El PDF no tiene texto seleccionable. Puedes pegar el texto en su lugar.");
  }
  return pages.join("\n\n");
}

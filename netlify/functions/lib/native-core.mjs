/**
 * Núcleo determinista de seguridad y verificación documental de EduAndes AI
 * (equivalencia exacta 1:1 con apps/native/eduandes_core.cpp + native_core.py + text_safety.py).
 *
 * Incluye:
 * - Comparación en tiempo constante (crypto.timingSafeEqual)
 * - Escáner de marcadores reservados de chat / bytes NUL
 * - Guardia XML anti-XXE (<!DOCTYPE / <!ENTITY / límite 10 MiB)
 * - Guardia ZIP anti-traversal / anti-macros VBA
 * - Normalización UTF-8 español (diacríticos, minúsculas, signos)
 * - Búsqueda exacta de citas literales con índices por carácter y fallback de artículos
 * - Verificación O(N) de distinción 8-gram con FNV-1a de 64 bits
 */

import crypto from "node:crypto";

export const CORE_VERSION = "eduandes-core-netlify/1.0.0";

export const RESERVED_TEXT = [
  "<|im_start|>",
  "<|im_end|>",
  "<|endoftext|>",
  "<think>",
  "</think>",
];

export const SPANISH_STOPWORDS = new Set([
  "como", "para", "desde", "entre", "sobre", "hacia", "hasta", "mediante", "segun",
  "esta", "este", "estos", "estas", "esto", "cada", "otro", "otra", "otros", "otras",
  "puede", "pueden", "debe", "deben", "tiene", "tienen", "tener", "hacer", "seria", "seran",
  "tambien", "donde", "cuando", "porque", "cual", "cuales", "mismo", "misma", "solo",
  "distinguir", "comprender", "identificar", "conocer", "analizar", "explicar", "aplicar",
  "reconocer", "relacionar", "interpretar", "utilizar", "objetivo", "objetivos", "unidad", "curso",
]);

export function nativeStatus() {
  return {
    active: true,
    backend: "netlify-v8-native",
    version: CORE_VERSION,
    library: "native-core.mjs (1:1 C++20 spec)",
    size_bytes: 0,
  };
}

export function ctEqual(left, right) {
  const lb = Buffer.isBuffer(left)
    ? left
    : left instanceof Uint8Array
      ? Buffer.from(left)
      : Buffer.from(String(left), "utf8");
  const rb = Buffer.isBuffer(right)
    ? right
    : right instanceof Uint8Array
      ? Buffer.from(right)
      : Buffer.from(String(right), "utf8");
  if (lb.length !== rb.length) return false;
  return crypto.timingSafeEqual(lb, rb);
}

export function hasReservedMarkers(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.includes("\0")) return true;
  for (const marker of RESERVED_TEXT) {
    if (text.includes(marker)) return true;
  }
  return false;
}

export function rejectChatMarkers(text) {
  if (hasReservedMarkers(text)) {
    throw new Error("La entrada contiene un marcador reservado del modelo.");
  }
}

export function isXmlSafe(data) {
  const buf = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(String(data), "utf8");
  if (buf.length > 10 * 1024 * 1024) return false;
  if (buf.includes(0)) return false;
  const upper = buf.toString("latin1").toUpperCase();
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) return false;
  return true;
}

export function isSafeZipEntry(entryPath) {
  if (typeof entryPath !== "string" || !entryPath || entryPath.length > 4096) return false;
  if (entryPath.includes("\0")) return false;
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false;
  if (entryPath.length >= 2 && /[a-zA-Z]/.test(entryPath[0]) && entryPath[1] === ":") return false;
  if (entryPath.toLowerCase().includes("vbaproject")) return false;
  const parts = entryPath.replace(/\\/g, "/").split("/");
  return !parts.includes("..");
}

export function normalizeWhitespace(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

/**
 * Normaliza texto español: NFKD sin marcas diacríticas, minúsculas, signos a espacio y colapso.
 */
export function normalized(value) {
  const folded = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return folded.replace(/[^\p{L}\p{N}_]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function contentKey(text) {
  return normalized(text);
}

export function wordTokens(text) {
  const plain = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tokens = plain.match(/[a-z0-9]{4,}/g) || [];
  const out = new Set();
  for (const t of tokens) {
    if (!SPANISH_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch) {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Localiza `needle` dentro de `source` de forma literal (insensible a saltos/espacios)
 * o mediante límites de palabra normalizados en español (con fallback sin artículo inicial).
 * Devuelve `{ start, end, text }` o `null`.
 */
export function findLiteralSpan(source, needle) {
  if (typeof source !== "string" || typeof needle !== "string") return null;
  const words = needle.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const pattern = new RegExp(words.map(escapeRegex).join("\\s+"), "i");
  const verbatim = pattern.exec(source);
  if (verbatim) {
    return {
      start: verbatim.index,
      end: verbatim.index + verbatim[0].length,
      text: verbatim[0],
    };
  }

  // Mapeo normalizado -> índice UTF-16 original en `source`
  const normChars = [];
  const origIndices = [];
  let prevSpace = true;
  for (let idx = 0; idx < source.length; idx++) {
    const folded = source[idx]
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
    for (const piece of folded) {
      if (isWordChar(piece)) {
        normChars.push(piece);
        origIndices.push(idx);
        prevSpace = false;
      } else if (!prevSpace) {
        normChars.push(" ");
        origIndices.push(idx);
        prevSpace = true;
      }
    }
  }
  while (normChars.length && normChars[normChars.length - 1] === " ") {
    normChars.pop();
    origIndices.pop();
  }
  const normSource = normChars.join("");
  const ndlNorm = normalized(needle);
  const candidates = [
    ndlNorm,
    ndlNorm.replace(/^(?:el|la|los|las|un|una|unos|unas)\s+/, ""),
  ];

  for (const cand of candidates) {
    if (!cand || cand.length < 3 || cand.length > normSource.length) continue;
    let pos = 0;
    while ((pos = normSource.indexOf(cand, pos)) !== -1) {
      const end = pos + cand.length;
      const leftOk = pos === 0 || !isWordChar(normSource[pos - 1]);
      const rightOk = end === normSource.length || !isWordChar(normSource[end]);
      if (leftOk && rightOk) {
        const startPos = origIndices[pos];
        const endPos = origIndices[end - 1] + 1;
        return {
          start: startPos,
          end: endPos,
          text: source.slice(startPos, endPos).trim(),
        };
      }
      pos += 1;
    }
  }
  return null;
}

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1aStep(h, word) {
  for (let i = 0; i < word.length; i++) {
    h ^= BigInt(word.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME) & MASK_64;
  }
  h ^= 0xffn;
  h = (h * FNV_PRIME) & MASK_64;
  return h;
}

/**
 * Verifica que dos textos no sean iguales y no compartan ninguna secuencia de 8 palabras
 * consecutivas (FNV-1a 64-bit con verificación exacta, idéntico a ea_is_distinct_8gram).
 */
export function isDistinct8Gram(left, right) {
  const nl = normalized(left);
  const nr = normalized(right);
  if (nl === nr) return false;
  const wa = nl ? nl.split(" ") : [];
  const wb = nr ? nr.split(" ") : [];
  if (wa.length < 8 || wb.length < 8) return true;

  const hashes = new Set();
  for (let i = 0; i + 8 <= wa.length; i++) {
    let h = FNV_OFFSET;
    for (let k = 0; k < 8; k++) h = fnv1aStep(h, wa[i + k]);
    hashes.add(h);
  }
  for (let i = 0; i + 8 <= wb.length; i++) {
    let h = FNV_OFFSET;
    for (let k = 0; k < 8; k++) h = fnv1aStep(h, wb[i + k]);
    if (hashes.has(h)) {
      for (let aIdx = 0; aIdx + 8 <= wa.length; aIdx++) {
        let same = true;
        for (let k = 0; k < 8; k++) {
          if (wa[aIdx + k] !== wb[i + k]) {
            same = false;
            break;
          }
        }
        if (same) return false;
      }
    }
  }
  return true;
}

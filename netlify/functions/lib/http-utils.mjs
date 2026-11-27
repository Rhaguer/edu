/**
 * Utilidades HTTP, validación, UUID v4/v5 (RFC 4122), cookies, CSV y cabeceras OWASP
 * para EduAndes AI en Netlify Functions v2.
 */

import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(status, detail, extra = null) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function nowUtcHuman() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

export function uuid4() {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function requireUuid(value, label = "identificador") {
  if (!isUuid(value)) {
    throw new HttpError(422, `El ${label} no tiene formato UUID válido.`);
  }
  return value.trim().toLowerCase();
}

/**
 * Implementación exacta de UUIDv5 (RFC 4122, SHA-1) idéntica a uuid.uuid5 de Python
 * para preservar la idempotencia determinista de intentos y respuestas de refuerzo.
 */
export function uuid5(namespaceUuid, name) {
  const hex = String(namespaceUuid).replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error("Namespace UUID inválido para uuid5.");
  }
  const nsBytes = Buffer.from(hex, "hex");
  const nameBytes = Buffer.from(String(name), "utf8");
  const hash = crypto.createHash("sha1").update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versión 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Serialización JSON determinista con claves ordenadas (equivalente a json.dumps(..., sort_keys=True)).
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function isHttpsRequest(req) {
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (proto === "https") return true;
  if (proto === "http") return false;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return Boolean(process.env.NETLIFY);
  }
}

export function clientIp(req) {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf.trim().slice(0, 64);
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return "127.0.0.1";
}

export function checkCsrfOrigin(req) {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const cleanOrigin = origin.replace(/\/+$/, "").toLowerCase();
  const allowed = new Set();
  const hosts = [
    req.headers.get("host"),
    req.headers.get("x-forwarded-host"),
  ].filter(Boolean);
  for (const h of hosts) {
    const cleanHost = h.split(",")[0].trim().toLowerCase();
    allowed.add(`https://${cleanHost}`);
    allowed.add(`http://${cleanHost}`);
  }
  try {
    allowed.add(new URL(req.url).origin.toLowerCase());
  } catch {
    // ignore
  }
  if (process.env.URL) allowed.add(process.env.URL.replace(/\/+$/, "").toLowerCase());
  if (process.env.DEPLOY_PRIME_URL) allowed.add(process.env.DEPLOY_PRIME_URL.replace(/\/+$/, "").toLowerCase());
  if (allowed.size > 0 && !allowed.has(cleanOrigin)) {
    throw new HttpError(403, "Origen no autorizado (CSRF).");
  }
}

export function owaspHeaders(req, isApi = true) {
  const headers = new Headers();
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (isHttpsRequest(req)) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (isApi) {
    headers.set("Cache-Control", "no-store");
  }
  return headers;
}

export function jsonResponse(req, payload, status = 200, extraHeaders = {}) {
  const headers = owaspHeaders(req, true);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (v !== undefined && v !== null) {
      headers.set(k, String(v));
    }
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export async function readJsonBody(req) {
  const text = await req.text();
  if (!text || !text.trim()) {
    throw new HttpError(422, "El cuerpo de la solicitud JSON está vacío.");
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(422, "Se esperaba un objeto JSON válido.");
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, "JSON inválido en el cuerpo de la solicitud.");
  }
}

export function requireString(obj, field, { min = 1, max = 5000, strip = true } = {}) {
  const raw = obj?.[field];
  if (typeof raw !== "string") {
    throw new HttpError(422, `El campo '${field}' es obligatorio.`);
  }
  const value = strip ? raw.trim() : raw;
  if (value.length < min || value.length > max) {
    throw new HttpError(422, `El campo '${field}' debe tener entre ${min} y ${max} caracteres.`);
  }
  return value;
}

export function requireInt(obj, field, { min = -Infinity, max = Infinity } = {}) {
  const raw = obj?.[field];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new HttpError(422, `El campo '${field}' debe ser un entero entre ${min} y ${max}.`);
  }
  return raw;
}

export function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function parseCsvDicts(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const rec = {};
    for (let j = 0; j < headers.length; j++) {
      rec[headers[j]] = vals[j] !== undefined ? vals[j] : "";
    }
    rows.push(rec);
  }
  return rows;
}

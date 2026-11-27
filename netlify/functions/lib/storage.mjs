/**
 * Capa de persistencia unificada para EduAndes AI en Netlify:
 * - Producción / Netlify Dev: @netlify/blobs con consistencia fuerte ("strong")
 * - Ejecución local sin Netlify CLI: almacén persistente en `.local-blobs/`
 *
 * Incluye auto-seed idempotente en el primer arranque con las 3 asignaturas,
 * 3 unidades, 10 materiales PDF, 731 páginas indexadas, 2 perfiles de alumno,
 * 6 matrículas y las 9 secciones del Panel de Administración.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { getStore } from "@netlify/blobs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_STORE_NAME = "eduandes-db";
const FILES_STORE_NAME = "eduandes-files";

let cachedSeedCore = null;
let cachedSeedPages = null;
let initializedPromise = null;

function resolveSeedPath(filename) {
  const candidates = [
    path.join(process.cwd(), "netlify", "functions", "seed-data", filename),
    path.resolve(__dirname, "..", "seed-data", filename),
    path.resolve(__dirname, "seed-data", filename),
    path.join("/var/task/netlify/functions/seed-data", filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No se encontró el archivo semilla '${filename}'.`);
}

export function loadSeedCore() {
  if (!cachedSeedCore) {
    const raw = fs.readFileSync(resolveSeedPath("seed-core.json"), "utf8");
    cachedSeedCore = JSON.parse(raw);
  }
  return cachedSeedCore;
}

export function loadSeedPagesMap() {
  if (!cachedSeedPages) {
    const gz = fs.readFileSync(resolveSeedPath("seed-pages.json.gz"));
    const jsonText = zlib.gunzipSync(gz).toString("utf8");
    cachedSeedPages = JSON.parse(jsonText);
  }
  return cachedSeedPages;
}

function localStoreDir(storeName) {
  const root = process.env.EDUANDES_LOCAL_BLOBS_DIR || path.join(process.cwd(), ".local-blobs");
  const dir = path.join(root, storeName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function keyToFilePath(storeName, key) {
  const encoded = Buffer.from(String(key), "utf8").toString("base64url");
  return path.join(localStoreDir(storeName), `${encoded}.blob`);
}

function createLocalAdapter(storeName) {
  return {
    backend: "local-fs-blobs",
    async getJson(key, fallback = null) {
      const fp = keyToFilePath(storeName, key);
      if (!fs.existsSync(fp)) return fallback;
      try {
        return JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch {
        return fallback;
      }
    },
    async setJson(key, value) {
      const fp = keyToFilePath(storeName, key);
      const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
      fs.renameSync(tmp, fp);
    },
    async getBytes(key) {
      const fp = keyToFilePath(storeName, key);
      if (!fs.existsSync(fp)) return null;
      return new Uint8Array(fs.readFileSync(fp));
    },
    async setBytes(key, bytes) {
      const fp = keyToFilePath(storeName, key);
      const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, fp);
    },
    async delete(key) {
      const fp = keyToFilePath(storeName, key);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    },
    async listKeys(prefix = "") {
      const dir = localStoreDir(storeName);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".blob"));
      const keys = [];
      for (const f of files) {
        const key = Buffer.from(f.slice(0, -5), "base64url").toString("utf8");
        if (!prefix || key.startsWith(prefix)) keys.push(key);
      }
      return keys;
    },
  };
}

function createNetlifyAdapter(storeName) {
  const store = getStore({ name: storeName, consistency: "strong" });
  return {
    backend: "netlify-blobs-strong",
    async getJson(key, fallback = null) {
      const val = await store.get(key, { type: "json" });
      return val === null || val === undefined ? fallback : val;
    },
    async setJson(key, value) {
      await store.setJSON(key, value);
    },
    async getBytes(key) {
      const ab = await store.get(key, { type: "arrayBuffer" });
      return ab ? new Uint8Array(ab) : null;
    },
    async setBytes(key, bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      await store.set(key, ab);
    },
    async delete(key) {
      await store.delete(key);
    },
    async listKeys(prefix = "") {
      const res = await store.list({ prefix });
      return (res?.blobs || []).map((b) => b.key);
    },
  };
}

function shouldUseNetlifyBlobs() {
  if (process.env.EDUANDES_FORCE_LOCAL_BLOBS === "1") return false;
  if (process.env.NETLIFY_BLOBS_CONTEXT) return true;
  if (globalThis.netlifyBlobsContext) return true;
  if (process.env.NETLIFY && process.env.SITE_ID && process.env.NETLIFY_AUTH_TOKEN) return true;
  return false;
}

function makeAdapter(storeName) {
  if (shouldUseNetlifyBlobs()) {
    try {
      return createNetlifyAdapter(storeName);
    } catch {
      return createLocalAdapter(storeName);
    }
  }
  return createLocalAdapter(storeName);
}

let dbAdapter = null;
let filesAdapter = null;

export function getDb() {
  if (!dbAdapter) dbAdapter = makeAdapter(DB_STORE_NAME);
  return dbAdapter;
}

export function getFilesStore() {
  if (!filesAdapter) filesAdapter = makeAdapter(FILES_STORE_NAME);
  return filesAdapter;
}

export function resetStorageCacheForTests() {
  dbAdapter = null;
  filesAdapter = null;
  initializedPromise = null;
}

export function storageBackendName() {
  return getDb().backend;
}

/**
 * Inicializa de forma idempotente toda la base de datos en Netlify Blobs
 * en la primera petición del sitio.
 */
export async function ensureSeeded(seedAuthAndAdminFn) {
  if (initializedPromise) {
    return initializedPromise;
  }
  initializedPromise = (async () => {
    const db = getDb();
    const marker = await db.getJson("meta:seeded_v1");
    if (marker && marker.done === true) {
      return;
    }

    const core = loadSeedCore();
    const pagesMap = loadSeedPagesMap();
    const tasks = [];

    // 1. Catálogo académico base
    const existingCourses = await db.getJson("col:courses");
    if (!existingCourses) tasks.push(db.setJson("col:courses", core.courses || []));

    const existingUnits = await db.getJson("col:units");
    if (!existingUnits) tasks.push(db.setJson("col:units", core.units || []));

    const existingMaterials = await db.getJson("col:materials");
    if (!existingMaterials) tasks.push(db.setJson("col:materials", core.materials || []));

    const existingStudents = await db.getJson("col:students");
    if (!existingStudents) tasks.push(db.setJson("col:students", core.students || []));

    const existingEnrollments = await db.getJson("col:enrollments");
    if (!existingEnrollments) tasks.push(db.setJson("col:enrollments", core.enrollments || []));

    // 2. Colecciones operativas vacías (igual que EDUANDES_IA commit 33abc25)
    for (const emptyKey of [
      "col:quiz_ids",
      "col:attempt_ids",
      "col:reinforcement_ids",
      "col:legacy_sources",
      "col:legacy_questions",
      "col:legacy_attempts",
      "col:legacy_guidance",
    ]) {
      const cur = await db.getJson(emptyKey);
      if (!cur) tasks.push(db.setJson(emptyKey, []));
    }

    // 3. 731 páginas indexadas de los 10 PDFs precargados (1 blob por material)
    for (const [materialId, pages] of Object.entries(pagesMap)) {
      tasks.push(db.setJson(`pages:${materialId}`, pages));
    }

    // 4. Secciones del panel de administración
    const siteHost = (process.env.URL || "https://eduandesai.netlify.app")
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
    for (const [k, v] of Object.entries(core.admin_kv || {})) {
      const existing = await db.getJson(`admin_kv:${k}`);
      if (!existing) {
        const val = structuredClone(v);
        if (k === "site_config") val.domain = siteHost;
        tasks.push(db.setJson(`admin_kv:${k}`, val));
      }
    }

    await Promise.all(tasks);

    // 5. Inicializar cuentas Argon2id y Audit Log inicial
    if (typeof seedAuthAndAdminFn === "function") {
      await seedAuthAndAdminFn(db);
    }

    await db.setJson("meta:seeded_v1", { done: true, seeded_at: new Date().toISOString() });
  })().catch((err) => {
    initializedPromise = null;
    throw err;
  });

  return initializedPromise;
}

/**
 * Obtiene las páginas de un material; si pertenece al seed inicial y no estuviera en Blobs,
 * las hidrata automáticamente desde seed-pages.json.gz.
 */
export async function getMaterialPages(materialId) {
  const db = getDb();
  const stored = await db.getJson(`pages:${materialId}`);
  if (Array.isArray(stored)) return stored;
  const seedMap = loadSeedPagesMap();
  if (Array.isArray(seedMap[materialId])) {
    await db.setJson(`pages:${materialId}`, seedMap[materialId]);
    return seedMap[materialId];
  }
  return [];
}

/**
 * Script de verificación de build para Netlify (`npm run build`).
 * Comprueba que el frontend estático, los 10 PDFs precargados, los archivos semilla
 * (731 páginas) y los módulos ESM de la función `/api/*` existan y carguen sin errores.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.cwd();
const requiredFiles = [
  "public/index.html",
  "public/assets/index-Dzewm_Rx.js",
  "public/assets/index-CzpD9Kkm.css",
  "public/assets/theme-binacional.css",
  "public/assets/admin-panel.css",
  "public/assets/admin-panel.js",
  "public/assets/pre-auth-guard.js",
  "public/assets/tour-guiado.js",
  "public/assets/tutor-chat.js",
  "netlify/functions/api.mjs",
  "netlify/functions/seed-data/seed-core.json",
  "netlify/functions/seed-data/seed-pages.json.gz",
];

for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`[build] Falta archivo requerido: ${rel}`);
    process.exit(1);
  }
}

const seedCore = JSON.parse(
  fs.readFileSync(path.join(root, "netlify/functions/seed-data/seed-core.json"), "utf8")
);
const seedPages = JSON.parse(
  zlib
    .gunzipSync(fs.readFileSync(path.join(root, "netlify/functions/seed-data/seed-pages.json.gz")))
    .toString("utf8")
);

let missingPdfs = 0;
for (const mat of seedCore.materials || []) {
  const pdfPath = path.join(root, "public/seed-materials", mat.storage_name);
  if (!fs.existsSync(pdfPath)) {
    console.error(`[build] Falta PDF precargado: public/seed-materials/${mat.storage_name}`);
    missingPdfs++;
  }
}
if (missingPdfs > 0) process.exit(1);

// Verificar importación limpia del entrypoint serverless
await import("../netlify/functions/api.mjs");

const totalPages = Object.values(seedPages).reduce((acc, arr) => acc + arr.length, 0);
console.log(
  `[build] OK — EduAndes AI Netlify listo: ${(seedCore.courses || []).length} asignaturas, ` +
    `${(seedCore.materials || []).length} PDFs, ${totalPages} páginas indexadas.`
);

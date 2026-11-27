/**
 * Servidor de desarrollo local sin requerir Netlify CLI (`npm run dev:local`).
 * Sirve `public/` y enruta `/api/*` directamente a `netlify/functions/api.mjs`,
 * leyendo `.env` automáticamente si existe en la raíz del proyecto.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { handleApiRequest } from "../netlify/functions/api.mjs";

const root = process.cwd();
const publicDir = path.join(root, "public");

// Cargar .env si existe (sin sobrescribir variables del sistema)
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

process.env.EDUANDES_FORCE_LOCAL_BLOBS = "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host || `${HOST}:${PORT}`;
    const fullUrl = `http://${hostHeader}${req.url || "/"}`;
    const parsed = new URL(fullUrl);

    if (parsed.pathname.startsWith("/api/") || parsed.pathname === "/api") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (v !== undefined) {
          headers.set(k, v);
        }
      }

      const init = { method: req.method, headers };
      if (bodyBuf && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
        init.body = bodyBuf;
      }
      const webReq = new Request(fullUrl, init);
      const webRes = await handleApiRequest(webReq);

      res.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => {
        if (k.toLowerCase() === "set-cookie") {
          const prev = res.getHeader("Set-Cookie");
          res.setHeader("Set-Cookie", prev ? [].concat(prev, v) : v);
        } else {
          res.setHeader(k, v);
        }
      });
      const outBuf = Buffer.from(await webRes.arrayBuffer());
      res.end(outBuf);
      return;
    }

    // Archivos estáticos desde public/
    const relPath = decodeURIComponent(parsed.pathname === "/" ? "/index.html" : parsed.pathname);
    const safePath = path.normalize(path.join(publicDir, relPath));
    if (!safePath.startsWith(publicDir) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
      const indexFile = path.join(publicDir, "index.html");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(fs.readFileSync(indexFile));
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    if (ext === ".pdf") res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(safePath).pipe(res);
  } catch (err) {
    console.error("[local-server]", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ detail: err?.message || "Error del servidor local." }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EduAndes AI (Netlify local) activo en http://${HOST}:${PORT}/#/`);
});

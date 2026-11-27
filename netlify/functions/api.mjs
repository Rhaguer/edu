/**
 * Punto de entrada unificado de la API de EduAndes AI en Netlify Functions v2.
 * Atiende el 100% de las rutas `/api/*` con middleware de seguridad OWASP, CSRF,
 * autenticación Argon2id + HttpOnly, modo mantenimiento y RBAC fail-closed idéntico
 * al servidor FastAPI original (`apps/api/main.py`).
 */

import * as adminSvc from "./lib/admin-service.mjs";
import {
  getSessionUser,
  handleChangeOwnPassword,
  handleLogin,
  handleLogout,
  handleMe,
  initializeAuthAndAudit,
  isMaintenanceOn,
} from "./lib/auth.mjs";
import { engineStatus, getEngine } from "./lib/cloud-engines.mjs";
import * as coursesSvc from "./lib/courses-service.mjs";
import {
  HttpError,
  checkCsrfOrigin,
  jsonResponse,
  readJsonBody,
} from "./lib/http-utils.mjs";
import * as legacySvc from "./lib/legacy-service.mjs";
import { ensureSeeded } from "./lib/storage.mjs";
import { handleTutorChat } from "./lib/tutor-chat.mjs";

export const config = {
  path: "/api/*",
};

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
]);

const STUDENT_ALLOWED_PREFIXES = [
  "/api/quiz-attempts",
  "/api/reinforcements",
  "/api/attempts",
  "/api/auth/",
  "/api/tutor/",
];

const STUDENT_ALLOWED_SUFFIXES = [
  "/attempts",
  "/submit",
  "/reinforcement",
  "/explanation",
];

function normalizeApiPath(rawPathname) {
  let p = String(rawPathname || "/");
  if (p.startsWith("/.netlify/functions/api")) {
    p = p.slice("/.netlify/functions/api".length) || "/";
    if (!p.startsWith("/api")) p = `/api${p.startsWith("/") ? p : "/" + p}`;
  }
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function matchRoute(path, pattern) {
  const m = path.match(pattern);
  return m ? m.slice(1).map((seg) => decodeURIComponent(seg)) : null;
}

export async function handleApiRequest(req) {
  const url = new URL(req.url);
  const path = normalizeApiPath(url.pathname);
  const method = req.method.toUpperCase();

  try {
    // 1. CSRF Origin check en peticiones mutantes a /api/*
    checkCsrfOrigin(req);

    // 2. Salud pública rápida (sin exigir inicialización pesada si no es necesario)
    if (method === "GET" && path === "/api/health") {
      return jsonResponse(req, { status: "ok" }, 200);
    }

    // 3. Auto-seed idempotente de cursos, unidades, 10 PDFs / 731 páginas y cuentas Argon2id
    await ensureSeeded(initializeAuthAndAudit);

    // 4. Rutas públicas de autenticación
    if (method === "POST" && path === "/api/auth/login") {
      const body = await readJsonBody(req);
      const { payload, cookie } = await handleLogin(req, body);
      return jsonResponse(req, payload, 200, { "Set-Cookie": cookie });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      const { payload, cookie } = await handleLogout(req);
      return jsonResponse(req, payload, 200, { "Set-Cookie": cookie });
    }
    if (method === "GET" && path === "/api/auth/me") {
      return jsonResponse(req, await handleMe(req), 200);
    }

    // 5. Middleware de sesión, RBAC y modo mantenimiento (fail-closed)
    let user = null;
    if (!PUBLIC_API_PATHS.has(path)) {
      user = await getSessionUser(req);
      if (!user) {
        return jsonResponse(req, { detail: "Sesión requerida." }, 401);
      }
      if (path.startsWith("/api/admin/") && user.role !== "Administrador") {
        return jsonResponse(req, { detail: "Requiere rol Administrador." }, 403);
      }
      if (user.role !== "Administrador" && (await isMaintenanceOn())) {
        return jsonResponse(
          req,
          { detail: "Plataforma en modo mantenimiento.", maintenance: true },
          503
        );
      }
      if (user.role === "Estudiante" && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const ownProfileEdit = method === "PUT" && path.startsWith("/api/students/");
        const allowedPrefix = STUDENT_ALLOWED_PREFIXES.some((pre) => path.startsWith(pre));
        const allowedSuffix = STUDENT_ALLOWED_SUFFIXES.some((suf) => path.endsWith(suf));
        if (!ownProfileEdit && !allowedPrefix && !allowedSuffix) {
          return jsonResponse(req, { detail: "Acción no permitida para el rol Estudiante." }, 403);
        }
      }
    }

    // 6. Cambio de contraseña propia
    if (method === "POST" && path === "/api/auth/change-password") {
      return jsonResponse(req, await handleChangeOwnPassword(req, await readJsonBody(req)), 200);
    }

    // 7. Estado del motor IA
    if (method === "GET" && path === "/api/engine/status") {
      return jsonResponse(req, engineStatus(), 200);
    }
    if (method === "GET" && path === "/api/engine") {
      return jsonResponse(req, getEngine().status(), 200);
    }

    // 8. Chat Tutor AndesBot
    if (method === "POST" && path === "/api/tutor/chat") {
      return jsonResponse(req, await handleTutorChat(user, await readJsonBody(req)), 200);
    }

    // 9. Panel de Administración (/api/admin/*)
    if (path.startsWith("/api/admin/")) {
      let params;
      if (method === "GET" && path === "/api/admin/state") {
        return jsonResponse(req, await adminSvc.getAdminState(), 200);
      }
      if (method === "GET" && path === "/api/admin/health") {
        return jsonResponse(req, await adminSvc.getAdminHealth(), 200);
      }
      if (method === "PUT" && (params = matchRoute(path, /^\/api\/admin\/section\/([^/]+)$/))) {
        return jsonResponse(req, await adminSvc.updateAdminSection(user, req, params[0], await readJsonBody(req)), 200);
      }
      if (method === "POST" && path === "/api/admin/users") {
        return jsonResponse(req, await adminSvc.createAdminUser(user, req, await readJsonBody(req)), 200);
      }
      if (method === "POST" && path === "/api/admin/users/import-csv") {
        return jsonResponse(req, await adminSvc.importUsersCsv(user, req, await readJsonBody(req)), 200);
      }
      if (method === "GET" && path === "/api/admin/users/export-csv") {
        return adminSvc.exportUsersCsv(req);
      }
      if (method === "POST" && (params = matchRoute(path, /^\/api\/admin\/users\/([^/]+)\/toggle-status$/))) {
        return jsonResponse(req, await adminSvc.toggleAdminUserStatus(user, req, params[0]), 200);
      }
      if (method === "POST" && (params = matchRoute(path, /^\/api\/admin\/users\/([^/]+)\/toggle-mfa$/))) {
        return jsonResponse(req, await adminSvc.toggleAdminUserMfa(user, req, params[0]), 200);
      }
      if (method === "POST" && (params = matchRoute(path, /^\/api\/admin\/users\/([^/]+)\/reset-password$/))) {
        return jsonResponse(
          req,
          await adminSvc.resetAdminUserPassword(user, req, params[0], await readJsonBody(req)),
          200
        );
      }
      if (method === "DELETE" && (params = matchRoute(path, /^\/api\/admin\/users\/([^/]+)$/))) {
        return jsonResponse(req, await adminSvc.deleteAdminUser(user, req, params[0]), 200);
      }
      if (method === "DELETE" && (params = matchRoute(path, /^\/api\/admin\/students\/([^/]+)$/))) {
        return jsonResponse(req, await adminSvc.deleteStudentProfile(user, req, params[0]), 200);
      }
      if (method === "GET" && path === "/api/admin/reports/export") {
        return adminSvc.exportReportCsv(req, url.searchParams.get("kind") || "adoption");
      }
      if (method === "POST" && path === "/api/admin/backups") {
        return jsonResponse(req, await adminSvc.createAdminBackup(user, req, await readJsonBody(req)), 200);
      }
      if (method === "POST" && path === "/api/admin/sessions/revoke-all") {
        return jsonResponse(req, await adminSvc.revokeAllOtherSessions(user, req, await readJsonBody(req)), 200);
      }
      if (method === "POST" && path === "/api/admin/chat-access") {
        return jsonResponse(req, await adminSvc.accessFlaggedChat(user, req, await readJsonBody(req)), 200);
      }
      throw new HttpError(404, "Ruta de administración no encontrada.");
    }

    // 10. Asignaturas, Unidades, Materiales, Cuestionarios, Estudiantes, Intentos y Refuerzos
    let params;
    const qStudentId = url.searchParams.get("student_id") || null;

    if (method === "GET" && path === "/api/courses") {
      return jsonResponse(req, await coursesSvc.listCourses(), 200);
    }
    if (method === "POST" && path === "/api/courses") {
      return jsonResponse(req, await coursesSvc.createCourse(await readJsonBody(req)), 201);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/courses\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getCourse(params[0]), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/courses\/([^/]+)\/units$/))) {
      return jsonResponse(req, await coursesSvc.createUnit(params[0], await readJsonBody(req)), 201);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/courses\/([^/]+)\/students$/))) {
      return jsonResponse(req, await coursesSvc.listEnrolledStudents(user, params[0]), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/courses\/([^/]+)\/students$/))) {
      return jsonResponse(req, await coursesSvc.enrollStudent(params[0], await readJsonBody(req)), 201);
    }

    if (method === "GET" && (params = matchRoute(path, /^\/api\/units\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getUnit(params[0]), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/units\/([^/]+)\/materials$/))) {
      return jsonResponse(req, await coursesSvc.uploadMaterialFromRequest(params[0], req), 201);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/units\/([^/]+)\/text$/))) {
      return jsonResponse(req, await coursesSvc.uploadTextMaterial(params[0], await readJsonBody(req)), 201);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/units\/([^/]+)\/quizzes$/))) {
      return jsonResponse(req, await coursesSvc.createQuiz(params[0], await readJsonBody(req)), 202);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/units\/([^/]+)\/practice$/))) {
      return jsonResponse(req, await coursesSvc.listUnitPractice(params[0]), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/units\/([^/]+)\/attempts$/))) {
      return jsonResponse(req, await coursesSvc.listUnitAttempts(params[0], qStudentId), 200);
    }

    if (method === "GET" && (params = matchRoute(path, /^\/api\/materials\/([^/]+)\/pages$/))) {
      return jsonResponse(req, await coursesSvc.listMaterialPages(params[0]), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/materials\/([^/]+)\/file$/))) {
      return coursesSvc.serveMaterialFile(req, params[0]);
    }

    if (method === "GET" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getQuiz(params[0]), 200);
    }
    if (method === "PUT" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.editQuiz(params[0], await readJsonBody(req)), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)\/retry$/))) {
      return jsonResponse(req, await coursesSvc.retryQuiz(params[0]), 202);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)\/publish$/))) {
      return jsonResponse(req, await coursesSvc.publishQuiz(params[0], await readJsonBody(req)), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)\/practice$/))) {
      return jsonResponse(req, await coursesSvc.getQuizPractice(params[0]), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/quizzes\/([^/]+)\/attempts$/))) {
      return jsonResponse(req, await coursesSvc.createAttempt(params[0], await readJsonBody(req)), 201);
    }

    if (method === "GET" && path === "/api/students") {
      return jsonResponse(req, await coursesSvc.listStudents(user), 200);
    }
    if (method === "POST" && path === "/api/students") {
      return jsonResponse(req, await coursesSvc.createStudent(user, await readJsonBody(req)), 201);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/students\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getStudent(user, params[0]), 200);
    }
    if (method === "PUT" && (params = matchRoute(path, /^\/api\/students\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.updateStudent(user, params[0], await readJsonBody(req)), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/students\/([^/]+)\/progress$/))) {
      return jsonResponse(
        req,
        await coursesSvc.getStudentProgress(
          user,
          params[0],
          url.searchParams.get("course_id"),
          url.searchParams.get("unit_id")
        ),
        200
      );
    }

    if (method === "GET" && (params = matchRoute(path, /^\/api\/quiz-attempts\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getAttempt(params[0], qStudentId), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/quiz-attempts\/([^/]+)\/reinforcement$/))) {
      const sourceReview = ["1", "true", "yes"].includes(
        String(url.searchParams.get("source_review") || "").toLowerCase()
      );
      return jsonResponse(req, await coursesSvc.startReinforcement(params[0], qStudentId, sourceReview), 202);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/quiz-attempts\/([^/]+)\/reinforcements$/))) {
      return jsonResponse(req, await coursesSvc.listReinforcementRounds(params[0], qStudentId), 200);
    }

    if (method === "POST" && (params = matchRoute(path, /^\/api\/reinforcements\/([^/]+)\/next$/))) {
      return jsonResponse(req, await coursesSvc.nextReinforcement(params[0], qStudentId), 202);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/reinforcements\/([^/]+)\/failed-topics$/))) {
      return jsonResponse(req, await coursesSvc.getReinforcementFailedTopics(params[0], qStudentId), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/reinforcements\/([^/]+)\/response$/))) {
      return jsonResponse(req, await coursesSvc.submitReinforcement(params[0], await readJsonBody(req), qStudentId), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/reinforcements\/([^/]+)\/practice-drill$/))) {
      return jsonResponse(
        req,
        await coursesSvc.generatePracticeDrill(params[0], await readJsonBody(req), qStudentId),
        200
      );
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/reinforcements\/([^/]+)$/))) {
      return jsonResponse(req, await coursesSvc.getReinforcement(params[0], qStudentId), 200);
    }

    // 11. Rutas legadas (/api/sources, /api/questions, /api/practice, /api/attempts)
    if (method === "POST" && path === "/api/sources") {
      return jsonResponse(req, await legacySvc.createSource(await readJsonBody(req)), 201);
    }
    if (method === "POST" && path === "/api/sources/pdf") {
      return jsonResponse(req, await legacySvc.extractSourcePdf(req), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/sources\/([^/]+)$/))) {
      return jsonResponse(req, await legacySvc.getSource(params[0]), 200);
    }
    if (method === "POST" && path === "/api/questions") {
      return jsonResponse(req, await legacySvc.createLegacyQuestion(await readJsonBody(req)), 201);
    }
    if (method === "GET" && path === "/api/questions") {
      return jsonResponse(req, await legacySvc.listLegacyReviews(), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/questions\/([^/]+)$/))) {
      return jsonResponse(req, await legacySvc.getLegacyReview(params[0]), 200);
    }
    if (method === "PUT" && (params = matchRoute(path, /^\/api\/questions\/([^/]+)$/))) {
      return jsonResponse(req, await legacySvc.editLegacyQuestion(params[0], await readJsonBody(req)), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/questions\/([^/]+)\/approve$/))) {
      return jsonResponse(req, await legacySvc.approveLegacyQuestion(params[0], await readJsonBody(req)), 200);
    }
    if (method === "GET" && path === "/api/practice") {
      return jsonResponse(req, await legacySvc.listLegacyPractice(), 200);
    }
    if (method === "GET" && (params = matchRoute(path, /^\/api\/practice\/([^/]+)$/))) {
      return jsonResponse(req, await legacySvc.getLegacyPractice(params[0]), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/practice\/([^/]+)\/attempts$/))) {
      return jsonResponse(req, await legacySvc.createLegacyAttempt(params[0], await readJsonBody(req)), 201);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/attempts\/([^/]+)\/explanation$/))) {
      return jsonResponse(req, await legacySvc.legacyGuidance(params[0], "explanation"), 200);
    }
    if (method === "POST" && (params = matchRoute(path, /^\/api\/attempts\/([^/]+)\/reinforcement$/))) {
      return jsonResponse(req, await legacySvc.legacyGuidance(params[0], "reinforcement"), 200);
    }

    throw new HttpError(404, "Endpoint de API no encontrado.");
  } catch (err) {
    if (err instanceof HttpError) {
      const body = { detail: err.detail, ...(err.extra || {}) };
      return jsonResponse(req, body, err.status);
    }
    console.error("[EduAndes API Error]", method, path, err);
    return jsonResponse(
      req,
      { detail: err?.message || "Error interno en la API de EduAndes AI." },
      500
    );
  }
}

export default async function handler(req) {
  return handleApiRequest(req);
}

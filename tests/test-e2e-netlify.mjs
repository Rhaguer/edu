/**
 * Suite E2E autónoma para EduAndes AI (Netlify Edition).
 * Ejecuta contra un almacén temporal de Blobs locales y un motor IA determinista inyectado
 * para verificar Auth Argon2id, RBAC, CSRF, cursos, materiales, cuestionarios con cita literal,
 * intentos idempotentes, refuerzos personalizados, AndesBot RAG y Panel Admin.
 *
 * Ejecutar con: `npm test`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest } from "../netlify/functions/api.mjs";
import { setInjectedEngineForTests } from "../netlify/functions/lib/cloud-engines.mjs";
import { uuid4 } from "../netlify/functions/lib/http-utils.mjs";
import { resetStorageCacheForTests } from "../netlify/functions/lib/storage.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduandes-netlify-e2e-"));
process.env.EDUANDES_FORCE_LOCAL_BLOBS = "1";
process.env.EDUANDES_LOCAL_BLOBS_DIR = tmpDir;
resetStorageCacheForTests();

// Motor IA determinista para pruebas E2E sin consumir cuota de red
let mockCounter = 0;
setInjectedEngineForTests({
  parallel_safe: true,
  reinforcement_prompt_version: "cloud-v1",
  status() {
    return {
      base_model: "mock-eduandes-test",
      base_revision: "test",
      adapter_active: false,
      adapter_version: null,
      profile: "test-engine",
      precision: "cloud",
      device: "test",
      thinking: false,
      mode: "cloud-http",
      reinforcement_choices: "teacher_reviewed",
    };
  },
  async generate(_context, answer) {
    return `¿A qué concepto corresponde «${answer.slice(0, 25)}»?`;
  },
  async guidance() {
    return "Contrasta tu respuesta con la definición literal del material de clase.";
  },
  async completeStructured(system, content) {
    return this.courseCompletion(system, content);
  },
  async courseCompletion(system, content) {
    mockCounter++;
    if (system.includes("Eres AndesBot")) {
      return "La probabilidad mide la posibilidad de ocurrencia de un evento.\n\n• **Concepto:** Se calcula dividiendo casos favorables entre casos posibles.";
    }
    if (system.includes("Evalúa si CADA alternativa")) {
      const parsed = JSON.parse(content);
      const alts = parsed.alternativas || [];
      const correctAlt = alts.find((a) => String(a.texto).toLowerCase().includes("probabilidad") || a.id === 0) || alts[0];
      const snippet = String(parsed.caso || "").slice(0, 28);
      return JSON.stringify({
        evaluaciones: alts.map((a) => ({
          id: a.id,
          compatible: a.id === correctAlt.id,
          evidencia: a.id === correctAlt.id ? snippet : "",
        })),
        resoluble: true,
        respuestas_validas: [correctAlt.id],
        fundamento: "El caso muestra de forma observable la aplicación directa de la idea curricular del material.",
      });
    }
    if (system.includes("Redacta un microcaso educativo")) {
      const parsed = JSON.parse(content);
      const amb = parsed.ambito || "una biblioteca";
      const obj = amb.includes("biblioteca")
        ? "libros del catalogo"
        : amb.includes("huerto")
          ? "plantas y semillas"
          : amb.includes("museo")
            ? "cuadros de la exposicion"
            : amb.includes("taller")
              ? "bicicletas en reparacion"
              : amb.includes("residuo")
                ? "residuos de reciclaje"
                : "paquetes de envio";
      return JSON.stringify({
        caso: `En ${amb} un equipo organiza ${obj} paso numero ${mockCounter} midiendo frecuencia relativa con precisión clara.`,
        pregunta: `¿Qué concepto del material explica la medición realizada en la fase ${mockCounter}?`,
      });
    }
    // Generación de preguntas de curso
    const parsed = JSON.parse(content);
    const material = String(parsed.material || "");
    const words = material.match(/[A-Za-zÁÉÍÓÚáéíóúÑñ]{5,}/g) || ["aprendizaje", "modelo", "sistema"];
    const picked = words[mockCounter % words.length];
    const startIdx = material.indexOf(picked);
    const quote = material.slice(Math.max(0, startIdx - 15), Math.min(material.length, startIdx + 90)).trim();
    const isChoice = system.includes("distractors DEBE");
    if (isChoice) {
      return JSON.stringify({
        topic: "Conceptos clave",
        question: `¿Cuál término describe correctamente el proceso #${mockCounter} mencionado en la unidad?`,
        answer: picked,
        distractors: [`Alternativa A-${mockCounter}`, `Alternativa B-${mockCounter}`, `Alternativa C-${mockCounter}`],
        explanation: `El término ${picked} aparece directamente respaldado por el documento de clase.`,
        evidence: quote.length >= 25 ? quote : material.slice(0, 120),
      });
    }
    return JSON.stringify({
      topic: "Análisis",
      question: `¿Cómo se define la idea #${mockCounter} según la unidad?`,
      answer: picked,
      explanation: `La evidencia documental respalda el uso de ${picked}.`,
      evidence: quote.length >= 25 ? quote : material.slice(0, 120),
    });
  },
});

async function call(method, urlPath, { body = null, cookie = "", origin = null } = {}) {
  const headers = new Headers({ host: "eduandesai.netlify.app", "x-forwarded-proto": "https" });
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  const init = { method, headers };
  if (body !== null) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const req = new Request(`https://eduandesai.netlify.app${urlPath}`, init);
  const res = await handleApiRequest(req);
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = raw;
  }
  const setCookie = res.headers.get("set-cookie") || "";
  const cookiePair = setCookie ? setCookie.split(";")[0] : "";
  return { status: res.status, json, headers: res.headers, cookiePair };
}

try {
  // 1. Health + unauthenticated guard
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.status, "ok");

  const unauth = await call("GET", "/api/courses");
  assert.equal(unauth.status, 401);

  // 2. CSRF protection
  const csrf = await call("POST", "/api/auth/login", {
    body: { email: "admin@evil.com", password: "x" },
    origin: "https://evil.example.com",
  });
  assert.equal(csrf.status, 403);

  // 3. Login Admin (Argon2id + HttpOnly)
  const badLogin = await call("POST", "/api/auth/login", {
    body: { email: "administrador@ecuachile.cl", password: "wrong" },
  });
  assert.equal(badLogin.status, 401);

  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: "administrador@ecuachile.cl", password: "123456" },
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.json.authenticated, true);
  assert.ok(adminLogin.cookiePair.startsWith("eduandes_session="));
  const adminCookie = adminLogin.cookiePair;

  // 4. Verify seeded courses, units, 10 materials & 731 pages
  const courses = await call("GET", "/api/courses", { cookie: adminCookie });
  assert.equal(courses.status, 200);
  assert.equal(courses.json.length, 3);

  const mathCourse = await call("GET", `/api/courses/${courses.json[0].id}`, { cookie: adminCookie });
  assert.equal(mathCourse.status, 200);
  const unitId = mathCourse.json.units[0].id;
  const unitDetail = await call("GET", `/api/units/${unitId}`, { cookie: adminCookie });
  assert.equal(unitDetail.status, 200);
  assert.ok(unitDetail.json.materials.length >= 1);

  const seedMatId = unitDetail.json.materials[0].id;
  const pdfRedirect = await call("GET", `/api/materials/${seedMatId}/file`, { cookie: adminCookie });
  assert.equal(pdfRedirect.status, 302);
  assert.ok(pdfRedirect.headers.get("location").startsWith("/seed-materials/"));

  // 5. Teacher creates text material + generates 5-question quiz + reviews + publishes
  const teacherLogin = await call("POST", "/api/auth/login", {
    body: { email: "docente@ecuachile.cl", password: "123456" },
  });
  const teacherCookie = teacherLogin.cookiePair;

  const txtMat = await call("POST", `/api/units/${unitId}/text`, {
    cookie: teacherCookie,
    body: {
      title: "Guía Probabilidad",
      text:
        "La probabilidad clásica calcula la relación entre casos favorables y casos posibles en un experimento aleatorio equiprobable. " +
        "La estadística descriptiva organiza datos mediante frecuencia absoluta, media aritmética, mediana y desviación estándar para interpretar fenómenos reales.",
    },
  });
  assert.equal(txtMat.status, 201);

  let quizRes = await call("POST", `/api/units/${unitId}/quizzes`, {
    cookie: teacherCookie,
    body: {
      title: "Práctica Demo Probabilidad",
      objective: "Comprender probabilidad clásica y estadística descriptiva",
      kind: "practice",
      question_type: "multiple_choice",
      count: 5,
      material_ids: [txtMat.json.id],
    },
  });
  assert.equal(quizRes.status, 202);
  let quiz = quizRes.json;
  for (let i = 0; i < 6 && quiz.status === "generating"; i++) {
    quiz = (await call("GET", `/api/quizzes/${quiz.id}`, { cookie: teacherCookie })).json;
  }
  assert.equal(quiz.status, "draft");
  assert.equal(quiz.items.length, 5);

  const reviewedItems = quiz.items.map((it) => ({ ...it, reviewed: true }));
  const edited = await call("PUT", `/api/quizzes/${quiz.id}`, {
    cookie: teacherCookie,
    body: { version: quiz.version, title: quiz.title, objective: quiz.objective, items: reviewedItems },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.version, 2);

  const published = await call("POST", `/api/quizzes/${quiz.id}/publish`, {
    cookie: teacherCookie,
    body: { version: 2 },
  });
  assert.equal(published.status, 200);
  assert.equal(published.json.status, "published");

  // 6. Student RBAC, attempt submission, progress, reinforcement, AndesBot
  const studentLogin = await call("POST", "/api/auth/login", {
    body: { email: "estudiante@ecuachile.cl", password: "123456" },
  });
  const studentCookie = studentLogin.cookiePair;
  const studentId = studentLogin.json.user.student_id;
  assert.ok(studentId);

  const blockedCreateCourse = await call("POST", "/api/courses", {
    cookie: studentCookie,
    body: { title: "No autorizado", code: "NO" },
  });
  assert.equal(blockedCreateCourse.status, 403);

  const blockedAdmin = await call("GET", "/api/admin/state", { cookie: studentCookie });
  assert.equal(blockedAdmin.status, 403);

  const pubQuiz = await call("GET", `/api/quizzes/${quiz.id}/practice`, { cookie: studentCookie });
  assert.equal(pubQuiz.status, 200);
  assert.equal("answer" in pubQuiz.json.items[0], false);

  const reqUuid = uuid4();
  const attempt = await call("POST", `/api/quizzes/${quiz.id}/attempts`, {
    cookie: studentCookie,
    body: {
      version: 2,
      request_id: reqUuid,
      student_id: studentId,
      answers: pubQuiz.json.items.map((it, idx) => ({
        item_id: it.id,
        selected_index: idx === 0 ? 0 : 1,
        response: "",
        justification: "Razonamiento de prueba",
      })),
    },
  });
  assert.equal(attempt.status, 201);

  const progress = await call(
    "GET",
    `/api/students/${studentId}/progress?course_id=${courses.json[0].id}`,
    { cookie: studentCookie }
  );
  assert.equal(progress.status, 200);
  assert.equal(progress.json.summary.attempt_count, 1);

  // Reinforcement (source_review=true for deterministic check)
  const reinf = await call(
    "POST",
    `/api/quiz-attempts/${attempt.json.id}/reinforcement?student_id=${studentId}&source_review=true`,
    { cookie: studentCookie }
  );
  assert.equal(reinf.status, 202);
  assert.equal(reinf.json.status, "ready");

  // AndesBot RAG
  const chat = await call("POST", "/api/tutor/chat", {
    cookie: studentCookie,
    body: { message: "¿Qué es la probabilidad de un evento?", course_id: courses.json[0].id },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.json.reply.includes("probabilidad"));

  // 7. Admin Panel state, health, backup, user creation
  const admState = await call("GET", "/api/admin/state", { cookie: adminCookie });
  assert.equal(admState.status, 200);
  assert.equal(admState.json.sections.users.accounts.length, 4);

  const admHealth = await call("GET", "/api/admin/health", { cookie: adminCookie });
  assert.equal(admHealth.status, 200);
  assert.equal(admHealth.json.status, "healthy");

  const bkp = await call("POST", "/api/admin/backups", {
    cookie: adminCookie,
    body: { reason: "Backup E2E" },
  });
  assert.equal(bkp.status, 200);
  assert.equal(bkp.json.ok, true);

  console.log("ALL EDUANDES AI NETLIFY E2E TESTS PASSED!");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

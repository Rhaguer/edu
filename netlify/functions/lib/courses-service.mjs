/**
 * Servicio completo de cursos, unidades, materiales, estudiantes, cuestionarios revisables,
 * intentos inmutables y refuerzos personalizados (port 1:1 de courses.py + learner_store.py).
 *
 * Optimizado para Netlify Functions v2 (compatible con el límite de 10 s del plan gratuito):
 * - Generación de cuestionarios incremental por lotes paralelos conducidos por el polling
 *   nativo del frontend (`GET /api/quizzes/:id`) con bloqueo de concurrencia `lease_until`.
 * - Generación de refuerzos por etapas reanudables en `GET /api/reinforcements/:id`.
 * - PDFs precargados servidos por CDN (`/seed-materials/*.pdf`) tras verificar sesión,
 *   evitando el límite de 6 MB de AWS Lambda y conservando `#page=N`.
 */

import { ensureStudentProfile } from "./auth.mjs";
import { getEngine } from "./cloud-engines.mjs";
import { generateCourseItem } from "./course-generation.mjs";
import {
  HttpError,
  isUuid,
  nowIso,
  owaspHeaders,
  requireInt,
  requireString,
  requireUuid,
  sha256Hex,
  stableStringify,
  uuid4,
  uuid5,
} from "./http-utils.mjs";
import { planReinforcement, summarizeProgress } from "./learning-profile.mjs";
import { MAX_FILE_BYTES, extractPages } from "./material-import.mjs";
import { contentKey, normalizeWhitespace, wordTokens } from "./native-core.mjs";
import { stepReinforcementGeneration } from "./reinforcement-generation.mjs";
import { getDb, getFilesStore, getMaterialPages, loadSeedCore } from "./storage.mjs";

const OVERVIEW_WORDS = new Set([
  "objetivos", "conclusiones", "conclusion", "contenidos", "agenda",
  "resumen", "perspectivas", "futuro", "aprenderemos", "aprenderas",
]);

const QUIZ_BATCH_SIZE = 5;
const QUIZ_STEP_BUDGET_MS = 6200;
const REINF_STEP_BUDGET_MS = 6200;
const DRILL_STEP_BUDGET_MS = 6800;

function publicItem(item) {
  return {
    id: item.id,
    type: item.type,
    topic: item.topic,
    objective: item.objective,
    question: item.question,
    options: item.options,
  };
}

function quizSummary(quiz) {
  const out = { ...quiz };
  delete out.items;
  delete out._lease_until;
  delete out._attempts_done;
  delete out._page_cursor;
  delete out.generation_round;
  out.item_count = (quiz.items || []).length;
  out.reviewed_count = (quiz.items || []).filter((i) => i.reviewed === true).length;
  return out;
}

function cleanQuizForClient(quiz) {
  const out = { ...quiz };
  delete out._lease_until;
  delete out._attempts_done;
  delete out._page_cursor;
  delete out.generation_round;
  return out;
}

function publicQuiz(quiz) {
  return {
    id: quiz.id,
    unit_id: quiz.unit_id,
    title: quiz.title,
    objective: quiz.objective,
    version: quiz.version,
    kind: quiz.kind,
    items: (quiz.items || []).map(publicItem),
  };
}

function publicReinforcement(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (
      k === "private_exercise" ||
      k === "generation_token" ||
      k === "_gen_progress" ||
      k === "_lease_until"
    ) {
      continue;
    }
    out[k] = v;
  }
  out.exercise = value.private_exercise ? publicItem(value.private_exercise) : null;
  return out;
}

function restartReinforcementGeneration(value) {
  value.status = "generating";
  value.error = null;
  value.generation_token = uuid4();
  value.explanation = "";
  value.example = "";
  value.citation = null;
  value.private_exercise = null;
  value.matching = [];
  value.model = {};
  value._gen_progress = null;
  value._lease_until = 0;
  for (const f of ["activity_kind", "support_basis", "source_review", "fallback_reason"]) {
    delete value[f];
  }
}

// ---------- Helpers de colección ----------

async function getCourseOr404(courseId) {
  const db = getDb();
  const [courses, units] = await Promise.all([
    db.getJson("col:courses", []),
    db.getJson("col:units", []),
  ]);
  const course = courses.find((c) => c.id === courseId);
  if (!course) throw new HttpError(404, "Asignatura no encontrada.");
  return {
    ...course,
    unit_count: units.filter((u) => u.course_id === courseId).length,
  };
}

async function getUnitOr404(unitId) {
  const db = getDb();
  const [units, materials, quizIds] = await Promise.all([
    db.getJson("col:units", []),
    db.getJson("col:materials", []),
    db.getJson(`unit_quizzes:${unitId}`, null),
  ]);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new HttpError(404, "Unidad no encontrada.");
  let quizCount = 0;
  if (Array.isArray(quizIds)) {
    quizCount = quizIds.length;
  } else {
    const allIds = (await db.getJson("col:quiz_ids", [])) || [];
    const quizzes = (await Promise.all(allIds.map((id) => db.getJson(`quiz:${id}`)))).filter(Boolean);
    quizCount = quizzes.filter((q) => q.unit_id === unitId).length;
  }
  return {
    ...unit,
    material_count: materials.filter((m) => m.unit_id === unitId).length,
    quiz_count: quizCount,
  };
}

async function getMaterialRawOr404(materialId) {
  const db = getDb();
  const materials = (await db.getJson("col:materials", [])) || [];
  const mat = materials.find((m) => m.id === materialId);
  if (!mat) throw new HttpError(404, "Material no encontrado.");
  return mat;
}

function publicMaterial(mat) {
  const out = { ...mat };
  delete out.storage_name;
  return out;
}

async function getPageOr404(materialId, pageNumber) {
  const mat = await getMaterialRawOr404(materialId);
  const pages = await getMaterialPages(materialId);
  const page = pages.find((p) => Number(p.number) === Number(pageNumber));
  if (!page) throw new HttpError(404, "La página citada no existe en el material.");
  return { ...page, filename: mat.filename };
}

async function getQuizRawOr404(quizId) {
  const db = getDb();
  const quiz = await db.getJson(`quiz:${quizId}`);
  if (!quiz) throw new HttpError(404, "Actividad no encontrada.");
  const pubLatest = await db.getJson(`pub_latest:${quizId}`);
  quiz.published_version = pubLatest ? pubLatest.version : null;
  return quiz;
}

async function getPublicationOr404(quizId, version = null) {
  const db = getDb();
  let pub;
  if (version === null || version === undefined) {
    pub = await db.getJson(`pub_latest:${quizId}`);
    if (!pub) throw new HttpError(404, "Esta práctica todavía no está publicada.");
  } else {
    pub = await db.getJson(`pub:${quizId}:${version}`);
    if (!pub) throw new HttpError(404, "La versión de la práctica no está publicada.");
  }
  if (pub.kind !== "practice") {
    throw new HttpError(404, "El banco oficial no está disponible en el espacio de práctica.");
  }
  return pub;
}

async function getStudentOr404(studentId) {
  const db = getDb();
  const [students, enrollments] = await Promise.all([
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
  ]);
  const st = students.find((s) => s.id === studentId);
  if (!st) throw new HttpError(404, "Estudiante no encontrado. Selecciona un perfil disponible.");
  const courseIds = enrollments
    .filter((e) => e.student_id === studentId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.course_id.localeCompare(b.course_id))
    .map((e) => e.course_id);
  return { ...st, course_ids: courseIds };
}

async function requireEnrollment(studentId, courseId) {
  const profile = await getStudentOr404(studentId);
  if (!profile.course_ids.includes(courseId)) {
    throw new HttpError(403, "Este estudiante no está inscrito en la asignatura. Inscríbelo antes de practicar.");
  }
  return profile;
}

async function ensureOwner(owner, studentId, { write = false } = {}) {
  if (studentId !== null && studentId !== undefined) {
    await getStudentOr404(studentId);
    if (owner !== studentId) {
      throw new HttpError(404, "Este registro no pertenece al estudiante seleccionado.");
    }
  } else if (write && owner !== null && owner !== undefined) {
    throw new HttpError(422, "Selecciona el estudiante al que pertenece este intento.");
  }
  if (write && (owner === null || owner === undefined)) {
    throw new HttpError(
      409,
      "Este intento histórico no tiene estudiante asignado y se conserva solo para consulta. Inicia una práctica con un perfil."
    );
  }
}

async function getAttemptOr404(attemptId, studentId = null) {
  const db = getDb();
  const attempt = await db.getJson(`attempt:${attemptId}`);
  if (!attempt) throw new HttpError(404, "Intento no encontrado.");
  await ensureOwner(attempt.student_id ?? null, studentId);
  const reinfIds = (await db.getJson(`attempt_reinfs:${attemptId}`, [])) || [];
  const students = (await db.getJson("col:students", [])) || [];
  const st = attempt.student_id ? students.find((s) => s.id === attempt.student_id) : null;
  return {
    ...attempt,
    student_name: st ? st.name : attempt.student_name ?? null,
    reinforcement_id: reinfIds.length ? reinfIds[reinfIds.length - 1] : null,
  };
}

async function getReinforcementOr404(reinforcementId, studentId = null) {
  const db = getDb();
  const value = await db.getJson(`reinf:${reinforcementId}`);
  if (!value) throw new HttpError(404, "Refuerzo no encontrado.");
  await ensureOwner(value.student_id ?? null, studentId);
  return value;
}

async function loadStudentHistories(studentId, courseId, unitId = null) {
  await requireEnrollment(studentId, courseId);
  const db = getDb();
  const allAttemptIds = (await db.getJson(`student_attempts:${studentId}`, [])) || [];
  const rawAttempts = (await Promise.all(allAttemptIds.map((id) => db.getJson(`attempt:${id}`)))).filter(Boolean);
  const filtered = rawAttempts
    .filter((a) => a.course_id === courseId && (!unitId || a.unit_id === unitId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const attempts = [];
  const supports = [];
  for (const a of filtered) {
    const rIds = (await db.getJson(`attempt_reinfs:${a.id}`, [])) || [];
    const rList = (await Promise.all(rIds.map((id) => db.getJson(`reinf:${id}`)))).filter(Boolean).reverse();
    const copy = { ...a, reinforcement_id: rList.length ? rList[0].id : null };
    attempts.push(copy);
    for (const r of rList) {
      supports.push({ ...r, student_id: a.student_id, unit_id: a.unit_id, course_id: a.course_id });
    }
  }
  return { attempts, supports };
}

async function ownStudentIdForUser(user) {
  if (user && user.role === "Estudiante") {
    return ensureStudentProfile(user);
  }
  return null;
}

// ---------- Validación estricta de preguntas y citas ----------

async function validateCourseItem(item, unitId, materialIds, { generated = false } = {}) {
  if (!item || typeof item !== "object") throw new Error("Elemento de pregunta inválido.");
  const id = isUuid(item.id) ? item.id.toLowerCase() : null;
  if (!id) throw new Error("El identificador de la pregunta no es un UUID válido.");
  if (item.type !== "multiple_choice" && item.type !== "open") {
    throw new Error("Tipo de pregunta inválido.");
  }
  const topic = String(item.topic || "").trim();
  const objective = String(item.objective || "").trim();
  const question = String(item.question || "").trim();
  let answer = String(item.answer || "").trim();
  const explanation = String(item.explanation || "").trim();
  if (!topic || topic.length > 300) throw new Error("Tema inválido en la pregunta.");
  if (!objective || objective.length > 5000) throw new Error("Objetivo inválido en la pregunta.");
  if (question.length < 5 || question.length > 1500) throw new Error("Enunciado de pregunta inválido.");
  if (!answer || answer.length > 5000) throw new Error("Respuesta inválida en la pregunta.");
  if (!explanation || explanation.length > 5000) throw new Error("Explicación inválida en la pregunta.");

  const cit = item.citation;
  if (!cit || typeof cit !== "object" || !isUuid(cit.material_id)) {
    throw new Error("Cita inválida en la pregunta.");
  }
  const pageNumber = Number(cit.page_number);
  const quote = String(cit.quote || "").trim();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100 || quote.length < 12 || quote.length > 10000) {
    throw new Error("La cita de la pregunta no tiene formato válido.");
  }

  const mat = await getMaterialRawOr404(cit.material_id.toLowerCase());
  if (mat.unit_id !== unitId || !materialIds.includes(mat.id)) {
    throw new Error("La fuente de la pregunta debe pertenecer a los materiales seleccionados de esta unidad.");
  }
  const page = await getPageOr404(mat.id, pageNumber);
  if (!normalizeWhitespace(page.text).includes(normalizeWhitespace(quote))) {
    throw new Error("La cita de la pregunta no coincide con la página del material.");
  }

  let options = Array.isArray(item.options) ? item.options.map((o) => String(o || "").trim()) : [];
  let correctIndex = item.correct_index === undefined ? null : item.correct_index;

  if (item.type === "multiple_choice") {
    if (
      options.length !== 4 ||
      options.some((o) => !o || o.length > 1000) ||
      new Set(options.map((o) => contentKey(o))).size !== 4
    ) {
      throw new Error("Cada pregunta de selección necesita cuatro alternativas diferentes.");
    }
    if (typeof correctIndex !== "number" || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw new Error("Selecciona la alternativa correcta de cada pregunta.");
    }
    if (generated && normalizeWhitespace(answer) !== normalizeWhitespace(options[correctIndex])) {
      throw new Error("La clave generada no coincide con su respuesta. Reintenta para obtener una propuesta consistente.");
    }
    answer = options[correctIndex];
  } else {
    if (options.length > 0 || correctIndex !== null) {
      throw new Error("Una pregunta abierta no debe contener alternativas ni clave de selección.");
    }
    options = [];
    correctIndex = null;
  }

  return {
    id,
    type: item.type,
    topic,
    objective,
    question,
    options,
    correct_index: correctIndex,
    answer,
    explanation,
    citation: {
      material_id: mat.id,
      filename: mat.filename,
      page_number: pageNumber,
      label: page.label,
      quote,
    },
    reviewed: Boolean(item.reviewed),
    model: item.model && typeof item.model === "object" ? item.model : {},
  };
}

async function candidatePages(quiz) {
  const words = wordTokens(quiz.objective || "");
  const materials = (await getDb().getJson("col:materials", [])) || [];
  const matById = new Map(materials.map((m) => [m.id, m]));

  const priorityTuple = (page) => {
    const text = String(page.text || "");
    const heading = text.slice(0, 250);
    const headingWords = contentKey(heading).split(" ").filter(Boolean);
    const overview = headingWords.some((w) => OVERVIEW_WORDS.has(w)) ? 0 : 1;
    let headingOverlap = 0;
    for (const w of wordTokens(heading)) if (words.has(w)) headingOverlap++;
    let overlap = 0;
    for (const w of wordTokens(text)) if (words.has(w)) overlap++;
    const rich = text.trim().length >= 180 ? 1 : 0;
    return [rich, overview, overlap + 2 * headingOverlap, headingOverlap, Math.min(text.length, 2500), -page.number];
  };

  const compareTupleDesc = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return b[i] - a[i];
    }
    return 0;
  };

  const groups = [];
  for (const materialId of quiz.material_ids || []) {
    const mat = matById.get(materialId);
    if (!mat) continue;
    const rawPages = await getMaterialPages(materialId);
    let rows = rawPages
      .map((p) => ({ ...p, filename: mat.filename }))
      .filter((p) => String(p.text || "").trim().length > 100);
    if (rows.length > 1) {
      rows = rows.filter((p) => p.number !== 1 || String(p.text || "").trim().length >= 600);
    }
    rows.sort((a, b) => compareTupleDesc(priorityTuple(a), priorityTuple(b)));
    if (rows.length) groups.push(rows);
  }

  if (!groups.length) {
    throw new Error(
      "Los materiales no tienen páginas con suficiente texto. Añade contenido seleccionable antes de generar."
    );
  }

  const maxLen = Math.max(...groups.map((g) => g.length));
  const interleaved = [];
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      if (i < g.length) interleaved.push(g[i]);
    }
  }
  return interleaved;
}

function quizItemTypeFor(questionType, requestedCount, index) {
  if (questionType !== "mixed") return questionType;
  if (requestedCount < 3) return index === requestedCount - 1 ? "open" : "multiple_choice";
  return index % 3 === 2 ? "open" : "multiple_choice";
}

function planParallelJobs(pages, indexes, stride, shift, usedPages, typeFor, objective, prevQ, prevA) {
  const claimed = new Set(usedPages);
  const jobs = [];
  for (const index of indexes) {
    const start = (index * stride + shift) % pages.length;
    const rotated = pages.slice(start).concat(pages.slice(0, start));
    const unused = rotated.filter((p) => !claimed.has(`${p.material_id}|${p.number}`));
    const reused = rotated.filter((p) => claimed.has(`${p.material_id}|${p.number}`));
    const candidates = unused.concat(reused).slice(0, Math.min(4, rotated.length));
    if (candidates.length) {
      claimed.add(`${candidates[0].material_id}|${candidates[0].number}`);
    }
    jobs.push({
      index,
      type: typeFor(index),
      candidates,
      objective,
      prevQ: [...prevQ],
      prevA: [...prevA],
    });
  }
  return jobs;
}

async function runParallelJobs(engine, jobs, deadlineMs) {
  return Promise.all(
    jobs.map(async (job) => {
      for (const page of job.candidates) {
        if (Date.now() >= deadlineMs) return { item: null, error: null };
        try {
          const item = await generateCourseItem(engine, page, job.objective, job.type, job.prevQ, {
            previousAnswers: job.prevA,
            styleIndex: job.index,
          });
          return { item, error: null };
        } catch (err) {
          const msg = err?.message || String(err);
          if (/Error HTTP|Falta configurar|Faltan AWS_|Tiempo de espera/i.test(msg)) {
            return { item: null, error: err };
          }
          continue;
        }
      }
      return { item: null, error: null };
    })
  );
}

/**
 * Avanza la generación de un cuestionario con un presupuesto estricto de tiempo (~6.2s)
 * para ser 100% seguro bajo Netlify Free (10s).
 */
async function advanceQuizGeneration(quizId, { budgetMs = QUIZ_STEP_BUDGET_MS } = {}) {
  const db = getDb();
  const quiz = await getQuizRawOr404(quizId);
  if (quiz.status !== "generating") return quiz;

  const nowMs = Date.now();
  if (quiz._lease_until && quiz._lease_until > nowMs) {
    return quiz;
  }
  quiz._lease_until = nowMs + 8000;
  await db.setJson(`quiz:${quizId}`, quiz);

  const deadline = nowMs + budgetMs;
  try {
    const pages = await candidatePages(quiz);
    const engine = getEngine();
    const stride = Math.max(1, Math.floor(pages.length / Math.max(quiz.requested_count, 1)));
    const usedPages = new Set(
      (quiz.items || [])
        .filter((it) => it.citation)
        .map((it) => `${it.citation.material_id}|${it.citation.page_number}`)
    );

    const maxAttempts = Math.max(quiz.requested_count * 4, pages.length * 2);
    let attemptsDone = Number(quiz._attempts_done || 0);
    let pageCursor = Number(quiz._page_cursor || 0);
    let fatalError = null;

    while (quiz.items.length < quiz.requested_count && attemptsDone < maxAttempts && Date.now() < deadline) {
      const remaining = quiz.requested_count - quiz.items.length;
      const batchCount = Math.min(QUIZ_BATCH_SIZE, remaining);
      const indexes = [];
      for (let k = 0; k < batchCount; k++) indexes.push(quiz.items.length + k);

      const shift = (quiz.generation_round || 0) * quiz.material_ids.length + pageCursor;
      const jobs = planParallelJobs(
        pages,
        indexes,
        stride,
        shift,
        usedPages,
        (i) => quizItemTypeFor(quiz.question_type, quiz.requested_count, i),
        quiz.objective,
        quiz.items.map((i) => i.question),
        quiz.items.map((i) => i.answer).filter(Boolean)
      );

      attemptsDone += jobs.length;
      const results = await runParallelJobs(engine, jobs, deadline);
      let addedInWave = 0;

      for (let k = 0; k < jobs.length; k++) {
        const res = results[k];
        if (res.error) fatalError = res.error;
        if (!res.item) continue;
        const candidate = { ...res.item, id: uuid4(), reviewed: false };
        try {
          const validated = await validateCourseItem(candidate, quiz.unit_id, quiz.material_ids, { generated: true });
          if (validated.type !== jobs[k].type) continue;
          if (quiz.items.some((old) => contentKey(old.question) === contentKey(validated.question))) continue;
          quiz.items.push(validated);
          if (validated.citation) {
            usedPages.add(`${validated.citation.material_id}|${validated.citation.page_number}`);
          }
          addedInWave++;
        } catch {
          continue;
        }
      }

      if (addedInWave === 0) {
        pageCursor += 1;
        if (fatalError) {
          throw fatalError;
        }
      }

      quiz._attempts_done = attemptsDone;
      quiz._page_cursor = pageCursor;
      quiz._lease_until = Date.now() + 8000;
      await db.setJson(`quiz:${quizId}`, quiz);
    }

    if (quiz.items.length >= quiz.requested_count) {
      quiz.status = "draft";
      quiz.error = null;
      quiz._lease_until = 0;
    } else if (attemptsDone >= maxAttempts) {
      throw new Error(
        "No se pudieron completar todas las preguntas solicitadas con el material disponible."
      );
    } else {
      // Siguiente poll de React continuará con el siguiente lote
      quiz._lease_until = 0;
    }
    await db.setJson(`quiz:${quizId}`, quiz);
    return quiz;
  } catch (err) {
    const message =
      err instanceof HttpError
        ? String(err.detail)
        : err instanceof Error
          ? err.message
          : "El motor no pudo completar la generación. Lo guardado se conserva; puedes reintentarlo.";
    quiz.status = "failed";
    quiz.error = message.slice(0, 1000);
    quiz._lease_until = 0;
    await db.setJson(`quiz:${quizId}`, quiz);
    return quiz;
  }
}

// ---------- Refuerzos (source_review + generación por etapas) ----------

async function reviewedSourceItem(value, attempt) {
  const targets = (attempt.items || []).filter((it) => (value.target_item_ids || []).includes(it.id));
  if (targets.length !== 1 || targets[0].reviewed !== true) {
    throw new Error(
      "No hay una pregunta revisada disponible. Pide a tu docente que revise la actividad de esta unidad."
    );
  }
  const target = targets[0];
  return validateCourseItem(target, attempt.unit_id, [target.citation.material_id], { generated: true });
}

async function completeSourceReview(identifier, { reason, generationToken = null, fallbackReason = null } = {}) {
  const db = getDb();
  const value = await getReinforcementOr404(identifier);
  if (
    (value.status !== "generating" && value.status !== "failed") ||
    value.response ||
    (generationToken !== null && value.generation_token !== generationToken)
  ) {
    return value;
  }
  const attempt = await getAttemptOr404(value.attempt_id);
  const target = await reviewedSourceItem(value, attempt);
  const exercise = { ...target, id: uuid4(), model: { mode: "source_review" } };
  value.status = "ready";
  value.error = null;
  value.activity_kind = "source_review";
  value.topic = target.topic;
  value.explanation = target.explanation;
  value.example = target.citation.quote;
  value.citation = target.citation;
  value.private_exercise = exercise;
  value.matching = [];
  value.model = { mode: "source_review", reason };
  value.source_review = {
    source_item_id: target.id,
    quiz_id: attempt.quiz_id,
    quiz_version: attempt.version,
  };
  value._gen_progress = null;
  value._lease_until = 0;
  if (fallbackReason) value.fallback_reason = fallbackReason;
  if (value.adaptation) {
    value.adaptation.resolved_format = "steps";
    value.adaptation.format_reason =
      "Este repaso utiliza la explicación y la referencia revisadas de la clase, paso a paso.";
    value.adaptation.reasoning_considered = false;
    value.adaptation.reasoning_note =
      "Si compartiste tu razonamiento, queda guardado para revisión. Este repaso utiliza la explicación y la referencia del material del profesor.";
  }
  await db.setJson(`reinf:${identifier}`, value);
  return value;
}

async function advanceReinforcementGeneration(identifier, { budgetMs = REINF_STEP_BUDGET_MS } = {}) {
  const db = getDb();
  const value = await getReinforcementOr404(identifier);
  if (value.status !== "generating" || value.response) return value;

  const nowMs = Date.now();
  if (value._lease_until && value._lease_until > nowMs) {
    return value;
  }

  // Timeout global de 90s -> source_review automático
  const ageSec = (nowMs - Date.parse(value.created_at || "")) / 1000;
  if (Number.isFinite(ageSec) && ageSec > 90) {
    try {
      return await completeSourceReview(identifier, {
        reason: "generation_timeout",
        generationToken: value.generation_token,
      });
    } catch {
      return value;
    }
  }

  value._lease_until = nowMs + 8000;
  await db.setJson(`reinf:${identifier}`, value);

  const token = value.generation_token;
  try {
    const attempt = await getAttemptOr404(value.attempt_id);
    const reviewed = await reviewedSourceItem(value, attempt);
    const orig = attempt.items.find((it) => it.id === reviewed.id) || {};
    const target = [{ ...orig, ...reviewed }];
    const source = target[0].citation;
    const page = await getPageOr404(source.material_id, source.page_number);

    const engine = getEngine();
    const step = await stepReinforcementGeneration(
      engine,
      { ...attempt, items: target, adaptation: value.adaptation },
      page,
      value._gen_progress || null,
      { budgetMs }
    );

    if (!step.done) {
      value._gen_progress = step.progress;
      value._lease_until = 0;
      await db.setJson(`reinf:${identifier}`, value);
      return value;
    }

    const result = step.result;
    const exercise = await validateCourseItem(
      { ...result.exercise, id: uuid4(), reviewed: false },
      attempt.unit_id,
      [source.material_id],
      { generated: true }
    );
    const attemptQuestions = new Set(attempt.items.map((it) => contentKey(it.question)));
    if (attemptQuestions.has(contentKey(exercise.question))) {
      throw new Error("El refuerzo repitió una pregunta anterior. Genera un ejercicio diferente.");
    }
    const citedPage = await getPageOr404(result.citation.material_id, result.citation.page_number);
    if (
      result.citation.material_id !== source.material_id ||
      !normalizeWhitespace(citedPage.text).includes(normalizeWhitespace(result.citation.quote))
    ) {
      throw new Error("La explicación del refuerzo no contiene una cita verificable de su material.");
    }
    const cleanCitation = {
      ...result.citation,
      filename: citedPage.filename,
      label: citedPage.label,
    };

    let cleanMatching = [];
    try {
      const mList = result.matching || [];
      if (!Array.isArray(mList) || mList.length > 5 || mList.length === 1) throw new Error("invalid");
      for (let i = 0; i < mList.length; i++) {
        const pair = mList[i];
        if (
          !pair ||
          typeof pair.concept !== "string" ||
          typeof pair.definition !== "string" ||
          !pair.concept.trim() ||
          pair.concept.length > 1000 ||
          !pair.definition.trim() ||
          pair.definition.length > 1000
        ) {
          throw new Error("invalid");
        }
        cleanMatching.push({ id: String(i + 1), concept: pair.concept.trim(), definition: pair.definition.trim() });
      }
      if (
        new Set(cleanMatching.map((p) => p.concept.toLowerCase())).size !== cleanMatching.length ||
        new Set(cleanMatching.map((p) => p.definition.toLowerCase())).size !== cleanMatching.length
      ) {
        throw new Error("dup");
      }
    } catch {
      cleanMatching = [];
    }

    for (const field of ["topic", "explanation", "example"]) {
      if (typeof result[field] !== "string" || !result[field].trim() || result[field].length > 6000) {
        throw new Error("El apoyo generado está incompleto. Vuelve a intentarlo.");
      }
    }

    value.status = "ready";
    value.error = null;
    value.activity_kind = "generated_case";
    value.topic = result.topic;
    value.explanation = result.explanation;
    value.example = result.example;
    value.citation = cleanCitation;
    value.private_exercise = exercise;
    value.matching = cleanMatching;
    value.model = result.model || {};
    value.support_basis = result.support_basis || "generated_example";
    value._gen_progress = null;
    value._lease_until = 0;

    if (value.adaptation && result.adaptation) {
      for (const k of ["resolved_format", "format_reason", "reasoning_considered", "reasoning_note"]) {
        if (k in result.adaptation) value.adaptation[k] = result.adaptation[k];
      }
    }

    await db.setJson(`reinf:${identifier}`, value);
    return value;
  } catch (err) {
    const isMotorUnavailable =
      (err instanceof HttpError && err.status >= 500) ||
      /Error HTTP|Tiempo de espera|Falta configurar|Faltan AWS_/i.test(err?.message || "");
    const fallbackReason = isMotorUnavailable ? "motor_no_disponible" : "controles_rechazaron";
    try {
      return await completeSourceReview(identifier, {
        reason: "generation_unavailable",
        generationToken: token,
        fallbackReason,
      });
    } catch (sourceErr) {
      value.status = "failed";
      value.error = String(sourceErr?.message || sourceErr).slice(0, 1000);
      value._gen_progress = null;
      value._lease_until = 0;
      await db.setJson(`reinf:${identifier}`, value);
      return value;
    }
  }
}

// ---------- Handlers exportados para el router ----------

export async function listCourses() {
  const db = getDb();
  const [courses, units] = await Promise.all([
    db.getJson("col:courses", []),
    db.getJson("col:units", []),
  ]);
  return courses.map((c) => ({
    ...c,
    unit_count: units.filter((u) => u.course_id === c.id).length,
  }));
}

export async function createCourse(body) {
  const title = requireString(body, "title", { min: 1, max: 300 });
  const code = typeof body.code === "string" ? body.code.trim().slice(0, 50) : "";
  const db = getDb();
  const courses = (await db.getJson("col:courses", [])) || [];
  const item = { id: uuid4(), title, code };
  courses.push(item);
  await db.setJson("col:courses", courses);
  return { ...item, unit_count: 0 };
}

export async function getCourse(courseId) {
  const cid = requireUuid(courseId, "course_id");
  const course = await getCourseOr404(cid);
  const units = ((await getDb().getJson("col:units", [])) || [])
    .filter((u) => u.course_id === cid)
    .sort((a, b) => a.position - b.position);
  course.units = await Promise.all(units.map((u) => getUnitOr404(u.id)));
  return course;
}

export async function createUnit(courseId, body) {
  const cid = requireUuid(courseId, "course_id");
  await getCourseOr404(cid);
  const title = requireString(body, "title", { min: 1, max: 300 });
  const position = requireInt(body, "position", { min: 1, max: 100 });
  const objectives = typeof body.objectives === "string" ? body.objectives.trim().slice(0, 3000) : "";
  const db = getDb();
  const units = (await db.getJson("col:units", [])) || [];
  const item = { id: uuid4(), course_id: cid, title, position, objectives };
  units.push(item);
  await db.setJson("col:units", units);
  return { ...item, material_count: 0, quiz_count: 0 };
}

export async function getUnit(unitId) {
  const uid = requireUuid(unitId, "unit_id");
  const db = getDb();
  const unit = await getUnitOr404(uid);
  const [course, materials, unitQuizIds] = await Promise.all([
    getCourseOr404(unit.course_id),
    db.getJson("col:materials", []),
    db.getJson(`unit_quizzes:${uid}`, null),
  ]);
  let qList = [];
  if (Array.isArray(unitQuizIds)) {
    const raw = (await Promise.all([...unitQuizIds].reverse().map((id) => getQuizRawOr404(id).catch(() => null)))).filter(
      Boolean
    );
    qList = raw.map(quizSummary);
  } else {
    const allIds = (await db.getJson("col:quiz_ids", [])) || [];
    const raw = (await Promise.all([...allIds].reverse().map((id) => getQuizRawOr404(id).catch(() => null)))).filter(
      (q) => q && q.unit_id === uid
    );
    qList = raw.map(quizSummary);
  }
  return {
    ...unit,
    course,
    materials: materials
      .filter((m) => m.unit_id === uid)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(publicMaterial),
    quizzes: qList,
  };
}

export async function saveMaterial(unitId, filename, bytes, { text = null } = {}) {
  const uid = requireUuid(unitId, "unit_id");
  await getUnitOr404(uid);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = sha256Hex(Buffer.from(u8));

  const db = getDb();
  const materials = (await db.getJson("col:materials", [])) || [];
  const existing = materials.find((m) => m.unit_id === uid && m.sha256 === digest);
  if (existing) return publicMaterial(existing);

  let kind;
  let pages;
  if (text !== null) {
    kind = "text";
    pages = [{ number: 1, label: "Texto 1", text }];
  } else {
    try {
      const extracted = await extractPages(filename, u8);
      kind = extracted.kind;
      pages = extracted.pages;
    } catch (err) {
      throw new HttpError(422, err?.message || "No se pudo procesar el material.");
    }
  }

  const identifier = uuid4();
  const safeFilename =
    String(filename || "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      .trim()
      .slice(0, 250) || `Material.${kind}`;
  const storageName = `${identifier}.${kind}`;
  const record = {
    id: identifier,
    unit_id: uid,
    filename: safeFilename,
    kind,
    sha256: digest,
    page_count: pages.length,
    created_at: nowIso(),
    storage_name: storageName,
  };
  const pageRecords = pages.map((p) => ({
    id: uuid4(),
    material_id: identifier,
    number: p.number,
    label: p.label,
    text: p.text,
  }));

  materials.push(record);
  await Promise.all([
    getFilesStore().setBytes(`file:${identifier}`, u8),
    db.setJson(`pages:${identifier}`, pageRecords),
    db.setJson("col:materials", materials),
  ]);
  return publicMaterial(record);
}

export async function uploadMaterialFromRequest(unitId, req) {
  let form;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(422, "Envía el archivo como multipart/form-data en el campo 'file'.");
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new HttpError(422, "Falta el archivo en el campo 'file'.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    throw new HttpError(413, "El archivo supera el límite de 40 MB.");
  }
  return saveMaterial(unitId, file.name || "material", bytes);
}

export async function uploadTextMaterial(unitId, body) {
  const title = requireString(body, "title", { min: 1, max: 300 });
  const text = requireString(body, "text", { min: 100, max: 100000 });
  return saveMaterial(unitId, `${title}.txt`, Buffer.from(text, "utf8"), { text });
}

export async function listMaterialPages(materialId) {
  const mid = requireUuid(materialId, "material_id");
  const mat = await getMaterialRawOr404(mid);
  const pages = await getMaterialPages(mid);
  return pages
    .sort((a, b) => a.number - b.number)
    .map((p) => ({ ...p, filename: mat.filename }));
}

export async function serveMaterialFile(req, materialId) {
  const mid = requireUuid(materialId, "material_id");
  const mat = await getMaterialRawOr404(mid);

  // 1. Archivos subidos por el docente en Netlify Blobs
  const uploadedBytes = await getFilesStore().getBytes(`file:${mid}`);
  if (uploadedBytes) {
    const mimeMap = {
      pdf: "application/pdf",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      text: "text/plain; charset=utf-8",
    };
    const headers = owaspHeaders(req, true);
    headers.set("Content-Type", mimeMap[mat.kind] || "application/octet-stream");
    const safeName = String(mat.filename || "material").replace(/"/g, "");
    const disp = mat.kind === "pdf" ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disp}; filename="${safeName}"`);
    return new Response(uploadedBytes, { status: 200, headers });
  }

  // 2. PDFs precargados servidos desde Netlify CDN (`/seed-materials/<storage_name>`)
  // Redirección 302 autenticada: preserva `#page=N` y evita el límite de 6 MB de AWS Lambda
  const seedCore = loadSeedCore();
  const isSeeded = (seedCore.materials || []).some((m) => m.id === mid);
  if (isSeeded && mat.storage_name) {
    const headers = owaspHeaders(req, true);
    headers.set("Location", `/seed-materials/${encodeURIComponent(mat.storage_name)}`);
    return new Response(null, { status: 302, headers });
  }

  throw new HttpError(404, "No se encuentra la copia del archivo. El texto extraído sigue disponible.");
}

// ---------- Quizzes ----------

export async function createQuiz(unitId, body) {
  const uid = requireUuid(unitId, "unit_id");
  await getUnitOr404(uid);
  const title = requireString(body, "title", { min: 1, max: 300 });
  const objective = requireString(body, "objective", { min: 1, max: 5000 });
  const kind = body.kind || "practice";
  const questionType = body.question_type || "multiple_choice";
  const count = body.count !== undefined ? requireInt(body, "count", { min: 5, max: 30 }) : 10;
  if (kind !== "practice" && kind !== "official") throw new HttpError(422, "Tipo de actividad inválido.");
  if (!["multiple_choice", "open", "mixed"].includes(questionType)) {
    throw new HttpError(422, "Formato de pregunta inválido.");
  }
  if (!Array.isArray(body.material_ids) || body.material_ids.length < 1 || body.material_ids.length > 20) {
    throw new HttpError(422, "Selecciona entre 1 y 20 materiales de esta unidad.");
  }
  const materialIds = Array.from(new Set(body.material_ids.map((id) => requireUuid(id, "material_id"))));
  for (const mid of materialIds) {
    const mat = await getMaterialRawOr404(mid);
    if (mat.unit_id !== uid) {
      throw new HttpError(422, "Elige únicamente materiales de esta unidad.");
    }
  }

  const identifier = uuid4();
  const value = {
    id: identifier,
    unit_id: uid,
    title,
    objective,
    kind,
    question_type: questionType,
    requested_count: count,
    status: "generating",
    version: 1,
    published_version: null,
    items: [],
    error: null,
    created_at: nowIso(),
    material_ids: materialIds,
    generation_round: 0,
    _attempts_done: 0,
    _page_cursor: 0,
    _lease_until: 0,
  };

  try {
    await candidatePages(value);
  } catch (err) {
    throw new HttpError(422, err?.message || "No hay páginas suficientes.");
  }

  const db = getDb();
  const [allQuizIds, unitQuizIds] = await Promise.all([
    db.getJson("col:quiz_ids", []),
    db.getJson(`unit_quizzes:${uid}`, []),
  ]);
  allQuizIds.push(identifier);
  unitQuizIds.push(identifier);
  await Promise.all([
    db.setJson(`quiz:${identifier}`, value),
    db.setJson("col:quiz_ids", allQuizIds),
    db.setJson(`unit_quizzes:${uid}`, unitQuizIds),
  ]);

  // Genera inmediatamente el primer lote (rápido, <= 4s) para respuesta instantánea en la UI
  const updated = await advanceQuizGeneration(identifier, { budgetMs: 4200 });
  return cleanQuizForClient(updated);
}

export async function getQuiz(quizId) {
  const qid = requireUuid(quizId, "quiz_id");
  const quiz = await getQuizRawOr404(qid);
  if (quiz.status === "generating") {
    const updated = await advanceQuizGeneration(qid, { budgetMs: QUIZ_STEP_BUDGET_MS });
    return cleanQuizForClient(updated);
  }
  return cleanQuizForClient(quiz);
}

export async function retryQuiz(quizId) {
  const qid = requireUuid(quizId, "quiz_id");
  const db = getDb();
  const value = await getQuizRawOr404(qid);
  if (value.status !== "failed") {
    throw new HttpError(409, "Solo se puede reintentar una generación interrumpida o fallida.");
  }
  value.status = "generating";
  value.error = null;
  value.generation_round = (value.generation_round || 0) + 1;
  value._attempts_done = 0;
  value._page_cursor = 0;
  value._lease_until = 0;
  await db.setJson(`quiz:${qid}`, value);
  const updated = await advanceQuizGeneration(qid, { budgetMs: 4200 });
  return cleanQuizForClient(updated);
}

export async function editQuiz(quizId, body) {
  const qid = requireUuid(quizId, "quiz_id");
  const version = requireInt(body, "version", { min: 1 });
  const title = requireString(body, "title", { min: 1, max: 300 });
  const objective = requireString(body, "objective", { min: 1, max: 5000 });
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    throw new HttpError(422, "La actividad debe contener entre 1 y 30 preguntas.");
  }

  const db = getDb();
  const value = await getQuizRawOr404(qid);
  if ((value.status !== "draft" && value.status !== "published") || version !== value.version) {
    throw new HttpError(409, "Completa la generación y abre la versión más reciente antes de editar la actividad.");
  }
  const existingIds = new Set(value.items.map((i) => i.id));
  const incomingIds = new Set(body.items.map((i) => String(i?.id || "").toLowerCase()));
  if (
    body.items.length !== value.items.length ||
    incomingIds.size !== existingIds.size ||
    ![...incomingIds].every((id) => existingIds.has(id))
  ) {
    throw new HttpError(422, "Conserva los identificadores de las preguntas de esta actividad.");
  }

  const originalById = new Map(value.items.map((i) => [i.id, i]));
  const items = [];
  try {
    for (const rawItem of body.items) {
      const validated = await validateCourseItem(rawItem, value.unit_id, value.material_ids, { generated: false });
      validated.model = originalById.get(validated.id)?.model || {};
      items.push(validated);
    }
  } catch (err) {
    throw new HttpError(422, err?.message || "Pregunta inválida.");
  }

  if (new Set(items.map((i) => contentKey(i.question))).size !== items.length) {
    throw new HttpError(422, "La actividad contiene preguntas duplicadas.");
  }

  value.title = title;
  value.objective = objective;
  value.items = items;
  value.version = value.version + 1;
  value.status = "draft";
  value.error = null;
  await db.setJson(`quiz:${qid}`, value);
  return cleanQuizForClient(value);
}

export async function publishQuiz(quizId, body) {
  const qid = requireUuid(quizId, "quiz_id");
  const version = requireInt(body, "version", { min: 1 });
  const db = getDb();
  const value = await getQuizRawOr404(qid);
  if (version !== value.version || (value.status !== "draft" && value.status !== "published")) {
    throw new HttpError(409, "Abre el borrador completo y más reciente antes de publicarlo.");
  }
  if (value.items.length !== value.requested_count || !value.items.every((i) => i.reviewed === true)) {
    throw new HttpError(422, "Revisa todas las preguntas, sus fuentes y sus respuestas correctas antes de publicar.");
  }
  value.status = "published";
  value.error = null;
  value.published_version = value.version;
  const snapshot = cleanQuizForClient(value);

  const existingPub = await db.getJson(`pub:${qid}:${value.version}`);
  const writes = [db.setJson(`quiz:${qid}`, value), db.setJson(`pub_latest:${qid}`, snapshot)];
  if (!existingPub) writes.push(db.setJson(`pub:${qid}:${value.version}`, snapshot));
  await Promise.all(writes);
  return snapshot;
}

export async function listUnitPractice(unitId) {
  const uid = requireUuid(unitId, "unit_id");
  await getUnitOr404(uid);
  const db = getDb();
  const unitQuizIds = (await db.getJson(`unit_quizzes:${uid}`, [])) || [];
  const result = [];
  for (const qid of [...unitQuizIds].reverse()) {
    const pub = await db.getJson(`pub_latest:${qid}`);
    if (pub && pub.kind === "practice") {
      pub.published_version = pub.version;
      result.push(quizSummary(pub));
    }
  }
  return result;
}

export async function getQuizPractice(quizId) {
  const qid = requireUuid(quizId, "quiz_id");
  return publicQuiz(await getPublicationOr404(qid));
}

// ---------- Students & Progress ----------

export async function listStudents(user) {
  const ownSid = await ownStudentIdForUser(user);
  if (ownSid) return [await getStudentOr404(ownSid)];
  const db = getDb();
  const students = (await db.getJson("col:students", [])) || [];
  const sorted = [...students].sort(
    (a, b) =>
      String(a.name).localeCompare(String(b.name), "es", { sensitivity: "base" }) ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      a.id.localeCompare(b.id)
  );
  return Promise.all(sorted.map((s) => getStudentOr404(s.id)));
}

export async function createStudent(user, body) {
  if (await ownStudentIdForUser(user)) {
    throw new HttpError(403, "Solo docentes o administradores pueden crear nuevos perfiles de estudiante.");
  }
  const name = requireString(body, "name", { min: 1, max: 100 });
  const goals = typeof body.goals === "string" ? body.goals.trim().slice(0, 1200) : "";
  const presentation = body.presentation || "auto";
  if (!["auto", "visual", "steps"].includes(presentation)) {
    throw new HttpError(422, "Preferencia de presentación inválida.");
  }
  const rawCourses = Array.isArray(body.course_ids) ? body.course_ids : [];
  if (rawCourses.length > 30) throw new HttpError(422, "Máximo 30 asignaturas por perfil.");
  const courseIds = Array.from(new Set(rawCourses.map((c) => requireUuid(c, "course_id"))));
  for (const cid of courseIds) await getCourseOr404(cid);

  const db = getDb();
  const [students, enrollments] = await Promise.all([
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
  ]);
  const id = uuid4();
  const ts = nowIso();
  students.push({ id, name, goals, presentation, created_at: ts, updated_at: ts, owner_email: null });
  for (const cid of courseIds) {
    enrollments.push({ student_id: id, course_id: cid, created_at: ts });
  }
  await Promise.all([db.setJson("col:students", students), db.setJson("col:enrollments", enrollments)]);
  return getStudentOr404(id);
}

export async function getStudent(user, studentId) {
  const sid = requireUuid(studentId, "student_id");
  const ownSid = await ownStudentIdForUser(user);
  if (ownSid && sid !== ownSid) {
    throw new HttpError(403, "No tienes permiso para acceder al perfil de otro estudiante.");
  }
  return getStudentOr404(sid);
}

export async function updateStudent(user, studentId, body) {
  const sid = requireUuid(studentId, "student_id");
  const ownSid = await ownStudentIdForUser(user);
  if (ownSid && sid !== ownSid) {
    throw new HttpError(403, "No tienes permiso para modificar el perfil de otro estudiante.");
  }
  const name = requireString(body, "name", { min: 1, max: 100 });
  const goals = typeof body.goals === "string" ? body.goals.trim().slice(0, 1200) : "";
  const presentation = body.presentation || "auto";
  if (!["auto", "visual", "steps"].includes(presentation)) {
    throw new HttpError(422, "Preferencia de presentación inválida.");
  }
  const db = getDb();
  const students = (await db.getJson("col:students", [])) || [];
  const idx = students.findIndex((s) => s.id === sid);
  if (idx < 0) throw new HttpError(404, "Estudiante no encontrado. Selecciona un perfil disponible.");
  students[idx] = { ...students[idx], name, goals, presentation, updated_at: nowIso() };
  await db.setJson("col:students", students);
  return getStudentOr404(sid);
}

export async function listEnrolledStudents(user, courseId) {
  const cid = requireUuid(courseId, "course_id");
  await getCourseOr404(cid);
  const ownSid = await ownStudentIdForUser(user);
  if (ownSid) {
    const prof = await getStudentOr404(ownSid);
    return prof.course_ids.includes(cid) ? [prof] : [];
  }
  const db = getDb();
  const [students, enrollments] = await Promise.all([
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
  ]);
  const enrolledIds = new Set(enrollments.filter((e) => e.course_id === cid).map((e) => e.student_id));
  const matched = students
    .filter((s) => enrolledIds.has(s.id))
    .sort(
      (a, b) =>
        String(a.name).localeCompare(String(b.name), "es", { sensitivity: "base" }) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        a.id.localeCompare(b.id)
    );
  return Promise.all(matched.map((s) => getStudentOr404(s.id)));
}

export async function enrollStudent(courseId, body) {
  const cid = requireUuid(courseId, "course_id");
  const sid = requireUuid(body?.student_id, "student_id");
  await getCourseOr404(cid);
  await getStudentOr404(sid);
  const db = getDb();
  const enrollments = (await db.getJson("col:enrollments", [])) || [];
  if (!enrollments.some((e) => e.student_id === sid && e.course_id === cid)) {
    enrollments.push({ student_id: sid, course_id: cid, created_at: nowIso() });
    await db.setJson("col:enrollments", enrollments);
  }
  return getStudentOr404(sid);
}

export async function getStudentProgress(user, studentId, courseIdParam, unitIdParam) {
  const sid = requireUuid(studentId, "student_id");
  const ownSid = await ownStudentIdForUser(user);
  if (ownSid && sid !== ownSid) {
    throw new HttpError(403, "No tienes permiso para consultar el progreso de otro estudiante.");
  }
  const cid = requireUuid(courseIdParam, "course_id");
  const uid = unitIdParam ? requireUuid(unitIdParam, "unit_id") : null;
  const profile = await requireEnrollment(sid, cid);
  await getCourseOr404(cid);
  if (uid) {
    const u = await getUnitOr404(uid);
    if (u.course_id !== cid) throw new HttpError(422, "La unidad no pertenece a esta asignatura.");
  }
  const { attempts, supports } = await loadStudentHistories(sid, cid, uid);
  const result = summarizeProgress(profile, attempts, supports);
  return {
    ...result,
    student: profile,
    course_id: cid,
    unit_id: uid,
    attempts: attempts.map((a) => {
      const copy = { ...a };
      delete copy.items;
      return copy;
    }),
    reinforcements: supports.map((s) => {
      const copy = { ...s };
      delete copy.private_exercise;
      delete copy.model;
      delete copy.generation_token;
      delete copy._gen_progress;
      delete copy._lease_until;
      return copy;
    }),
  };
}

// ---------- Attempts & Reinforcements ----------

export async function createAttempt(quizId, body) {
  const qid = requireUuid(quizId, "quiz_id");
  const version = requireInt(body, "version", { min: 1 });
  const requestId = requireUuid(body?.request_id, "request_id");
  const studentId = requireUuid(body?.student_id, "student_id");
  if (!Array.isArray(body?.answers) || body.answers.length < 1 || body.answers.length > 30) {
    throw new HttpError(422, "Responde una vez cada pregunta antes de enviar la actividad.");
  }

  const normalizedAnswers = body.answers.map((a) => ({
    item_id: requireUuid(a?.item_id, "item_id"),
    selected_index: a?.selected_index === undefined ? null : a.selected_index,
    response: typeof a?.response === "string" ? a.response.slice(0, 5000) : "",
    justification: typeof a?.justification === "string" ? a.justification.slice(0, 3000) : "",
  }));

  const identifier = uuid5(studentId, requestId);
  const submitted = stableStringify({
    quiz_id: qid,
    version,
    request_id: requestId,
    student_id: studentId,
    answers: normalizedAnswers,
  });

  const quiz = await getPublicationOr404(qid, version);
  const unit = await getUnitOr404(quiz.unit_id);
  const profile = await requireEnrollment(studentId, unit.course_id);

  const db = getDb();
  const existing = await db.getJson(`attempt:${identifier}`);
  if (existing) {
    if (existing._input !== submitted) {
      throw new HttpError(409, "Este envío ya se guardó con otra respuesta. Inicia un nuevo intento.");
    }
    return getAttemptOr404(identifier, studentId);
  }

  const answerById = new Map();
  for (const a of normalizedAnswers) answerById.set(a.item_id, a);
  const expectedIds = new Set(quiz.items.map((i) => i.id));
  if (answerById.size !== normalizedAnswers.length || answerById.size !== expectedIds.size) {
    throw new HttpError(422, "Responde una vez cada pregunta antes de enviar la actividad.");
  }
  for (const id of expectedIds) {
    if (!answerById.has(id)) {
      throw new HttpError(422, "Responde una vez cada pregunta antes de enviar la actividad.");
    }
  }

  const items = [];
  for (const item of quiz.items) {
    const ans = answerById.get(item.id);
    let correct;
    let response;
    if (item.type === "multiple_choice") {
      if (
        typeof ans.selected_index !== "number" ||
        !Number.isInteger(ans.selected_index) ||
        ans.selected_index < 0 ||
        ans.selected_index >= item.options.length
      ) {
        throw new HttpError(422, "Elige una alternativa en cada pregunta de selección.");
      }
      correct = ans.selected_index === item.correct_index;
      response = item.options[ans.selected_index];
    } else {
      if (ans.selected_index !== null || !ans.response.trim()) {
        throw new HttpError(422, "Escribe tu respuesta en cada pregunta abierta.");
      }
      correct = null;
      response = ans.response.trim();
    }
    items.push({
      ...item,
      selected_index: ans.selected_index,
      response,
      justification: ans.justification.trim(),
      correct,
    });
  }

  const value = {
    id: identifier,
    quiz_id: qid,
    quiz_title: quiz.title,
    unit_id: quiz.unit_id,
    course_id: unit.course_id,
    student_id: profile.id,
    student_name: profile.name,
    profile_snapshot: {
      id: profile.id,
      name: profile.name,
      goals: profile.goals,
      presentation: profile.presentation,
      updated_at: profile.updated_at,
    },
    version,
    created_at: nowIso(),
    correct_count: items.filter((i) => i.correct === true).length,
    graded_count: items.filter((i) => i.correct !== null).length,
    open_count: items.filter((i) => i.correct === null).length,
    items,
    reinforcement_id: null,
    _input: submitted,
  };

  const [allIds, unitIds, studentIds] = await Promise.all([
    db.getJson("col:attempt_ids", []),
    db.getJson(`unit_attempts:${quiz.unit_id}`, []),
    db.getJson(`student_attempts:${profile.id}`, []),
  ]);
  allIds.push(identifier);
  unitIds.push(identifier);
  studentIds.push(identifier);

  await Promise.all([
    db.setJson(`attempt:${identifier}`, value),
    db.setJson("col:attempt_ids", allIds),
    db.setJson(`unit_attempts:${quiz.unit_id}`, unitIds),
    db.setJson(`student_attempts:${profile.id}`, studentIds),
  ]);

  const out = { ...value };
  delete out._input;
  return out;
}

export async function listUnitAttempts(unitId, studentIdParam = null) {
  const uid = requireUuid(unitId, "unit_id");
  const unit = await getUnitOr404(uid);
  const sid = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  if (sid) await requireEnrollment(sid, unit.course_id);

  const db = getDb();
  const ids = (await db.getJson(`unit_attempts:${uid}`, [])) || [];
  const attempts = (await Promise.all([...ids].reverse().map((id) => getAttemptOr404(id).catch(() => null)))).filter(
    (a) => a && (!sid || a.student_id === sid)
  );
  attempts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return attempts.map((a) => {
    const out = { ...a };
    delete out.items;
    delete out.profile_snapshot;
    delete out._input;
    return out;
  });
}

export async function getAttempt(attemptId, studentIdParam = null) {
  const aid = requireUuid(attemptId, "attempt_id");
  const sid = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const res = await getAttemptOr404(aid, sid);
  const out = { ...res };
  delete out._input;
  return out;
}

export async function startReinforcement(attemptId, studentIdParam = null, sourceReview = false) {
  const aid = requireUuid(attemptId, "attempt_id");
  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const attempt = await getAttemptOr404(aid, scope);
  await ensureOwner(attempt.student_id, scope, { write: true });

  const db = getDb();
  let useSource = Boolean(sourceReview);
  let sourceReason = "student_requested";

  const existingIds = (await db.getJson(`attempt_reinfs:${aid}`, [])) || [];
  let value = null;

  if (existingIds.length) {
    const latestId = existingIds[existingIds.length - 1];
    value = await db.getJson(`reinf:${latestId}`);
    if (value) {
      if (value.status === "ready" || value.response || (value.status === "generating" && !sourceReview)) {
        return publicReinforcement(value);
      }
      if (value.status === "failed") {
        useSource = true;
        sourceReason = "recovered_failure";
      }
      restartReinforcementGeneration(value);
      await db.setJson(`reinf:${value.id}`, value);
    }
  }

  if (!value) {
    const profile = await requireEnrollment(attempt.student_id, attempt.course_id);
    const { attempts: history, supports } = await loadStudentHistories(profile.id, attempt.course_id);
    let adaptation;
    try {
      adaptation = planReinforcement(profile, attempt, history, supports);
    } catch (err) {
      throw new HttpError(422, err?.message || "No se pudo planificar el refuerzo.");
    }
    if (!attempt.items.some((i) => i.id === adaptation.target_item_id)) {
      throw new HttpError(422, "El apoyo debe partir de una pregunta de este intento.");
    }

    const id = uuid4();
    value = {
      id,
      attempt_id: aid,
      parent_id: null,
      round_number: 1,
      student_id: profile.id,
      unit_id: attempt.unit_id,
      course_id: attempt.course_id,
      created_at: nowIso(),
      adaptation,
      status: "generating",
      error: null,
      target_item_ids: [adaptation.target_item_id],
      topic: adaptation.topic,
      explanation: "",
      example: "",
      citation: null,
      private_exercise: null,
      matching: [],
      response: null,
      model: {},
      generation_token: uuid4(),
      _gen_progress: null,
      _lease_until: 0,
    };

    const allReinfIds = (await db.getJson("col:reinforcement_ids", [])) || [];
    allReinfIds.push(id);
    existingIds.push(id);
    await Promise.all([
      db.setJson(`reinf:${id}`, value),
      db.setJson(`attempt_reinfs:${aid}`, existingIds),
      db.setJson("col:reinforcement_ids", allReinfIds),
    ]);
  }

  if (useSource) {
    try {
      value = await completeSourceReview(value.id, {
        reason: sourceReason,
        generationToken: value.generation_token,
      });
    } catch (err) {
      value.status = "failed";
      value.error = String(err?.message || err).slice(0, 1000);
      await db.setJson(`reinf:${value.id}`, value);
    }
  } else {
    // Avanza primera etapa (<= 4.5s) para devolver rápido HTTP 202
    value = await advanceReinforcementGeneration(value.id, { budgetMs: 4500 });
  }
  return publicReinforcement(value);
}

export async function listReinforcementRounds(attemptId, studentIdParam = null) {
  const aid = requireUuid(attemptId, "attempt_id");
  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  await getAttemptOr404(aid, scope);
  const db = getDb();
  const ids = (await db.getJson(`attempt_reinfs:${aid}`, [])) || [];
  const list = await Promise.all(ids.map((id) => getReinforcementOr404(id, scope)));
  return list.map(publicReinforcement);
}

export async function nextReinforcement(reinforcementId, studentIdParam = null) {
  const rid = requireUuid(reinforcementId, "reinforcement_id");
  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const parent = await getReinforcementOr404(rid, scope);
  await ensureOwner(parent.student_id, scope, { write: true });
  if (parent.status !== "ready" || (!parent.response && parent.activity_kind !== "source_review")) {
    throw new HttpError(409, "Completa este ejercicio antes de preparar un caso nuevo.");
  }

  const db = getDb();
  const attemptIds = (await db.getJson(`attempt_reinfs:${parent.attempt_id}`, [])) || [];
  const allRounds = (await Promise.all(attemptIds.map((id) => db.getJson(`reinf:${id}`)))).filter(Boolean);
  const existingChild = allRounds.find((r) => r.parent_id === rid);

  let value;
  if (existingChild) {
    value = existingChild;
    if (value.status !== "failed" || value.response) {
      return publicReinforcement(value);
    }
    restartReinforcementGeneration(value);
    await db.setJson(`reinf:${value.id}`, value);
  } else {
    const attempt = await getAttemptOr404(parent.attempt_id, scope);
    const profile = await requireEnrollment(parent.student_id, attempt.course_id);
    const { attempts: history, supports } = await loadStudentHistories(profile.id, attempt.course_id);
    const targets = parent.target_item_ids || [];
    if (targets.length !== 1) {
      throw new HttpError(422, "El caso nuevo necesita una pregunta de origen identificada.");
    }
    const adaptation = planReinforcement(profile, attempt, history, supports, { targetItemId: targets[0] });
    if (parent.response) {
      adaptation.latest_response = {
        reinforcement_id: parent.id,
        question: parent.private_exercise?.question || "",
        response: parent.response.response || "",
        correct: parent.response.correct,
        used_help: parent.response.used_help,
        activity_kind: parent.activity_kind || "generated_case",
      };
    }

    const id = uuid4();
    value = {
      id,
      attempt_id: attempt.id,
      parent_id: parent.id,
      round_number: (parent.round_number || 1) + 1,
      student_id: profile.id,
      unit_id: attempt.unit_id,
      course_id: attempt.course_id,
      created_at: nowIso(),
      adaptation,
      status: "generating",
      error: null,
      target_item_ids: [...targets],
      topic: adaptation.topic,
      explanation: "",
      example: "",
      citation: null,
      private_exercise: null,
      matching: [],
      response: null,
      model: {},
      generation_token: uuid4(),
      _gen_progress: null,
      _lease_until: 0,
    };

    const allReinfIds = (await db.getJson("col:reinforcement_ids", [])) || [];
    allReinfIds.push(id);
    attemptIds.push(id);
    await Promise.all([
      db.setJson(`reinf:${id}`, value),
      db.setJson(`attempt_reinfs:${attempt.id}`, attemptIds),
      db.setJson("col:reinforcement_ids", allReinfIds),
    ]);
  }

  value = await advanceReinforcementGeneration(value.id, { budgetMs: 4500 });
  return publicReinforcement(value);
}

export async function getReinforcementFailedTopics(reinforcementId, studentIdParam = null) {
  const rid = requireUuid(reinforcementId, "reinforcement_id");
  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const value = await getReinforcementOr404(rid, scope);
  const attempt = await getAttemptOr404(value.attempt_id, scope);
  const unit = await getUnitOr404(attempt.unit_id);
  const items = attempt.items || [];
  const failed = [];
  for (const item of items) {
    if (item.correct === false) {
      failed.push({
        id: item.id,
        topic: item.topic || "Tema de la unidad",
        question: item.question || "",
        type: item.type || "multiple_choice",
        options: Array.isArray(item.options) ? [...item.options] : [],
        correct_index: item.correct_index ?? null,
        student_response: item.response || "",
        correct_answer: item.answer || "",
        explanation: item.explanation || "",
        citation: item.citation || null,
      });
    }
  }
  const correctCount = items.filter((i) => i.correct === true).length;
  return {
    reinforcement_id: value.id,
    attempt_id: attempt.id,
    unit_id: attempt.unit_id,
    unit_title: unit.title || "",
    total_items: items.length,
    correct_count: correctCount,
    failed_count: failed.length,
    failed_items: failed,
  };
}

export async function getReinforcement(reinforcementId, studentIdParam = null) {
  const rid = requireUuid(reinforcementId, "reinforcement_id");
  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  let value = await getReinforcementOr404(rid, scope);
  if (value.status === "generating" && !value.response) {
    value = await advanceReinforcementGeneration(rid, { budgetMs: REINF_STEP_BUDGET_MS });
  }
  return publicReinforcement(value);
}

export async function submitReinforcement(reinforcementId, body, studentIdParam = null) {
  const rid = requireUuid(reinforcementId, "reinforcement_id");
  const requestId = requireUuid(body?.request_id, "request_id");
  const selectedIndex = body?.selected_index === undefined ? null : body.selected_index;
  const rawResponse = typeof body?.response === "string" ? body.response.slice(0, 5000) : "";
  const usedHelp = typeof body?.used_help === "boolean" ? body.used_help : false;

  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const value = await getReinforcementOr404(rid, scope);
  await ensureOwner(value.student_id, scope, { write: true });

  const responseKey = uuid5(value.student_id, requestId);
  const submission = stableStringify({
    request_id: requestId,
    selected_index: selectedIndex,
    response: rawResponse,
    used_help: usedHelp,
  });

  const db = getDb();
  if (value._response_request_id) {
    if (value._response_request_id !== responseKey || value._response_input !== submission) {
      throw new HttpError(
        409,
        "El intento de este ejercicio ya está guardado. Puedes revisarlo en el historial."
      );
    }
    return publicReinforcement(value);
  }

  const usedKeyOwner = await db.getJson(`reinf_req:${responseKey}`);
  if (usedKeyOwner && usedKeyOwner !== rid) {
    throw new HttpError(409, "Este identificador de envío ya pertenece a otro ejercicio.");
  }

  if (value.status !== "ready" || !value.private_exercise) {
    throw new HttpError(409, "Espera a que el ejercicio termine de generarse.");
  }

  const exercise = value.private_exercise;
  let correct;
  let response;
  if (exercise.type === "multiple_choice") {
    if (
      typeof selectedIndex !== "number" ||
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= exercise.options.length
    ) {
      throw new HttpError(422, "Elige una alternativa antes de enviar.");
    }
    correct = selectedIndex === exercise.correct_index;
    response = exercise.options[selectedIndex];
  } else {
    if (selectedIndex !== null || !rawResponse.trim()) {
      throw new HttpError(422, "Escribe una respuesta antes de enviar.");
    }
    correct = null;
    response = rawResponse.trim();
  }

  value.response = {
    selected_index: selectedIndex,
    response,
    correct,
    reference: exercise.answer,
    explanation: exercise.explanation,
    created_at: nowIso(),
    used_help: usedHelp,
    activity_kind: value.activity_kind || "generated_case",
  };
  value._response_request_id = responseKey;
  value._response_input = submission;

  await Promise.all([
    db.setJson(`reinf:${rid}`, value),
    db.setJson(`reinf_req:${responseKey}`, rid),
  ]);
  return publicReinforcement(value);
}

export async function generatePracticeDrill(reinforcementId, body, studentIdParam = null) {
  const rid = requireUuid(reinforcementId, "reinforcement_id");
  const count = body?.count !== undefined ? requireInt(body, "count", { min: 1, max: 20 }) : 10;
  const questionType = body?.question_type || "multiple_choice";
  if (!["multiple_choice", "open", "mixed"].includes(questionType)) {
    throw new HttpError(422, "Formato de pregunta inválido.");
  }

  const scope = studentIdParam ? requireUuid(studentIdParam, "student_id") : null;
  const value = await getReinforcementOr404(rid, scope);
  await ensureOwner(value.student_id, scope);

  const existing = value.practice_drill;
  if (
    existing &&
    existing.question_type === questionType &&
    Array.isArray(existing.items) &&
    existing.items.length >= count
  ) {
    return existing;
  }

  const db = getDb();
  const materials = ((await db.getJson("col:materials", [])) || [])
    .filter((m) => m.unit_id === value.unit_id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const materialIds = materials.map((m) => m.id);
  if (!materialIds.length) {
    throw new HttpError(422, "La unidad no tiene materiales disponibles para ampliar el refuerzo.");
  }

  const unit = await getUnitOr404(value.unit_id);
  const attempt = await getAttemptOr404(value.attempt_id, scope);
  const failedItems = (attempt.items || []).filter((it) => it.correct === false);
  const failedTopics = Array.from(new Set(failedItems.map((it) => it.topic).filter(Boolean))).join(", ");
  const drillObjective = failedTopics || value.topic || unit.objectives || "";
  let pages;
  try {
    pages = await candidatePages({ objective: drillObjective, material_ids: materialIds });
  } catch (err) {
    throw new HttpError(422, err?.message || "No hay páginas suficientes.");
  }

  const failedPageKeys = new Set(
    failedItems.filter((it) => it.citation).map((it) => `${it.citation.material_id}|${it.citation.page_number}`)
  );
  if (failedPageKeys.size) {
    pages = pages
      .filter((p) => failedPageKeys.has(`${p.material_id}|${p.number}`))
      .concat(pages.filter((p) => !failedPageKeys.has(`${p.material_id}|${p.number}`)));
  }

  const engine = getEngine();
  const sameType = existing && existing.question_type === questionType;
  const items = sameType ? [...(existing.items || [])] : [];
  const usedPages = new Set(
    items.filter((it) => it.citation).map((it) => `${it.citation.material_id}|${it.citation.page_number}`)
  );

  const stride = Math.max(1, Math.floor(pages.length / Math.max(count, 1)));
  const deadline = Date.now() + DRILL_STEP_BUDGET_MS;
  let pageCursor = 0;

  while (items.length < count && Date.now() < deadline && pageCursor < 4) {
    const remaining = count - items.length;
    const waveSize = Math.min(6, remaining);
    const indexes = [];
    for (let k = 0; k < waveSize; k++) indexes.push(items.length + k);
    const jobs = planParallelJobs(
      pages,
      indexes,
      stride,
      pageCursor,
      usedPages,
      (i) => (questionType === "mixed" ? (i % 3 === 2 ? "open" : "multiple_choice") : questionType),
      value.topic || unit.objectives || "",
      items.map((it) => it.question),
      items.map((it) => it.answer).filter(Boolean)
    );
    const results = await runParallelJobs(engine, jobs, deadline);
    let added = 0;
    for (let k = 0; k < jobs.length; k++) {
      const res = results[k];
      if (!res.item) continue;
      const cand = { ...res.item, id: uuid4(), reviewed: true };
      try {
        const validated = await validateCourseItem(cand, value.unit_id, materialIds, { generated: true });
        if (items.some((old) => contentKey(old.question) === contentKey(validated.question))) continue;
        items.push(validated);
        if (validated.citation) usedPages.add(`${validated.citation.material_id}|${validated.citation.page_number}`);
        added++;
      } catch {
        continue;
      }
    }
    if (added === 0) pageCursor++;
  }

  // Si aún faltan preguntas y queda poco presupuesto, indicamos partial:true si se alcanzó el tiempo
  // o completamos con preguntas publicadas verificadas de la unidad.
  const timedOutBeforeTarget = items.length < count && Date.now() >= deadline;
  if (!timedOutBeforeTarget && items.length < count) {
    const unitQuizIds = (await db.getJson(`unit_quizzes:${value.unit_id}`, [])) || [];
    for (const qid of [...unitQuizIds].reverse()) {
      if (items.length >= count) break;
      const pub = await db.getJson(`pub_latest:${qid}`);
      if (!pub) continue;
      for (const qItem of pub.items || []) {
        if (items.length >= count) break;
        if (questionType !== "mixed" && qItem.type !== questionType) continue;
        if (items.some((old) => contentKey(old.question) === contentKey(qItem.question || ""))) continue;
        items.push({ ...qItem, id: uuid4(), reviewed: true });
      }
    }
  }

  if (!items.length && !timedOutBeforeTarget) {
    throw new HttpError(502, "No se pudieron generar preguntas de práctica para este refuerzo.");
  }

  const drill = {
    topic: value.topic || "Refuerzo",
    question_type: questionType,
    requested_count: count,
    items,
    partial: timedOutBeforeTarget,
    created_at: nowIso(),
  };

  value.practice_drill = drill;
  await db.setJson(`reinf:${rid}`, value);
  return drill;
}

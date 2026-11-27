/**
 * Endpoints legados de fuentes sueltas, preguntas versionadas, práctica rápida y apoyos
 * (port 1:1 de las rutas /api/sources, /api/questions, /api/practice y /api/attempts de main.py).
 */

import { getEngine } from "./cloud-engines.mjs";
import {
  HttpError,
  nowIso,
  requireInt,
  requireString,
  requireUuid,
  uuid4,
} from "./http-utils.mjs";
import { LEGACY_MAX_CONTEXT, LEGACY_MAX_PDF_BYTES, extractLegacySourcePdf } from "./material-import.mjs";
import { getDb } from "./storage.mjs";

const FRAGMENT_CHARS = 2400;

function extractFragment(context, answer, start) {
  const end = start + answer.length;
  if (!answer.trim() || end > context.length || context.slice(start, end) !== answer) {
    throw new HttpError(422, "La respuesta objetivo debe coincidir con el texto seleccionado en la fuente.");
  }
  let left = Math.max(0, start - Math.floor((FRAGMENT_CHARS - answer.length) / 2));
  const right = Math.min(context.length, left + FRAGMENT_CHARS);
  left = Math.max(0, right - FRAGMENT_CHARS);
  return { fragment: context.slice(left, right), start: start - left };
}

function buildReviewPayload(q, source) {
  const latest = q.versions[q.versions.length - 1];
  const approved = (q.approvals || []).some((a) => a.version === latest.version);
  return {
    id: q.id,
    version: latest.version,
    question: latest.question,
    answer: q.answer,
    fragment: q.fragment,
    source_id: q.source_id,
    title: source.title,
    objective: source.objective,
    approved,
    model: q.model,
  };
}

export async function createSource(body) {
  const title = requireString(body, "title", { min: 1, max: 160 });
  const objective = requireString(body, "objective", { min: 1, max: 300 });
  const context = requireString(body, "context", { min: 1, max: LEGACY_MAX_CONTEXT, strip: false });
  if (!context.trim()) throw new HttpError(422, "La fuente debe contener texto.");

  const db = getDb();
  const sources = (await db.getJson("col:legacy_sources", [])) || [];
  const item = { id: uuid4(), title, objective, context };
  sources.push(item);
  await db.setJson("col:legacy_sources", sources);
  return item;
}

export async function extractSourcePdf(req) {
  let form;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(422, "Envía el PDF en el campo 'file'.");
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new HttpError(422, "Falta el archivo PDF.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LEGACY_MAX_PDF_BYTES) {
    throw new HttpError(413, "El PDF supera el límite de 8 MB.");
  }
  return { context: await extractLegacySourcePdf(bytes) };
}

export async function getSource(sourceId) {
  const sid = requireUuid(sourceId, "source_id");
  const sources = (await getDb().getJson("col:legacy_sources", [])) || [];
  const found = sources.find((s) => s.id === sid);
  if (!found) throw new HttpError(404, "Material no encontrado. Vuelve a la lista de prácticas.");
  return found;
}

export async function createLegacyQuestion(body) {
  const sourceId = requireUuid(body?.source_id, "source_id");
  const answer = requireString(body, "answer", { min: 1, max: 1200, strip: false });
  const answerStart = requireInt(body, "answer_start", { min: 0 });
  const source = await getSource(sourceId);
  const { fragment, start } = extractFragment(source.context, answer, answerStart);

  const engine = getEngine();
  let question;
  try {
    question = (await engine.generate(fragment, answer, { answerStart: start })).trim();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "El motor no pudo generar la pregunta. Vuelve a intentarlo.");
  }
  if (!question) {
    throw new HttpError(502, "El motor devolvió una pregunta vacía. Prueba con otro fragmento.");
  }

  const db = getDb();
  const questions = (await db.getJson("col:legacy_questions", [])) || [];
  const rec = {
    id: uuid4(),
    source_id: sourceId,
    answer,
    answer_start: answerStart,
    fragment,
    model: engine.status(),
    versions: [{ version: 1, question }],
    approvals: [],
  };
  questions.push(rec);
  await db.setJson("col:legacy_questions", questions);
  return buildReviewPayload(rec, source);
}

export async function listLegacyReviews() {
  const db = getDb();
  const [sources, questions] = await Promise.all([
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);
  const srcById = new Map(sources.map((s) => [s.id, s]));
  return [...questions]
    .reverse()
    .filter((q) => srcById.has(q.source_id))
    .map((q) => buildReviewPayload(q, srcById.get(q.source_id)));
}

export async function getLegacyReview(questionId) {
  const qid = requireUuid(questionId, "question_id");
  const db = getDb();
  const [sources, questions] = await Promise.all([
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);
  const q = questions.find((x) => x.id === qid);
  if (!q) throw new HttpError(404, "Pregunta no encontrada.");
  const src = sources.find((s) => s.id === q.source_id);
  if (!src) throw new HttpError(404, "Pregunta no encontrada.");
  return buildReviewPayload(q, src);
}

export async function editLegacyQuestion(questionId, body) {
  const qid = requireUuid(questionId, "question_id");
  const version = requireInt(body, "version", { min: 1 });
  const question = requireString(body, "question", { min: 1, max: 700 });
  const db = getDb();
  const [sources, questions] = await Promise.all([
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);
  const idx = questions.findIndex((x) => x.id === qid);
  if (idx < 0) throw new HttpError(404, "Pregunta no encontrada.");
  const q = questions[idx];
  const latest = q.versions[q.versions.length - 1];
  if (version !== latest.version) {
    throw new HttpError(409, "La pregunta cambió. Abre su versión más reciente.");
  }
  q.versions.push({ version: version + 1, question });
  await db.setJson("col:legacy_questions", questions);
  const src = sources.find((s) => s.id === q.source_id);
  return buildReviewPayload(q, src);
}

export async function approveLegacyQuestion(questionId, body) {
  const qid = requireUuid(questionId, "question_id");
  const version = requireInt(body, "version", { min: 1 });
  const db = getDb();
  const [sources, questions] = await Promise.all([
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);
  const idx = questions.findIndex((x) => x.id === qid);
  if (idx < 0) throw new HttpError(404, "Pregunta no encontrada.");
  const q = questions[idx];
  const latest = q.versions[q.versions.length - 1];
  if (version !== latest.version) {
    throw new HttpError(409, "Solo se puede aprobar la versión más reciente de la pregunta.");
  }
  if (!q.approvals.some((a) => a.version === version)) {
    q.approvals.push({ version, approved_at: nowIso() });
    await db.setJson("col:legacy_questions", questions);
  }
  const src = sources.find((s) => s.id === q.source_id);
  return buildReviewPayload(q, src);
}

export async function listLegacyPractice() {
  const db = getDb();
  const [sources, questions] = await Promise.all([
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const out = [];
  for (const q of [...questions].reverse()) {
    if (!q.approvals?.length) continue;
    const maxV = Math.max(...q.approvals.map((a) => a.version));
    const ver = q.versions.find((v) => v.version === maxV);
    const src = srcById.get(q.source_id);
    if (ver && src) {
      out.push({ id: q.id, version: ver.version, question: ver.question, title: src.title, objective: src.objective });
    }
  }
  return out;
}

export async function getLegacyPractice(questionId) {
  const qid = requireUuid(questionId, "question_id");
  const list = await listLegacyPractice();
  const found = list.find((p) => p.id === qid);
  if (!found) throw new HttpError(404, "Práctica aprobada no encontrada.");
  return found;
}

export async function createLegacyAttempt(questionId, body) {
  const qid = requireUuid(questionId, "question_id");
  const version = requireInt(body, "version", { min: 1 });
  const response = requireString(body, "response", { min: 1, max: 3000 });
  const attemptId = body?.request_id ? requireUuid(body.request_id, "request_id") : uuid4();

  const db = getDb();
  const [questions, attempts] = await Promise.all([
    db.getJson("col:legacy_questions", []),
    db.getJson("col:legacy_attempts", []),
  ]);
  const q = questions.find((x) => x.id === qid);
  if (!q || !q.approvals.some((a) => a.version === version)) {
    throw new HttpError(404, "Práctica aprobada no encontrada.");
  }
  const ver = q.versions.find((v) => v.version === version);
  const existing = attempts.find((a) => a.id === attemptId);
  if (existing) {
    if (existing.question_id !== qid || existing.version !== version || existing.response !== response) {
      throw new HttpError(409, "El identificador del intento ya está en uso.");
    }
    return {
      id: existing.id,
      question_id: existing.question_id,
      version: existing.version,
      response: existing.response,
      reference: q.answer,
    };
  }
  attempts.push({
    id: attemptId,
    question_id: qid,
    version,
    response,
    reference: q.answer,
    fragment: q.fragment,
    question: ver.question,
    submitted_at: nowIso(),
  });
  await db.setJson("col:legacy_attempts", attempts);
  return { id: attemptId, question_id: qid, version, response, reference: q.answer };
}

export async function legacyGuidance(attemptId, kind) {
  const aid = requireUuid(attemptId, "attempt_id");
  const db = getDb();
  const [attempts, guidances] = await Promise.all([
    db.getJson("col:legacy_attempts", []),
    db.getJson("col:legacy_guidance", []),
  ]);
  const attempt = attempts.find((a) => a.id === aid);
  if (!attempt) throw new HttpError(404, "Intento no encontrado.");

  const cached = guidances.find((g) => g.attempt_id === aid && g.kind === kind);
  const engine = getEngine();
  if (cached) {
    const expectedPrompt = kind === "reinforcement" ? engine.reinforcement_prompt_version : null;
    if (!expectedPrompt || cached.model?.prompt_version === expectedPrompt) {
      return { attempt_id: aid, text: cached.text, model: cached.model, reused: true };
    }
  }

  let text;
  try {
    text = (
      await engine.guidance(attempt.fragment, attempt.question, attempt.reference, attempt.response, {
        practice: kind === "reinforcement",
      })
    ).trim();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "El motor no pudo generar el apoyo. Tu intento quedó guardado.");
  }
  if (!text) {
    throw new HttpError(502, "El motor devolvió un apoyo vacío. Tu intento quedó guardado.");
  }

  const modelIdentity = {
    ...engine.status(),
    adapter_active: false,
    adapter_version: null,
    profile: null,
  };
  if (kind === "reinforcement" && engine.reinforcement_prompt_version) {
    modelIdentity.prompt_version = engine.reinforcement_prompt_version;
  }

  const next = guidances.filter((g) => !(g.attempt_id === aid && g.kind === kind));
  next.push({ attempt_id: aid, kind, text, model: modelIdentity });
  await db.setJson("col:legacy_guidance", next);
  return { attempt_id: aid, text, model: modelIdentity, reused: false };
}

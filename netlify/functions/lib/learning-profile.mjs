/**
 * Adaptación transparente basada en evidencia individual del estudiante.
 * Port 1:1 exacto de apps/api/learning_profile.py (POLICY_VERSION = "individual-evidence-v2").
 */

import { sha256Hex } from "./http-utils.mjs";
import { normalized } from "./native-core.mjs";

export const POLICY_VERSION = "individual-evidence-v2";

function keyOf(value) {
  return normalized(String(value || ""));
}

function parseTime(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function ownedRecords(profile, attempts, reinforcements) {
  const studentId = String(profile?.id || "");
  if (!studentId) {
    throw new Error("Se necesita un perfil de estudiante para consultar su evidencia.");
  }
  const byId = new Map();
  for (const a of attempts || []) {
    if (a?.id && a.student_id === studentId) {
      byId.set(String(a.id), a);
    }
  }
  const ordered = Array.from(byId.values()).sort((a, b) => {
    const dt = parseTime(a.created_at) - parseTime(b.created_at);
    return dt !== 0 ? dt : String(a.id).localeCompare(String(b.id));
  });

  const supportsMap = new Map();
  for (const r of reinforcements || []) {
    if (r?.id && r.student_id === studentId && byId.has(String(r.attempt_id))) {
      supportsMap.set(String(r.id), r);
    }
  }
  const supports = Array.from(supportsMap.values()).sort((a, b) => {
    const ta = parseTime(a.response?.created_at || a.created_at);
    const tb = parseTime(b.response?.created_at || b.created_at);
    const dt = ta - tb;
    return dt !== 0 ? dt : String(a.id).localeCompare(String(b.id));
  });
  return { ownedAttempts: ordered, supports };
}

function topicKeyStr(unitId, item) {
  return `${String(unitId || "")}|${keyOf(item?.topic || "Contenido de la unidad")}`;
}

function computeStrategy(events) {
  const scored = events.filter((e) => typeof e.correct === "boolean");
  if (!scored.length) {
    return {
      strategy: "check",
      status: "unscored",
      rationale:
        "Las respuestas abiertas están registradas sin puntuación automática. Un caso adicional permitirá comparar las ideas con la referencia.",
      unresolved: 0,
    };
  }

  let lastIndependent = -1;
  for (const e of scored) {
    if (e.kind === "reinforcement" && e.activity_kind !== "source_review" && e.correct && e.used_help === false) {
      if (e.time > lastIndependent) lastIndependent = e.time;
    }
  }

  const unresolved = scored.filter((e) => !e.correct && e.time > lastIndependent);
  const wrongAttempts = new Set(unresolved.filter((e) => e.kind === "practice").map((e) => e.attempt_id));
  const last = scored[scored.length - 1];
  const recent = scored.filter((e) => e.activity_kind !== "source_review").slice(-3);
  const recentClean = recent.length >= 2 && recent.every((e) => e.correct && e.used_help !== true);

  if (last.activity_kind === "source_review" && last.correct) {
    return {
      strategy: "check",
      status: "checking",
      rationale:
        "Completaste correctamente el repaso de una pregunta ya vista. Falta comprobar la idea en otra situación; los errores anteriores siguen como referencia.",
      unresolved: unresolved.length,
    };
  }
  if (last.kind === "reinforcement" && last.correct && last.used_help === false) {
    return {
      strategy: "transfer",
      status: "progressing",
      rationale:
        "La última comprobación fue correcta sin volver a consultar el apoyo. Proponemos otra situación para comprobar si puedes aplicar la misma idea.",
      unresolved: unresolved.length,
    };
  }
  if (last.correct && recentClean) {
    return {
      strategy: "transfer",
      status: "progressing",
      rationale:
        "Hay respuestas correctas recientes en este tema. Cambiaremos el contexto para seguir comprobando la aplicación de la idea; esto no declara dominio completo.",
      unresolved: unresolved.length,
    };
  }
  if (!last.correct && (wrongAttempts.size >= 2 || last.kind === "reinforcement")) {
    return {
      strategy: "guided",
      status: "needs_support",
      rationale:
        "El error vuelve a aparecer en intentos de este tema o en la comprobación posterior. Empezaremos con pasos breves y una comparación con la referencia revisada.",
      unresolved: unresolved.length,
    };
  }
  if (last.kind === "reinforcement" && last.correct && last.used_help === true) {
    return {
      strategy: "check",
      status: "checking",
      rationale:
        "La respuesta posterior fue correcta con apoyo. Ahora conviene comprobar la misma idea en otro caso y registrar si necesitas consultar la ayuda.",
      unresolved: unresolved.length,
    };
  }
  if (last.kind === "reinforcement" && last.correct && last.used_help === null) {
    return {
      strategy: "check",
      status: "checking",
      rationale:
        "La respuesta posterior fue correcta, pero no se registró el uso de ayuda. Necesitamos otra comprobación antes de cambiar el apoyo.",
      unresolved: unresolved.length,
    };
  }
  if (!last.correct) {
    return {
      strategy: "check",
      status: "checking",
      rationale:
        "Tenemos un error observado y todavía poca evidencia para explicar su causa. Revisaremos un ejemplo y haremos una pregunta adicional, sin atribuir un diagnóstico.",
      unresolved: unresolved.length,
    };
  }
  return {
    strategy: "check",
    status: "checking",
    rationale:
      "Una respuesta correcta aporta evidencia inicial. Otro caso ayudará a comprobar la aplicación de esta idea sin dar por dominado el tema.",
    unresolved: unresolved.length,
  };
}

export function summarizeProgress(profile, attempts, reinforcements) {
  const { ownedAttempts, supports } = ownedRecords(profile, attempts, reinforcements);
  const groups = new Map();
  const itemGroups = new Map();
  const attemptsById = new Map();
  const timeline = [];

  for (const attempt of ownedAttempts) {
    const aid = String(attempt.id);
    attemptsById.set(aid, attempt);
    let correct = 0;
    let graded = 0;
    let openCount = 0;

    for (const item of attempt.items || []) {
      const tk = topicKeyStr(attempt.unit_id, item);
      let group = groups.get(tk);
      if (!group) {
        group = {
          key: tk,
          unit_id: String(attempt.unit_id || ""),
          topic: item.topic || "Contenido de la unidad",
          objectives: [],
          attempt_ids: new Set(),
          events: [],
          support_ids: new Set(),
          correct_count: 0,
          incorrect_count: 0,
          open_count: 0,
          independently_correct_support_count: 0,
          assisted_correct_support_count: 0,
          completed_source_review_count: 0,
          correct_source_review_count: 0,
        };
        groups.set(tk, group);
      }
      group.attempt_ids.add(aid);
      const objective = String(item.objective || "").trim();
      if (objective && !group.objectives.includes(objective)) {
        group.objectives.push(objective);
      }
      itemGroups.set(`${aid}|${String(item.id)}`, tk);

      const outcome = item.type === "multiple_choice" && typeof item.correct === "boolean" ? item.correct : null;
      if (outcome === null) {
        group.open_count += 1;
        openCount += 1;
      } else {
        if (outcome) {
          group.correct_count += 1;
          correct += 1;
        } else {
          group.incorrect_count += 1;
        }
        graded += 1;
      }
      group.events.push({
        kind: "practice",
        time: parseTime(attempt.created_at),
        created_at: attempt.created_at,
        attempt_id: aid,
        correct: outcome,
      });
    }

    timeline.push({
      id: aid,
      type: "practice",
      attempt_id: aid,
      unit_id: attempt.unit_id,
      title: attempt.quiz_title || "Práctica",
      created_at: attempt.created_at,
      correct_count: correct,
      graded_count: graded,
      open_count: openCount,
    });
  }

  let completed = 0;
  let independent = 0;
  let assisted = 0;
  let completedReviews = 0;
  let correctReviews = 0;

  for (const support of supports) {
    const attemptId = String(support.attempt_id);
    const targetKeys = new Set();
    for (const target of support.target_item_ids || []) {
      const k = itemGroups.get(`${attemptId}|${String(target)}`);
      if (k) targetKeys.add(k);
    }
    const response = support.response || null;
    const activityKind = support.activity_kind || "generated_case";
    const isReview = activityKind === "source_review";

    for (const tk of targetKeys) {
      const group = groups.get(tk);
      group.support_ids.add(String(support.id));
      if (response) {
        const outcome = typeof response.correct === "boolean" ? response.correct : null;
        const usedHelp = typeof response.used_help === "boolean" ? response.used_help : null;
        if (outcome === true && usedHelp === false && !isReview) group.independently_correct_support_count += 1;
        if (outcome === true && usedHelp === true && !isReview) group.assisted_correct_support_count += 1;
        if (isReview) group.completed_source_review_count += 1;
        if (isReview && outcome === true) group.correct_source_review_count += 1;
        group.events.push({
          kind: "reinforcement",
          activity_kind: activityKind,
          time: parseTime(response.created_at),
          created_at: response.created_at,
          attempt_id: attemptId,
          correct: outcome,
          used_help: usedHelp,
        });
      }
    }

    if (response) {
      completed += 1;
      if (isReview) completedReviews += 1;
      if (isReview && response.correct === true) correctReviews += 1;
      const outcome = typeof response.correct === "boolean" ? response.correct : null;
      const usedHelp = typeof response.used_help === "boolean" ? response.used_help : null;
      if (outcome === true && usedHelp === false && !isReview) independent += 1;
      if (outcome === true && usedHelp === true && !isReview) assisted += 1;
      timeline.push({
        id: String(support.id),
        type: "reinforcement",
        attempt_id: attemptId,
        reinforcement_id: String(support.id),
        unit_id: attemptsById.get(attemptId)?.unit_id || null,
        topic: support.topic,
        title: isReview ? "Repaso del material" : "Comprobación de refuerzo",
        activity_kind: activityKind,
        created_at: response.created_at,
        correct: outcome,
        used_help: usedHelp,
      });
    }
  }

  const labels = {
    needs_support: "Conviene reforzar",
    checking: "Por comprobar",
    progressing: "Avance observado",
    unscored: "Por contrastar",
  };

  const topics = [];
  for (const [tk, group] of groups.entries()) {
    const events = [...group.events].sort((a, b) => {
      const dt = a.time - b.time;
      if (dt !== 0) return dt;
      return (a.kind === "reinforcement" ? 1 : 0) - (b.kind === "reinforcement" ? 1 : 0);
    });
    const { strategy, status, rationale, unresolved } = computeStrategy(events);
    const practiceEvents = events.filter((e) => e.kind === "practice");
    topics.push({
      id: sha256Hex(tk).slice(0, 20),
      unit_id: group.unit_id,
      topic: group.topic,
      objectives: group.objectives,
      attempt_count: group.attempt_ids.size,
      correct_count: group.correct_count,
      incorrect_count: group.incorrect_count,
      graded_count: group.correct_count + group.incorrect_count,
      open_count: group.open_count,
      support_count: group.support_ids.size,
      independently_correct_support_count: group.independently_correct_support_count,
      assisted_correct_support_count: group.assisted_correct_support_count,
      completed_source_review_count: group.completed_source_review_count,
      correct_source_review_count: group.correct_source_review_count,
      unresolved_error_count: unresolved,
      status,
      status_label: labels[status],
      rationale,
      last_activity_at: events[events.length - 1].created_at,
      last_attempt_id: practiceEvents[practiceEvents.length - 1].attempt_id,
      recommended_strategy: strategy,
    });
  }

  const priorities = { needs_support: 0, checking: 1, unscored: 2, progressing: 3 };
  topics.sort((a, b) => {
    const dp = priorities[a.status] - priorities[b.status];
    if (dp !== 0) return dp;
    const du = b.unresolved_error_count - a.unresolved_error_count;
    if (du !== 0) return du;
    const dt = parseTime(b.last_activity_at) - parseTime(a.last_activity_at);
    if (dt !== 0) return dt;
    return String(a.topic).localeCompare(String(b.topic));
  });

  timeline.sort((a, b) => {
    const dt = parseTime(b.created_at) - parseTime(a.created_at);
    if (dt !== 0) return dt;
    const dr = (b.type === "reinforcement" ? 1 : 0) - (a.type === "reinforcement" ? 1 : 0);
    if (dr !== 0) return dr;
    return String(b.id).localeCompare(String(a.id));
  });

  const objectivesMap = new Map();
  for (const topic of topics) {
    for (const objective of topic.objectives) {
      const ok = `${topic.unit_id}|${objective}`;
      let entry = objectivesMap.get(ok);
      if (!entry) {
        entry = { objective, unit_id: topic.unit_id, topic_ids: [] };
        objectivesMap.set(ok, entry);
      }
      entry.topic_ids.push(topic.id);
    }
  }

  const summary = {
    attempt_count: ownedAttempts.length,
    correct_count: topics.reduce((s, t) => s + t.correct_count, 0),
    graded_count: topics.reduce((s, t) => s + t.graded_count, 0),
    open_count: topics.reduce((s, t) => s + t.open_count, 0),
    support_count: supports.length,
    completed_support_count: completed,
    independently_correct_support_count: independent,
    assisted_correct_support_count: assisted,
    completed_source_review_count: completedReviews,
    correct_source_review_count: correctReviews,
    last_activity_at: timeline.length ? timeline[0].created_at : null,
  };

  let recommendation = null;
  if (topics.length) {
    const top = topics[0];
    const latestAttempt = attemptsById.get(top.last_attempt_id);
    const matchingSupports = supports.filter((r) => String(r.attempt_id) === top.last_attempt_id);
    let latestSupport = null;
    for (const r of matchingSupports) {
      if (!latestSupport) {
        latestSupport = r;
      } else {
        const ra = Number(r.round_number || 1);
        const la = Number(latestSupport.round_number || 1);
        if (ra > la || (ra === la && parseTime(r.created_at) > parseTime(latestSupport.created_at))) {
          latestSupport = r;
        }
      }
    }
    const completedCheck = Boolean(latestSupport && latestSupport.response);
    const stratLabels = {
      guided: "Repasar con pasos breves",
      check: "Comprobar con otro caso",
      transfer: "Aplicar en una nueva situación",
    };
    recommendation = {
      attempt_id: top.last_attempt_id,
      reinforcement_id: latestSupport ? latestSupport.id : null,
      quiz_id: latestAttempt?.quiz_id || null,
      action: completedCheck ? "practice" : "reinforcement",
      topic: top.topic,
      strategy: top.recommended_strategy,
      label: completedCheck ? "Hacer otra práctica" : stratLabels[top.recommended_strategy],
      rationale: top.rationale,
    };
  }

  return {
    summary,
    topics,
    timeline,
    objectives: Array.from(objectivesMap.values()),
    recommendation,
  };
}

function caseText(value) {
  return String(value || "")
    .replace(/^(?:Caso|Ejemplo) hipotético:\s*/, "")
    .split("\n\n")[0]
    .trim()
    .slice(0, 500);
}

export function planReinforcement(profile, attempt, history, reinforcements, { targetItemId = null } = {}) {
  if (!profile?.id || attempt.student_id !== String(profile.id)) {
    throw new Error("Este intento no pertenece al perfil seleccionado.");
  }
  if (!Array.isArray(attempt.items) || !attempt.items.length) {
    throw new Error("El intento no contiene respuestas para preparar un refuerzo.");
  }
  const unitId = String(attempt.unit_id || "");
  const owned = ownedRecords(profile, [...(history || []), attempt], reinforcements || []);
  const unitAttempts = owned.ownedAttempts.filter((a) => String(a.unit_id || "") === unitId);
  const attemptIds = new Set(unitAttempts.map((a) => String(a.id)));
  const unitSupports = owned.supports.filter((r) => attemptIds.has(String(r.attempt_id)));
  const progress = summarizeProgress(profile, unitAttempts, unitSupports);

  const topicLookup = new Map();
  for (const t of progress.topics) {
    topicLookup.set(`${t.unit_id}|${keyOf(t.topic)}`, t);
  }

  if (targetItemId !== null && !attempt.items.some((i) => i.id === targetItemId)) {
    throw new Error("La pregunta seleccionada no pertenece a este intento.");
  }

  let candidates =
    targetItemId !== null
      ? attempt.items.filter((i) => i.id === targetItemId)
      : attempt.items.filter((i) => i.correct === false);
  if (!candidates.length) {
    const openOnly = attempt.items.filter((i) => i.correct === null || i.correct === undefined);
    candidates = openOnly.length ? openOnly : [...attempt.items];
  }

  const order = { guided: 0, check: 1, transfer: 2 };
  candidates.sort((a, b) => {
    const ta = topicLookup.get(topicKeyStr(unitId, a));
    const tb = topicLookup.get(topicKeyStr(unitId, b));
    const dOrd = order[ta.recommended_strategy] - order[tb.recommended_strategy];
    if (dOrd !== 0) return dOrd;
    const dUnres = tb.unresolved_error_count - ta.unresolved_error_count;
    if (dUnres !== 0) return dUnres;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  const target = candidates[0];
  const topic = topicLookup.get(topicKeyStr(unitId, target));
  const strategy = topic.recommended_strategy;
  let preferred = profile.presentation || "auto";
  if (!["auto", "visual", "steps"].includes(preferred)) preferred = "auto";
  const resolved = preferred !== "auto" ? preferred : strategy === "guided" ? "steps" : "visual";
  const reasoning = String(target.justification || "").trim();

  const stepsMap = {
    guided: [
      "Compara tu respuesta con la referencia revisada e identifica una diferencia.",
      "Revisa el ejemplo por partes y relaciona sus acciones con la idea del material.",
      "Resuelve un caso nuevo; si consultas ayuda, quedará registrado para el siguiente apoyo.",
    ],
    check: [
      "Revisa la idea y un ejemplo breve del material.",
      "Prueba un caso nuevo para reunir más evidencia sobre esta idea.",
    ],
    transfer: [
      "Aplica la misma idea en un contexto diferente.",
      "Intenta el caso nuevo antes de consultar el apoyo; después compara tu respuesta.",
    ],
  };

  const priorCases = [];
  for (const support of [...unitSupports].reverse()) {
    if (support.activity_kind === "source_review") continue;
    if (keyOf(support.topic || "") !== keyOf(target.topic || "")) continue;
    const ex = support.private_exercise || support.exercise || {};
    for (const txt of [support.example || "", ex.question || ""]) {
      const c = caseText(txt);
      if (c && !priorCases.includes(c)) priorCases.push(c);
    }
    if (priorCases.length >= 6) break;
  }

  const evidenceFields = [
    "attempt_count",
    "correct_count",
    "incorrect_count",
    "graded_count",
    "open_count",
    "support_count",
    "independently_correct_support_count",
    "assisted_correct_support_count",
    "completed_source_review_count",
    "correct_source_review_count",
    "unresolved_error_count",
  ];
  const evidence = {};
  for (const f of evidenceFields) evidence[f] = topic[f];

  const labelMap = {
    guided: "Apoyo guiado",
    check: "Comprobación adicional",
    transfer: "Aplicación en otro contexto",
  };

  return {
    policy_version: POLICY_VERSION,
    student_id: String(profile.id),
    target_item_id: target.id,
    unit_id: unitId,
    topic: target.topic || "Contenido de la unidad",
    strategy,
    label: labelMap[strategy],
    rationale: topic.rationale,
    evidence,
    preferred_format: preferred,
    resolved_format: resolved,
    format_reason:
      preferred !== "auto"
        ? "Tu preferencia guardada."
        : strategy === "guided"
          ? "Pasos breves por errores repetidos en este tema."
          : "Actividad visual cuando la fuente contiene relaciones verificables; en otro caso, apoyo por pasos.",
    profile_snapshot: {
      id: profile.id,
      goals: profile.goals,
      presentation: profile.presentation,
      updated_at: profile.updated_at,
    },
    reasoning_considered: false,
    reasoning_note: reasoning
      ? "Tu razonamiento queda guardado para revisión; el apoyo se planifica con la respuesta y el historial disponible, sin calificarlo automáticamente."
      : "No se registró una justificación. El apoyo se basa en la respuesta y en el historial disponible.",
    scaffolding: stepsMap[strategy],
    previous_cases: priorCases.slice(0, 6),
  };
}

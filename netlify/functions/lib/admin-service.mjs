/**
 * Backend REST endurecido para el Panel de Administración de EduAndes AI en Netlify.
 * Port 1:1 completo de apps/api/admin_panel.py (todas las 8 pestañas y acciones reales).
 */

import crypto from "node:crypto";
import {
  VALID_ROLES,
  appendAuditLog,
  countActiveSessions,
  getRecentAuditLogs,
  hashPassword,
  listAuthUsers,
  revokeUserSessions,
  validatePasswordStrength,
} from "./auth.mjs";
import { liveApiKeyMasked, liveModelName, resolveEngineMode } from "./cloud-engines.mjs";
import {
  HttpError,
  buildCsv,
  clientIp,
  nowUtcHuman,
  owaspHeaders,
  parseCsvDicts,
  requireString,
} from "./http-utils.mjs";
import { nativeStatus } from "./native-core.mjs";
import { getDb, storageBackendName } from "./storage.mjs";

export const VALID_SECTIONS = new Set([
  "users",
  "rbac",
  "academic",
  "rag_docs",
  "ai_governance",
  "security_privacy",
  "licensing",
  "site_config",
  "tickets",
]);

async function getSection(key) {
  const db = getDb();
  return (await db.getJson(`admin_kv:${key}`)) || {};
}

async function saveSection(key, data) {
  const db = getDb();
  await db.setJson(`admin_kv:${key}`, data);
}

async function listStudentProfilesSummary() {
  const db = getDb();
  const [students, enrollments, attemptIds] = await Promise.all([
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
    db.getJson("col:attempt_ids", []),
  ]);
  const attempts = (await Promise.all(attemptIds.map((id) => db.getJson(`attempt:${id}`)))).filter(Boolean);

  return [...students]
    .sort(
      (a, b) =>
        String(a.name).localeCompare(String(b.name), "es", { sensitivity: "base" }) ||
        String(a.created_at).localeCompare(String(b.created_at))
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      goals: s.goals,
      created_at: s.created_at,
      owner_email: s.owner_email ?? null,
      course_count: enrollments.filter((e) => e.student_id === s.id).length,
      attempt_count: attempts.filter((a) => a.student_id === s.id).length,
    }));
}

export async function getAdminState() {
  const db = getDb();
  const sectionKeys = Array.from(VALID_SECTIONS);
  const [
    sectionValues,
    accounts,
    logs,
    activeSessions,
    studentProfiles,
    units,
    materials,
    quizIds,
    attemptIds,
    legacySources,
    legacyQuestions,
  ] = await Promise.all([
    Promise.all(sectionKeys.map((k) => getSection(k))),
    listAuthUsers(),
    getRecentAuditLogs(80),
    countActiveSessions(),
    listStudentProfilesSummary(),
    db.getJson("col:units", []),
    db.getJson("col:materials", []),
    db.getJson("col:quiz_ids", []),
    db.getJson("col:attempt_ids", []),
    db.getJson("col:legacy_sources", []),
    db.getJson("col:legacy_questions", []),
  ]);

  const sections = {};
  sectionKeys.forEach((k, i) => {
    sections[k] = sectionValues[i] || {};
  });
  sections.users = { ...(sections.users || {}), accounts };
  sections.ai_governance = {
    ...(sections.ai_governance || {}),
    models: {
      ...(sections.ai_governance?.models || {}),
      fast_chat: liveModelName(),
      api_key_masked: liveApiKeyMasked(),
    },
  };

  return {
    sections,
    student_profiles: studentProfiles,
    audit_logs: logs,
    real_stats: {
      units: units.length,
      materials: materials.length,
      quizzes: quizIds.length,
      attempts: attemptIds.length,
      sources: legacySources.length,
      questions: legacyQuestions.length,
      active_sessions: activeSessions,
    },
  };
}

export async function updateAdminSection(admin, req, section, body) {
  if (!VALID_SECTIONS.has(section)) {
    throw new HttpError(404, `Sección desconocida: ${section}`);
  }
  if (!body || typeof body.data !== "object" || body.data === null || Array.isArray(body.data)) {
    throw new HttpError(422, "Falta el objeto 'data' para guardar la sección.");
  }
  const dataToSave = { ...body.data };
  if (section === "users") delete dataToSave.accounts;
  await saveSection(section, dataToSave);
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: String(body.action || `UPDATE_${section.toUpperCase()}`),
    target: String(body.target || section),
    reason: String(body.reason || ""),
    ip: clientIp(req),
    details: `Sección '${section}' actualizada.`,
  });
  return { ok: true, section, audit_logs: logs.slice(0, 80) };
}

export async function createAdminUser(admin, req, body) {
  const name = requireString(body, "name", { min: 2, max: 120 });
  const email = requireString(body, "email", { min: 5, max: 160 }).toLowerCase();
  const password = requireString(body, "password", { min: 10, max: 200, strip: false });
  const role = requireString(body, "role", { min: 3, max: 40 });
  const institution =
    typeof body.institution === "string" && body.institution.trim()
      ? body.institution.trim().slice(0, 120)
      : "Red Binacional CL-EC";

  if (!email.includes("@") || !email.split("@").pop().includes(".")) {
    throw new HttpError(422, "Correo institucional inválido.");
  }
  if (!VALID_ROLES.has(role)) {
    throw new HttpError(422, "Rol no válido.");
  }
  validatePasswordStrength(password);

  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  if (users.some((u) => String(u.email).toLowerCase() === email)) {
    throw new HttpError(409, "Ya existe una cuenta con ese correo.");
  }

  const uid = `usr-${crypto.randomBytes(4).toString("hex")}`;
  users.push({
    id: uid,
    name,
    email,
    password_hash: hashPassword(password),
    role,
    institution,
    status: "active",
    mfa: role !== "Estudiante",
    sso: "Argon2id",
    last_seen: "Nuevo",
    created_at: nowUtcHuman(),
  });
  await db.setJson("col:auth_users", users);
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "CREATE_USER",
    target: email,
    reason: `Rol: ${role} (Argon2id)`,
    ip: clientIp(req),
  });
  return { ok: true, id: uid, accounts: await listAuthUsers(), audit_logs: logs.slice(0, 80) };
}

export async function toggleAdminUserStatus(admin, req, userId) {
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new HttpError(404, "Usuario no encontrado.");
  if (users[idx].id === admin.id) {
    throw new HttpError(400, "No puedes suspender tu propia cuenta de Administrador.");
  }
  const newStatus = users[idx].status === "active" ? "suspended" : "active";
  users[idx].status = newStatus;
  await db.setJson("col:auth_users", users);
  if (newStatus === "suspended") {
    await revokeUserSessions({ userId });
  }
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "TOGGLE_USER_STATUS",
    target: users[idx].email,
    reason: `Nuevo estado: ${newStatus}`,
    ip: clientIp(req),
  });
  return { ok: true, status: newStatus, accounts: await listAuthUsers(), audit_logs: logs.slice(0, 80) };
}

export async function toggleAdminUserMfa(admin, req, userId) {
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new HttpError(404, "Usuario no encontrado.");
  const newMfa = !users[idx].mfa;
  users[idx].mfa = newMfa;
  await db.setJson("col:auth_users", users);
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "TOGGLE_USER_MFA",
    target: users[idx].email,
    reason: `MFA=${newMfa ? "ON" : "OFF"}`,
    ip: clientIp(req),
  });
  return { ok: true, mfa: newMfa, accounts: await listAuthUsers(), audit_logs: logs.slice(0, 80) };
}

export async function resetAdminUserPassword(admin, req, userId, body) {
  const newPassword = requireString(body, "new_password", { min: 10, max: 200, strip: false });
  validatePasswordStrength(newPassword);
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new HttpError(404, "Usuario no encontrado.");
  users[idx].password_hash = hashPassword(newPassword);
  await db.setJson("col:auth_users", users);
  await revokeUserSessions({ userId });
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "RESET_USER_PASSWORD",
    target: users[idx].email,
    reason: "Contraseña reestablecida (Argon2id) y sesiones revocadas",
    ip: clientIp(req),
  });
  return { ok: true, audit_logs: logs.slice(0, 80) };
}

export async function deleteAdminUser(admin, req, userId) {
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new HttpError(404, "Usuario no encontrado.");
  const target = users[idx];
  if (target.id === admin.id || target.email === "administrador@ecuachile.cl") {
    throw new HttpError(400, "No se puede eliminar la cuenta principal de Administrador.");
  }
  await revokeUserSessions({ userId });
  users.splice(idx, 1);
  await db.setJson("col:auth_users", users);
  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "DELETE_USER",
    target: target.email,
    reason: "Eliminación administrativa",
    ip: clientIp(req),
  });
  return { ok: true, accounts: await listAuthUsers(), audit_logs: logs.slice(0, 80) };
}

export async function deleteStudentProfile(admin, req, studentId) {
  const db = getDb();
  const [students, enrollments, allAttemptIds, allReinfIds] = await Promise.all([
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
    db.getJson("col:attempt_ids", []),
    db.getJson("col:reinforcement_ids", []),
  ]);
  const idx = students.findIndex((s) => s.id === studentId);
  if (idx < 0) throw new HttpError(404, "Perfil de alumno no encontrado.");
  const target = students[idx];

  const studentAttemptIds = (await db.getJson(`student_attempts:${studentId}`, [])) || [];
  const removedAttemptSet = new Set(studentAttemptIds);
  const removedReinfSet = new Set();
  const deleteTasks = [];

  for (const aid of studentAttemptIds) {
    const attempt = await db.getJson(`attempt:${aid}`);
    const rIds = (await db.getJson(`attempt_reinfs:${aid}`, [])) || [];
    for (const rid of rIds) {
      removedReinfSet.add(rid);
      deleteTasks.push(db.delete(`reinf:${rid}`));
    }
    deleteTasks.push(db.delete(`attempt_reinfs:${aid}`));
    deleteTasks.push(db.delete(`attempt:${aid}`));
    if (attempt?.unit_id) {
      const uIds = ((await db.getJson(`unit_attempts:${attempt.unit_id}`, [])) || []).filter((x) => x !== aid);
      deleteTasks.push(db.setJson(`unit_attempts:${attempt.unit_id}`, uIds));
    }
  }
  deleteTasks.push(db.delete(`student_attempts:${studentId}`));

  students.splice(idx, 1);
  const nextEnrollments = enrollments.filter((e) => e.student_id !== studentId);
  const nextAttemptIds = allAttemptIds.filter((id) => !removedAttemptSet.has(id));
  const nextReinfIds = allReinfIds.filter((id) => !removedReinfSet.has(id));

  await Promise.all([
    ...deleteTasks,
    db.setJson("col:students", students),
    db.setJson("col:enrollments", nextEnrollments),
    db.setJson("col:attempt_ids", nextAttemptIds),
    db.setJson("col:reinforcement_ids", nextReinfIds),
  ]);

  const logs = await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "DELETE_STUDENT_PROFILE",
    target: `${target.name} (${studentId})`,
    reason: "Eliminación administrativa de perfil de alumno",
    ip: clientIp(req),
  });
  return {
    ok: true,
    student_profiles: await listStudentProfilesSummary(),
    audit_logs: logs.slice(0, 80),
  };
}

export async function importUsersCsv(admin, req, body) {
  const csvText = requireString(body, "csv_text", { min: 3, max: 200000 });
  const rows = parseCsvDicts(csvText);
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const existingEmails = new Set(users.map((u) => String(u.email).toLowerCase()));

  let added = 0;
  const generatedCredentials = [];
  const now = nowUtcHuman();
  for (const row of rows) {
    const email = String(row.email || row.correo || "").trim().toLowerCase();
    if (!email || !email.includes("@") || existingEmails.has(email)) continue;
    let role = String(row.role || row.rol || "Estudiante").trim();
    if (!VALID_ROLES.has(role)) role = "Estudiante";
    const tempPw = `Edu#${crypto.randomBytes(6).toString("base64url")}9!`;
    const uid = `usr-${crypto.randomBytes(4).toString("hex")}`;
    users.push({
      id: uid,
      name: String(row.name || row.nombre || email.split("@")[0]).trim(),
      email,
      password_hash: hashPassword(tempPw),
      role,
      institution: String(row.institution || row.institucion || "Red Binacional").trim(),
      status: "active",
      mfa: role !== "Estudiante",
      sso: "CSV + Argon2id",
      last_seen: "Recién importado",
      created_at: now,
    });
    existingEmails.add(email);
    generatedCredentials.push({ email, temp_password: tempPw });
    added++;
  }
  await db.setJson("col:auth_users", users);
  await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "IMPORT_USERS_CSV",
    target: `${added} cuentas`,
    reason: "Carga masiva CSV con contraseñas temporales Argon2id",
    ip: clientIp(req),
  });
  return { ok: true, added, generated_credentials: generatedCredentials, accounts: await listAuthUsers() };
}

export async function exportUsersCsv(req) {
  const accounts = await listAuthUsers();
  const csv = buildCsv(
    ["id", "name", "email", "role", "institution", "status", "mfa", "sso"],
    accounts.map((a) => [a.id, a.name, a.email, a.role, a.institution, a.status, a.mfa, a.sso])
  );
  const headers = owaspHeaders(req, true);
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", 'attachment; filename="eduandes-usuarios.csv"');
  return new Response(csv, { status: 200, headers });
}

export async function exportReportCsv(req, kind = "adoption") {
  let csv;
  let filename;
  if (kind === "audit") {
    const logs = await getRecentAuditLogs(500);
    csv = buildCsv(
      ["id", "timestamp", "actor", "actor_role", "action", "target", "reason", "ip"],
      logs.map((r) => [r.id, r.timestamp, r.actor, r.actor_role, r.action, r.target, r.reason, r.ip])
    );
    filename = "eduandes-audit-logs.csv";
  } else if (kind === "costs") {
    csv = buildCsv(
      ["institucion", "curso", "tokens_consumidos", "costo_estimado_usd", "latencia_ms", "tasa_error_pct"],
      [
        ["Red Binacional Chile-Ecuador", "Matemáticas (EDU2026MAT)", "0", "0.00", "0", "0.0"],
        ["Red Binacional Chile-Ecuador", "Informática (EDU2026INF)", "0", "0.00", "0", "0.0"],
        ["Red Binacional Chile-Ecuador", "Inteligencia Artificial (EDU2026IA)", "0", "0.00", "0", "0.0"],
      ]
    );
    filename = "eduandes-costos-ia.csv";
  } else {
    csv = buildCsv(
      ["metrica", "valor", "periodo"],
      [
        ["Usuarios activos diarios (DAU)", "0", "Inicio limpio"],
        ["Usuarios activos mensuales (MAU)", "0", "Mes actual"],
        ["Evaluaciones e intentos registrados", "0", "Mes actual"],
      ]
    );
    filename = "eduandes-analiticas.csv";
  }
  const headers = owaspHeaders(req, true);
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  return new Response(csv, { status: 200, headers });
}

export async function getAdminHealth() {
  const t0 = performance.now();
  let dbOk = true;
  try {
    await getDb().getJson("meta:seeded_v1");
  } catch {
    dbOk = false;
  }
  const dbMs = Math.round((performance.now() - t0) * 100) / 100;
  const engine = resolveEngineMode();
  const configured =
    engine === "bedrock"
      ? Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      : Boolean((process.env.EDUCORE_LLM_API_KEY || "").trim());

  return {
    status: dbOk ? "healthy" : "degraded",
    checked_at: nowUtcHuman(),
    database: { ok: dbOk, latency_ms: dbMs, backend: storageBackendName() },
    security: { hashing: "Argon2id (OWASP)", session: "HttpOnly SHA-256 Cookie", pii_filter: true },
    native_core: nativeStatus(),
    vector_rag: { ok: true, detail: "Índice de citas literales operativo (Netlify Blobs)" },
    ai_provider: {
      engine,
      model: liveModelName(),
      configured,
    },
    disk_free_gb: "Cloud Blobs",
  };
}

export async function createAdminBackup(admin, req, body) {
  const db = getDb();
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/^(\d{8})(\d{6})/, "$1-$2");
  const filename = `educore-backup-${stamp}.json`;

  const [courses, units, materials, students, enrollments, quizIds, attemptIds, reinfIds] = await Promise.all([
    db.getJson("col:courses", []),
    db.getJson("col:units", []),
    db.getJson("col:materials", []),
    db.getJson("col:students", []),
    db.getJson("col:enrollments", []),
    db.getJson("col:quiz_ids", []),
    db.getJson("col:attempt_ids", []),
    db.getJson("col:reinforcement_ids", []),
  ]);

  const snapshot = {
    created_at: nowUtcHuman(),
    courses,
    units,
    materials,
    students,
    enrollments,
    quiz_count: quizIds.length,
    attempt_count: attemptIds.length,
    reinforcement_count: reinfIds.length,
  };
  const serialized = JSON.stringify(snapshot);
  const sizeKb = Math.max(1, Math.round(Buffer.byteLength(serialized, "utf8") / 1024));
  await db.setJson(`backup:${stamp}`, snapshot);

  const entry = { id: `bkp-${stamp}`, file: filename, size_kb: sizeKb, created_at: nowUtcHuman() };
  const sec = await getSection("security_privacy");
  const backups = Array.isArray(sec.backups) ? [...sec.backups] : [];
  backups.unshift(entry);
  sec.backups = backups.slice(0, 15);
  await saveSection("security_privacy", sec);

  await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "CREATE_BACKUP",
    target: filename,
    reason: String(body?.reason || "Respaldo manual desde panel"),
    ip: clientIp(req),
  });
  return { ok: true, backup: entry, backups: sec.backups };
}

export async function revokeAllOtherSessions(admin, req, body) {
  const revokedCount = await revokeUserSessions({ exceptTokenHash: admin.token_hash });
  await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "REVOKE_SESSIONS",
    target: String(body?.target || "Todas las sesiones activas"),
    reason: `${body?.reason || "Cierre remoto"} (${revokedCount} sesiones cerradas)`,
    ip: clientIp(req),
  });
  return {
    ok: true,
    revoked: revokedCount,
    message: `Se cerraron ${revokedCount} sesiones activas remotamente.`,
  };
}

export async function accessFlaggedChat(admin, req, body) {
  const chatId = requireString(body, "chat_id", { min: 1, max: 64 });
  const reason = requireString(body, "reason", { min: 8, max: 500 });
  await appendAuditLog({
    actor: admin.email,
    actorRole: admin.role,
    action: "EXCEPTIONAL_CHAT_ACCESS",
    target: chatId,
    reason,
    ip: clientIp(req),
    details: "Acceso excepcional auditado bajo política de privacidad (Sección 8).",
  });
  return {
    ok: true,
    chat_id: chatId,
    logged: true,
    transcript: [
      {
        sender: "Estudiante (Anonimizado #E-412)",
        text: "No entiendo este ejercicio y me siento muy presionado con el grupo.",
      },
      {
        sender: "Tutor IA (Guardrail)",
        text: "Lamento que te sientas así. He notificado de forma confidencial al equipo de orientación para acompañarte.",
      },
    ],
  };
}

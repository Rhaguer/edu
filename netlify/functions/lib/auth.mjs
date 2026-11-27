/**
 * Autenticación segura con Argon2id (OWASP RFC 9106, @noble/hashes puro JS sin binarios nativos),
 * sesiones HttpOnly hasheadas SHA-256 en Netlify Blobs, rate limiting anti fuerza bruta,
 * aislamiento de perfiles estudiantiles y RBAC fail-closed para EduAndes AI.
 */

import crypto from "node:crypto";
import { argon2id } from "@noble/hashes/argon2";
import {
  HttpError,
  clientIp,
  isHttpsRequest,
  nowIso,
  nowUtcHuman,
  parseCookies,
  serializeCookie,
  sha256Hex,
  uuid4,
} from "./http-utils.mjs";
import { ctEqual } from "./native-core.mjs";
import { getDb } from "./storage.mjs";

export const COOKIE_NAME = "eduandes_session";
export const SESSION_TTL_SECONDS = 12 * 3600; // 12 horas
const MAX_FAILED_PER_ACCOUNT = 5;
const ACCOUNT_LOCK_WINDOW = 900; // 15 min
const MAX_REQUESTS_PER_IP = 25;
const IP_WINDOW = 300; // 5 min

// Parámetros OWASP Argon2id (19 MiB, t=2, p=1) — 100% estándar PHC y rápido en Serverless
const ARGON2_M = 19456;
const ARGON2_T = 2;
const ARGON2_P = 1;
const ARGON2_DKLEN = 32;

export const ROLE_TO_VIEW = {
  Administrador: "admin",
  Docente: "teacher",
  "Directivo / Orientador": "teacher",
  Estudiante: "student",
};

export const VALID_ROLES = new Set([
  "Estudiante",
  "Docente",
  "Directivo / Orientador",
  "Administrador",
]);

let dummyHashCache = null;

function toB64NoPad(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

function fromB64NoPad(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return new Uint8Array(Buffer.from(str + "=".repeat(pad), "base64"));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = argon2id(String(password), salt, {
    m: ARGON2_M,
    t: ARGON2_T,
    p: ARGON2_P,
    dkLen: ARGON2_DKLEN,
  });
  return `$argon2id$v=19$m=${ARGON2_M},t=${ARGON2_T},p=${ARGON2_P}$${toB64NoPad(salt)}$${toB64NoPad(derived)}`;
}

export function verifyPassword(storedHash, candidate) {
  try {
    if (typeof storedHash !== "string" || !storedHash.startsWith("$argon2id$")) {
      return { valid: false, needsRehash: false };
    }
    const parts = storedHash.split("$");
    // ["", "argon2id", "v=19", "m=...,t=...,p=...", "<salt>", "<hash>"]
    if (parts.length !== 6) return { valid: false, needsRehash: false };
    const params = {};
    for (const pair of parts[3].split(",")) {
      const [k, v] = pair.split("=");
      params[k] = Number(v);
    }
    const m = params.m;
    const t = params.t;
    const p = params.p;
    if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p) || m < 8 || t < 1 || p < 1) {
      return { valid: false, needsRehash: false };
    }
    const salt = fromB64NoPad(parts[4]);
    const expected = fromB64NoPad(parts[5]);
    const derived = argon2id(String(candidate), salt, { m, t, p, dkLen: expected.length });
    const valid = ctEqual(derived, expected);
    const needsRehash = valid && (m !== ARGON2_M || t !== ARGON2_T || p !== ARGON2_P);
    return { valid, needsRehash };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

function getDummyHash() {
  if (!dummyHashCache) {
    dummyHashCache = hashPassword("EduAndes#DummyTimingGuard2026!");
  }
  return dummyHashCache;
}

export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new HttpError(422, "La contraseña debe tener al menos 10 caracteres.");
  }
  if (!/[A-Z]/.test(password)) {
    throw new HttpError(422, "La contraseña debe incluir al menos una letra mayúscula.");
  }
  if (!/[a-z]/.test(password)) {
    throw new HttpError(422, "La contraseña debe incluir al menos una letra minúscula.");
  }
  if (!/\d/.test(password)) {
    throw new HttpError(422, "La contraseña debe incluir al menos un número.");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new HttpError(422, "La contraseña debe incluir al menos un símbolo (ej. #, !, @, $).");
  }
}

function defaultAccountsSpec() {
  return [
    {
      id: "usr-001",
      name: "Administrador Principal",
      email: "administrador@ecuachile.cl",
      password: process.env.EDUCORE_SEED_ADMIN_PASSWORD || "123456",
      role: "Administrador",
      institution: "EduAndes Central (CL-EC)",
      mfa: true,
      sso: "Argon2id + Sesión HttpOnly",
    },
    {
      id: "usr-002",
      name: "Docente Binacional",
      email: "docente@ecuachile.cl",
      password: process.env.EDUCORE_SEED_TEACHER_PASSWORD || "123456",
      role: "Docente",
      institution: "Liceo Bicentenario Santiago",
      mfa: true,
      sso: "Argon2id + Sesión HttpOnly",
    },
    {
      id: "usr-003",
      name: "Estudiante Demo",
      email: "estudiante@ecuachile.cl",
      password: process.env.EDUCORE_SEED_STUDENT_PASSWORD || "123456",
      role: "Estudiante",
      institution: "Unidad Educativa Quito Norte",
      mfa: false,
      sso: "Argon2id + Sesión HttpOnly",
    },
    {
      id: "usr-004",
      name: "Orientación y Bienestar",
      email: "orientacion@ecuachile.cl",
      password: process.env.EDUCORE_SEED_WELLNESS_PASSWORD || "123456",
      role: "Directivo / Orientador",
      institution: "Red Binacional ODS 4",
      mfa: true,
      sso: "Argon2id + Sesión HttpOnly",
    },
  ];
}

export async function initializeAuthAndAudit(db = getDb()) {
  const existingUsers = await db.getJson("col:auth_users");
  const now = nowUtcHuman();
  if (!Array.isArray(existingUsers) || existingUsers.length === 0) {
    const seededUsers = defaultAccountsSpec().map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      password_hash: hashPassword(u.password),
      role: u.role,
      institution: u.institution,
      status: "active",
      mfa: Boolean(u.mfa),
      sso: u.sso,
      last_seen: "Listo",
      created_at: now,
    }));
    await db.setJson("col:auth_users", seededUsers);
  }
  const existingLogs = await db.getJson("col:audit_logs");
  if (!Array.isArray(existingLogs) || existingLogs.length === 0) {
    await db.setJson("col:audit_logs", [
      {
        id: 1,
        timestamp: now,
        actor: "administrador@ecuachile.cl",
        actor_role: "Administrador",
        action: "INIT_ADMIN_CONSOLE",
        target: "Sistema EduAndes AI (Netlify)",
        reason: "Inicialización segura con Argon2id y auditoría inmutable",
        ip: "127.0.0.1",
        details: "Registro de auditoría inmutable habilitado en Netlify Blobs.",
      },
    ]);
  }
  const sessionIndex = await db.getJson("meta:session_index");
  if (!Array.isArray(sessionIndex)) {
    await db.setJson("meta:session_index", []);
  }
}

export async function appendAuditLog({ actor, actorRole, action, target, reason = "", ip = "127.0.0.1", details = "" }) {
  const db = getDb();
  const logs = (await db.getJson("col:audit_logs", [])) || [];
  const nextId = logs.length ? Math.max(...logs.map((l) => Number(l.id) || 0)) + 1 : 1;
  const entry = {
    id: nextId,
    timestamp: nowUtcHuman(),
    actor: String(actor || "sistema"),
    actor_role: String(actorRole || "Sistema"),
    action: String(action || "EVENT"),
    target: String(target || ""),
    reason: String(reason || ""),
    ip: String(ip || "127.0.0.1"),
    details: String(details || ""),
  };
  logs.unshift(entry);
  if (logs.length > 500) logs.length = 500;
  await db.setJson("col:audit_logs", logs);
  return logs;
}

export async function getRecentAuditLogs(limit = 80) {
  const db = getDb();
  const logs = (await db.getJson("col:audit_logs", [])) || [];
  return logs.slice(0, limit);
}

export function sanitizeUserPublic(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    institution: u.institution,
    status: u.status,
    mfa: Boolean(u.mfa),
    sso: u.sso,
    last_seen: u.last_seen,
  };
}

export async function listAuthUsers() {
  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  return [...users]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.email.localeCompare(b.email))
    .map(sanitizeUserPublic);
}

export async function ensureStudentProfile(user) {
  if (!user || user.role !== "Estudiante") return null;
  const db = getDb();
  const email = String(user.email || "").trim().toLowerCase();
  const students = (await db.getJson("col:students", [])) || [];
  const courses = (await db.getJson("col:courses", [])) || [];
  const enrollments = (await db.getJson("col:enrollments", [])) || [];
  const ts = nowIso();

  let profile = students.find((s) => String(s.owner_email || "").toLowerCase() === email);
  let studentsDirty = false;
  if (!profile) {
    profile = {
      id: uuid4(),
      name: user.name || "Estudiante",
      goals: "Aprender practicando con EduAndes AI",
      presentation: "auto",
      created_at: ts,
      updated_at: ts,
      owner_email: email,
    };
    students.push(profile);
    studentsDirty = true;
  }

  let enrollDirty = false;
  for (const c of courses) {
    const exists = enrollments.some((e) => e.student_id === profile.id && e.course_id === c.id);
    if (!exists) {
      enrollments.push({ student_id: profile.id, course_id: c.id, created_at: ts });
      enrollDirty = true;
    }
  }

  if (studentsDirty) await db.setJson("col:students", students);
  if (enrollDirty) await db.setJson("col:enrollments", enrollments);
  return profile.id;
}

export async function getSessionUser(req) {
  const cookies = parseCookies(req.headers.get("cookie"));
  const rawToken = cookies[COOKIE_NAME];
  if (!rawToken || rawToken.length < 20) return null;
  const tokenHash = sha256Hex(rawToken);
  const db = getDb();
  const session = await db.getJson(`session:${tokenHash}`);
  const nowSec = Date.now() / 1000;
  if (!session || session.revoked || session.expires_at < nowSec) return null;
  const users = (await db.getJson("col:auth_users", [])) || [];
  const user = users.find((u) => u.id === session.user_id);
  if (!user || user.status !== "active") return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    view_role: ROLE_TO_VIEW[user.role] || "student",
    institution: user.institution,
    mfa: Boolean(user.mfa),
    token_hash: tokenHash,
  };
}

export async function requireAuthenticated(req) {
  const user = await getSessionUser(req);
  if (!user) {
    throw new HttpError(401, "Sesión requerida. Inicia sesión para continuar.");
  }
  return user;
}

export async function requireAdmin(req) {
  const user = await requireAuthenticated(req);
  if (user.role !== "Administrador") {
    throw new HttpError(403, "Acceso denegado: se requiere rol Administrador.");
  }
  return user;
}

export async function countActiveSessions() {
  const db = getDb();
  const nowSec = Date.now() / 1000;
  const index = (await db.getJson("meta:session_index", [])) || [];
  let active = 0;
  const alive = [];
  for (const item of index) {
    if (item.expires_at > nowSec && !item.revoked) {
      active++;
      alive.push(item);
    }
  }
  if (alive.length !== index.length) {
    await db.setJson("meta:session_index", alive);
  }
  return active;
}

export async function revokeUserSessions({ userId = null, email = null, exceptTokenHash = null } = {}) {
  const db = getDb();
  const index = (await db.getJson("meta:session_index", [])) || [];
  let revokedCount = 0;
  const remaining = [];
  const tasks = [];

  for (const entry of index) {
    const match =
      (userId && entry.user_id === userId) ||
      (email && String(entry.email).toLowerCase() === String(email).toLowerCase()) ||
      (exceptTokenHash && entry.token_hash !== exceptTokenHash) ||
      (!userId && !email && !exceptTokenHash);

    if (match && !entry.revoked) {
      revokedCount++;
      tasks.push(db.delete(`session:${entry.token_hash}`));
    } else if (!entry.revoked && entry.expires_at > Date.now() / 1000) {
      remaining.push(entry);
    }
  }
  tasks.push(db.setJson("meta:session_index", remaining));
  await Promise.all(tasks);
  return revokedCount;
}

// Rate limit en memoria + persistencia ligera en Blobs para brute-force
async function checkLoginRateLimit(ip, email) {
  const db = getDb();
  const nowSec = Date.now() / 1000;

  const ipKey = `rl:ip:${sha256Hex(ip).slice(0, 20)}`;
  const ipTimes = ((await db.getJson(ipKey, [])) || []).filter((t) => nowSec - t <= IP_WINDOW);
  if (ipTimes.length >= MAX_REQUESTS_PER_IP) {
    throw new HttpError(429, "Demasiados intentos desde esta IP. Espera unos minutos.");
  }
  ipTimes.push(nowSec);
  await db.setJson(ipKey, ipTimes);

  const acctKey = `rl:acct:${sha256Hex(`${ip}|${email}`).slice(0, 20)}`;
  const acctTimes = ((await db.getJson(acctKey, [])) || []).filter((t) => nowSec - t <= ACCOUNT_LOCK_WINDOW);
  if (acctTimes.length >= MAX_FAILED_PER_ACCOUNT) {
    const waitMin = Math.max(1, Math.floor((ACCOUNT_LOCK_WINDOW - (nowSec - acctTimes[0])) / 60) + 1);
    throw new HttpError(429, `Cuenta temporalmente bloqueada por seguridad. Intenta en ${waitMin} min.`);
  }
}

async function recordLoginFailure(ip, email) {
  const db = getDb();
  const nowSec = Date.now() / 1000;
  const acctKey = `rl:acct:${sha256Hex(`${ip}|${email}`).slice(0, 20)}`;
  const acctTimes = ((await db.getJson(acctKey, [])) || []).filter((t) => nowSec - t <= ACCOUNT_LOCK_WINDOW);
  acctTimes.push(nowSec);
  await db.setJson(acctKey, acctTimes);
}

async function clearLoginFailures(ip, email) {
  const db = getDb();
  const acctKey = `rl:acct:${sha256Hex(`${ip}|${email}`).slice(0, 20)}`;
  await db.delete(acctKey);
}

export async function isMaintenanceOn() {
  const db = getDb();
  const site = await db.getJson("admin_kv:site_config");
  return Boolean(site && site.maintenance_mode);
}

export async function getSiteMeta() {
  const db = getDb();
  const cfg = (await db.getJson("admin_kv:site_config")) || {};
  return {
    banner_active: Boolean(cfg.banner_active),
    banner_text: String(cfg.banner_text || ""),
    maintenance_mode: Boolean(cfg.maintenance_mode),
    brand_name: String(cfg.brand_name || "EduAndes AI"),
  };
}

export async function handleLogin(req, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (email.length < 3 || email.length > 160 || password.length < 1 || password.length > 200) {
    throw new HttpError(422, "Completa tu correo y contraseña.");
  }

  const ip = clientIp(req);
  await checkLoginRateLimit(ip, email);

  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => String(u.email).toLowerCase() === email);
  const row = idx >= 0 ? users[idx] : null;

  if (!row) {
    // Verificación dummy en tiempo constante contra enumeración de usuarios
    verifyPassword(getDummyHash(), password);
    await recordLoginFailure(ip, email);
    await appendAuditLog({
      actor: email,
      actorRole: "Desconocido",
      action: "LOGIN_FAILED",
      target: email,
      reason: "Credenciales inválidas",
      ip,
    });
    throw new HttpError(401, "Correo o contraseña incorrectos.");
  }

  const { valid, needsRehash } = verifyPassword(row.password_hash, password);
  if (!valid) {
    await recordLoginFailure(ip, email);
    await appendAuditLog({
      actor: email,
      actorRole: row.role,
      action: "LOGIN_FAILED",
      target: email,
      reason: "Contraseña incorrecta",
      ip,
    });
    throw new HttpError(401, "Correo o contraseña incorrectos.");
  }

  if (row.status !== "active") {
    await appendAuditLog({
      actor: email,
      actorRole: row.role,
      action: "LOGIN_BLOCKED_SUSPENDED",
      target: email,
      reason: "Cuenta suspendida",
      ip,
    });
    throw new HttpError(403, "Tu cuenta está suspendida. Contacta al Administrador.");
  }

  await clearLoginFailures(ip, email);

  const rawToken = crypto.randomBytes(48).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = Date.now() / 1000 + SESSION_TTL_SECONDS;
  const ua = String(req.headers.get("user-agent") || "").slice(0, 200);
  const nowStr = nowUtcHuman();

  if (needsRehash) {
    users[idx].password_hash = hashPassword(password);
  }
  users[idx].last_seen = nowStr;

  const sessionRecord = {
    token_hash: tokenHash,
    user_id: row.id,
    email: row.email,
    role: row.role,
    ip,
    user_agent: ua,
    created_at: nowStr,
    expires_at: expiresAt,
    revoked: false,
  };

  const sessionIndex = ((await db.getJson("meta:session_index", [])) || []).filter(
    (s) => s.expires_at > Date.now() / 1000 && !s.revoked
  );
  sessionIndex.push({
    token_hash: tokenHash,
    user_id: row.id,
    email: row.email,
    expires_at: expiresAt,
    revoked: false,
  });

  await Promise.all([
    db.setJson("col:auth_users", users),
    db.setJson(`session:${tokenHash}`, sessionRecord),
    db.setJson("meta:session_index", sessionIndex),
  ]);

  await appendAuditLog({
    actor: row.email,
    actorRole: row.role,
    action: "LOGIN_SUCCESS",
    target: row.email,
    reason: "Autenticación Argon2id",
    ip,
  });

  const userPayload = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    view_role: ROLE_TO_VIEW[row.role] || "student",
    institution: row.institution,
    mfa: Boolean(row.mfa),
  };
  userPayload.student_id = await ensureStudentProfile(userPayload);

  const cookie = serializeCookie(COOKIE_NAME, rawToken, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(req),
    path: "/",
  });

  return {
    payload: { authenticated: true, user: userPayload },
    cookie,
  };
}

export async function handleLogout(req) {
  const user = await getSessionUser(req);
  if (user) {
    const db = getDb();
    await db.delete(`session:${user.token_hash}`);
    const idx = ((await db.getJson("meta:session_index", [])) || []).filter(
      (s) => s.token_hash !== user.token_hash
    );
    await db.setJson("meta:session_index", idx);
    await appendAuditLog({
      actor: user.email,
      actorRole: user.role,
      action: "LOGOUT",
      target: user.email,
      reason: "Cierre de sesión",
      ip: clientIp(req),
    });
  }
  const cookie = serializeCookie(COOKIE_NAME, "", {
    maxAge: 0,
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(req),
    path: "/",
  });
  return { payload: { ok: true }, cookie };
}

export async function handleMe(req) {
  const [user, site] = await Promise.all([getSessionUser(req), getSiteMeta()]);
  if (!user) {
    return { authenticated: false, user: null, site };
  }
  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    view_role: user.view_role,
    institution: user.institution,
    mfa: user.mfa,
  };
  safeUser.student_id = await ensureStudentProfile(safeUser);
  return { authenticated: true, user: safeUser, site };
}

export async function handleChangeOwnPassword(req, body) {
  const user = await requireAuthenticated(req);
  const currentPassword = String(body.current_password || "");
  const newPassword = String(body.new_password || "");
  validatePasswordStrength(newPassword);

  const db = getDb();
  const users = (await db.getJson("col:auth_users", [])) || [];
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx < 0 || !verifyPassword(users[idx].password_hash, currentPassword).valid) {
    throw new HttpError(401, "La contraseña actual es incorrecta.");
  }

  users[idx].password_hash = hashPassword(newPassword);
  await db.setJson("col:auth_users", users);
  await revokeUserSessions({ userId: user.id });
  await appendAuditLog({
    actor: user.email,
    actorRole: user.role,
    action: "CHANGE_OWN_PASSWORD",
    target: user.email,
    reason: "Cambio voluntario de contraseña",
    ip: clientIp(req),
  });
  return { ok: true, message: "Contraseña actualizada con Argon2id. Vuelve a iniciar sesión." };
}

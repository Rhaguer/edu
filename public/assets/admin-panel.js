(function () {
  "use strict";

  var AUTH_EMAIL_KEY = "eduandes.auth.email";
  var AUTH_IS_ADMIN_KEY = "eduandes.auth.is_admin";
  var ADMIN_VIEW_KEY = "eduandes.admin.view";

  var SECTIONS = [
    { id: "users", title: "1. Usuarios, Roles e Instituciones" },
    { id: "academic", title: "2. Gestión Académica y RAG" },
    { id: "ai", title: "3. Gobernanza y Núcleo IA" },
    { id: "analytics", title: "4. Analíticas y Reportes" },
    { id: "security", title: "5. Seguridad, Privacidad y Auditoría" },
    { id: "licensing", title: "6. Comercial y Licenciamiento" },
    { id: "site", title: "7. Sitio Global, Salud y Soporte" },
    { id: "limits", title: "8. Límites del Administrador" },
  ];

  var state = {
    activeTab: "users",
    data: null,
    studentProfiles: [],
    auditLogs: [],
    realStats: {},
    health: null,
    userFilter: "",
    auditFilter: "",
    chatTranscript: null,
  };

  function isAdminLoggedIn() {
    try {
      return sessionStorage.getItem(AUTH_IS_ADMIN_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function currentEmail() {
    try {
      return sessionStorage.getItem(AUTH_EMAIL_KEY) || "administrador@ecuachile.cl";
    } catch (_) {
      return "administrador@ecuachile.cl";
    }
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(msg) {
    var old = document.querySelector(".ea-adm-toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "ea-adm-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.remove();
    }, 3600);
  }

  async function api(url, opts) {
    var finalOpts = Object.assign({ credentials: "same-origin" }, opts || {});
    var res = await fetch(url, finalOpts);
    if (res.status === 401) {
      if (typeof window.__eduandesLogout === "function") window.__eduandesLogout();
      throw new Error("Sesión expirada.");
    }
    var raw = await res.text();
    var parsed = null;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!res.ok) {
      throw new Error((parsed && parsed.detail) || raw || "Error HTTP " + res.status);
    }
    return parsed;
  }

  async function loadAll() {
    var [st, hl] = await Promise.all([
      api("/api/admin/state"),
      api("/api/admin/health"),
    ]);
    state.data = st.sections;
    state.studentProfiles = st.student_profiles || [];
    state.auditLogs = st.audit_logs || [];
    state.realStats = st.real_stats || {};
    state.health = hl;
    render();
  }

  async function saveSection(sectionKey, payload, action, target, reason) {
    var res = await api("/api/admin/section/" + encodeURIComponent(sectionKey), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: payload,
        action: action || "UPDATE_" + sectionKey.toUpperCase(),
        target: target || sectionKey,
        reason: reason || "",
      }),
    });
    state.auditLogs = res.audit_logs || state.auditLogs;
    showToast("Cambios guardados y registrados en Audit Log.");
    render();
  }

  function mountOrUnmount() {
    var wantAdmin = false;
    try {
      wantAdmin = window.location.hash.indexOf("#/admin") === 0 || sessionStorage.getItem(ADMIN_VIEW_KEY) === "1";
    } catch (_) {}
    var shouldShow = wantAdmin && isAdminLoggedIn();
    var existing = document.getElementById("ea-admin-console");
    if (!shouldShow) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "ea-admin-console";
      document.body.appendChild(existing);
      loadAll().catch(function (e) {
        showToast("Error cargando panel: " + e.message);
      });
    } else {
      render();
    }
  }

  function renderUsersTab(d) {
    var users = d.users;
    var rbac = d.rbac;
    var roles = ["Estudiante", "Docente", "Directivo / Orientador", "Administrador"];
    var accounts = users.accounts || [];
    var filtered = accounts.filter(function (a) {
      if (!state.userFilter) return true;
      var q = state.userFilter.toLowerCase();
      return (a.name + " " + a.email + " " + a.role + " " + a.institution).toLowerCase().indexOf(q) !== -1;
    });

    var rowsHtml = filtered.map(function (u) {
      var badgeCls = u.status === "active" ? "is-ok" : "is-danger";
      var statusLabel = u.status === "active" ? "Activo" : "Suspendido";
      var isSelf = u.email === currentEmail();
      return (
        "<tr>" +
          "<td><strong>" + esc(u.name) + "</strong><br><small>" + esc(u.email) + "</small></td>" +
          "<td>" + esc(u.role) + "</td>" +
          "<td>" + esc(u.institution) + "</td>" +
          "<td><span class='ea-adm-badge " + badgeCls + "'>" + statusLabel + "</span></td>" +
          "<td>" + (u.mfa ? "MFA ON" : "MFA OFF") + " · <small>" + esc(u.sso) + "</small></td>" +
          "<td><div class='ea-adm-row-actions'>" +
            (!isSelf ? "<button class='ea-adm-btn is-sm' data-act='toggle-status' data-id='" + esc(u.id) + "'>" + (u.status === "active" ? "Suspender" : "Reactivar") + "</button>" : "") +
            "<button class='ea-adm-btn is-sm' data-act='toggle-mfa' data-id='" + esc(u.id) + "'>MFA</button>" +
            "<button class='ea-adm-btn is-sm' data-act='reset-pw' data-id='" + esc(u.id) + "' data-email='" + esc(u.email) + "'>Cambiar Clave</button>" +
            (!isSelf && u.email !== "administrador@ecuachile.cl" ? "<button class='ea-adm-btn is-sm is-danger' data-act='del-user' data-id='" + esc(u.id) + "'>Eliminar</button>" : "") +
          "</div></td>" +
        "</tr>"
      );
    }).join("");

    var rbacRows = rbac.permissions.map(function (p, idx) {
      var cells = roles.map(function (r) {
        return "<td><input type='checkbox' data-rbac-idx='" + idx + "' data-rbac-role='" + esc(r) + "' " + (p[r] ? "checked" : "") + " /></td>";
      }).join("");
      return "<tr><td>" + esc(p.label) + "</td>" + cells + "</tr>";
    }).join("");

    return (
      "<div class='ea-adm-header'><div><h2>1. Gestión de Usuarios, Roles e Instituciones</h2>" +
      "<p>Cuentas reales protegidas con <strong>Argon2id</strong>, carga CSV, SSO, MFA, revocación remota y matriz RBAC.</p></div>" +
      "<div class='ea-adm-row-actions'>" +
        "<a class='ea-adm-btn' href='/api/admin/users/export-csv' target='_blank'>Exportar CSV</a>" +
        "<button class='ea-adm-btn is-danger' id='btn-revoke-all'>Cerrar otras sesiones</button>" +
      "</div></div>" +

      "<div class='ea-adm-card'><h3>Crear nueva cuenta (hash Argon2id)</h3>" +
        "<div class='ea-adm-form-grid'>" +
          "<div class='ea-adm-field'><label>Nombre completo</label><input id='u-name' placeholder='Ej. Camila Rojas' /></div>" +
          "<div class='ea-adm-field'><label>Correo institucional</label><input id='u-email' placeholder='usuario@ecuachile.cl' /></div>" +
          "<div class='ea-adm-field'><label>Contraseña segura (mín. 10 chars, Aa1!)</label><input id='u-pass' type='password' placeholder='Ej. EduAndes#2026!' /></div>" +
          "<div class='ea-adm-field'><label>Rol</label><select id='u-role'><option>Estudiante</option><option>Docente</option><option>Directivo / Orientador</option><option>Administrador</option></select></div>" +
          "<div class='ea-adm-field'><label>Institución</label><input id='u-inst' value='Red Binacional CL-EC' /></div>" +
        "</div>" +
        "<button class='ea-adm-btn is-primary' id='btn-add-user'>Crear Usuario Seguro</button>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Cuentas registradas (" + filtered.length + ")</h3>" +
        "<div class='ea-adm-field'><input id='u-search' placeholder='Buscar por nombre, correo, rol o institución...' value='" + esc(state.userFilter) + "' /></div>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Usuario</th><th>Rol</th><th>Institución</th><th>Estado</th><th>Seguridad</th><th>Acciones</th></tr></thead><tbody>" + rowsHtml + "</tbody></table></div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Perfiles de Alumnos creados en la Plataforma (" + state.studentProfiles.length + ")</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Alumno</th><th>Cuenta vinculada</th><th>Asignaturas</th><th>Intentos</th><th>Acción</th></tr></thead><tbody>" +
        (state.studentProfiles.length
          ? state.studentProfiles.map(function (sp) {
              return "<tr><td><strong>" + esc(sp.name) + "</strong><br><small>" + esc(sp.id) + "</small></td><td>" + esc(sp.owner_email || "Perfil manual") + "</td><td>" + esc(sp.course_count || 0) + "</td><td>" + esc(sp.attempt_count || 0) + "</td><td><button class='ea-adm-btn is-sm is-danger' data-del-student='" + esc(sp.id) + "' data-student-name='" + esc(sp.name) + "'>Eliminar alumno</button></td></tr>";
            }).join("")
          : "<tr><td colspan='5'><small>No hay perfiles de alumnos creados.</small></td></tr>") +
        "</tbody></table></div>" +
      "</div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-card'><h3>Políticas SSO y MFA</h3>" +
          "<div class='ea-adm-switch-row'><span>Google Workspace (OAuth2)</span><input type='checkbox' id='sso-google' " + (users.sso_providers.google_workspace ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-switch-row'><span>Microsoft 365 (Entra ID)</span><input type='checkbox' id='sso-ms' " + (users.sso_providers.microsoft_365 ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-switch-row'><span>SAML 2.0 / OAuth Institucional</span><input type='checkbox' id='sso-saml' " + (users.sso_providers.saml_oauth ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-switch-row'><span>MFA obligatorio (Admins y Docentes)</span><input type='checkbox' id='sso-mfa' " + (users.sso_providers.mfa_required_admins_teachers ? "checked" : "") + " /></div>" +
          "<button class='ea-adm-btn is-primary' id='btn-save-sso' style='margin-top:10px'>Guardar SSO y MFA</button>" +
        "</div>" +
        "<div class='ea-adm-card'><h3>Carga masiva CSV</h3>" +
          "<div class='ea-adm-field'><label>Filas CSV (email,name,role,institution)</label>" +
          "<textarea id='csv-import-box' rows='4'>nuevo.docente@ecuachile.cl,Ana Paredes,Docente,Liceo Quito Sur\nnuevo.est@ecuachile.cl,Luis Soto,Estudiante,Liceo Santiago</textarea></div>" +
          "<button class='ea-adm-btn is-primary' id='btn-import-csv'>Importar CSV (claves aleatorias)</button>" +
        "</div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Matriz de Roles y Permisos (RBAC)</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Permiso</th>" + roles.map(function (r) { return "<th>" + esc(r) + "</th>"; }).join("") + "</tr></thead><tbody>" + rbacRows + "</tbody></table></div>" +
        "<button class='ea-adm-btn is-primary' id='btn-save-rbac' style='margin-top:12px'>Guardar Matriz RBAC</button>" +
      "</div>"
    );
  }

  function renderAcademicTab(d) {
    var ac = d.academic;
    var rag = d.rag_docs;
    return (
      "<div class='ea-adm-header'><div><h2>2. Gestión Académica y Base de Conocimiento (RAG)</h2>" +
      "<p>Periodos lectivos, niveles, cursos/matrículas, repositorio curricular oficial y tutores por asignatura.</p></div></div>" +

      "<div class='ea-adm-card'><h3>Cursos, Docentes y Matrículas</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Curso / Sección</th><th>Nivel</th><th>Docente asignado</th><th>Matriculados</th><th>Tutor habilitado</th></tr></thead><tbody>" +
        ac.courses.map(function (c) {
          return "<tr><td><strong>" + esc(c.name) + "</strong></td><td>" + esc(c.level) + "</td><td>" + esc(c.teacher) + "</td><td>" + esc(c.students) + "</td><td><span class='ea-adm-badge'>" + esc(c.tutor) + "</span></td></tr>";
        }).join("") +
        "</tbody></table></div>" +
        "<div class='ea-adm-form-grid' style='margin-top:12px'>" +
          "<div class='ea-adm-field'><label>Nuevo curso</label><input id='c-name' placeholder='Ej. Historia 1° Medio B' /></div>" +
          "<div class='ea-adm-field'><label>Nivel educativo</label><select id='c-level'>" + ac.levels.map(function (l) { return "<option>" + esc(l) + "</option>"; }).join("") + "</select></div>" +
          "<div class='ea-adm-field'><label>Docente</label><input id='c-teacher' value='docente@ecuachile.cl' /></div>" +
          "<div class='ea-adm-field'><label>Matriculados</label><input id='c-students' type='number' value='28' /></div>" +
        "</div>" +
        "<button class='ea-adm-btn is-primary' id='btn-add-course'>Agregar Curso y Matrícula</button>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Repositorio Curricular Oficial (Contexto Verificado RAG)</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Documento oficial</th><th>Asignatura</th><th>Tipo</th><th>Páginas</th><th>Estado</th><th>Acción</th></tr></thead><tbody>" +
        rag.documents.map(function (doc) {
          return "<tr><td><strong>" + esc(doc.title) + "</strong></td><td>" + esc(doc.subject) + "</td><td>" + esc(doc.kind) + "</td><td>" + esc(doc.pages) + "</td><td><span class='ea-adm-badge is-ok'>" + esc(doc.status) + "</span></td><td><button class='ea-adm-btn is-sm is-danger' data-del-doc='" + esc(doc.id) + "'>Eliminar</button></td></tr>";
        }).join("") +
        "</tbody></table></div>" +
        "<div class='ea-adm-form-grid' style='margin-top:12px'>" +
          "<div class='ea-adm-field'><label>Título del documento</label><input id='rag-title' placeholder='Ej. Programa Oficial Física 2026.pdf' /></div>" +
          "<div class='ea-adm-field'><label>Asignatura</label><input id='rag-subj' placeholder='Física' /></div>" +
          "<div class='ea-adm-field'><label>Tipo</label><select id='rag-kind'><option>Programa de estudio</option><option>Guía oficial</option><option>Rúbrica</option><option>Bibliografía</option></select></div>" +
        "</div>" +
        "<button class='ea-adm-btn is-primary' id='btn-add-rag'>Indexar Documento Curricular</button>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Módulos / Tutores por Asignatura</h3>" +
        ac.modules.map(function (m, idx) {
          return "<div class='ea-adm-switch-row'><div><strong>" + esc(m.name) + "</strong> <small>(" + esc(m.level) + ")</small></div><input type='checkbox' data-mod-idx='" + idx + "' " + (m.enabled ? "checked" : "") + " /></div>";
        }).join("") +
        "<button class='ea-adm-btn is-primary' id='btn-save-modules' style='margin-top:10px'>Guardar Módulos</button>" +
      "</div>"
    );
  }

  function renderAiTab(d) {
    var ai = d.ai_governance;
    return (
      "<div class='ea-adm-header'><div><h2>3. Gobernanza y Configuración de la IA</h2>" +
      "<p>Modelos activos en vivo, System Prompts socráticos, cuotas, filtro PII automático, guardrails y alertas tempranas.</p></div></div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-card'><h3>Modelos, Proveedores y Fallbacks</h3>" +
          "<div class='ea-adm-field'><label>Modelo activo (en vivo desde .env)</label><input id='ai-m-fast' value='" + esc(ai.models.fast_chat) + "' /></div>" +
          "<div class='ea-adm-field'><label>Generación de exámenes</label><input id='ai-m-exam' value='" + esc(ai.models.exam_generation) + "' /></div>" +
          "<div class='ea-adm-field'><label>Análisis de documentos</label><input id='ai-m-doc' value='" + esc(ai.models.document_analysis) + "' /></div>" +
          "<div class='ea-adm-field'><label>Proveedor Fallback</label><input id='ai-m-fb' value='" + esc(ai.models.fallback_provider) + "' /></div>" +
          "<p><small>API Key activa: <strong>" + esc(ai.models.api_key_masked) + "</strong> · Filtro PII (RUT/DNI/Email): <span class='ea-adm-badge is-ok'>Activo</span></small></p>" +
        "</div>" +
        "<div class='ea-adm-card'><h3>Límites de Uso y Cuotas (Rate Limiting)</h3>" +
          "<div class='ea-adm-field'><label>Mensajes diarios por estudiante</label><input id='ai-r-msg' type='number' value='" + esc(ai.rate_limits.messages_per_day_student) + "' /></div>" +
          "<div class='ea-adm-field'><label>Tokens diarios por usuario</label><input id='ai-r-tok' type='number' value='" + esc(ai.rate_limits.tokens_per_day_user) + "' /></div>" +
          "<div class='ea-adm-field'><label>Máx. subida PDF (MB)</label><input id='ai-r-pdf' type='number' value='" + esc(ai.rate_limits.max_pdf_mb) + "' /></div>" +
          "<div class='ea-adm-field'><label>Presupuesto mensual institución (USD)</label><input id='ai-r-usd' type='number' value='" + esc(ai.rate_limits.monthly_institution_budget_usd) + "' /></div>" +
        "</div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>System Prompts y Pedagogía (Versionado)</h3>" +
        "<div class='ea-adm-form-grid'>" +
          "<div class='ea-adm-field'><label>Versión del Prompt</label><input id='ai-p-ver' value='" + esc(ai.prompts.version) + "' /></div>" +
          "<div class='ea-adm-field'><label>Adaptación de vocabulario por edad</label><select id='ai-p-age'>" +
            ["Básica (6-12 años)", "Media (13-17 años)", "Superior (18+ años)"].map(function (o) {
              return "<option " + (ai.prompts.age_adaptation === o ? "selected" : "") + ">" + esc(o) + "</option>";
            }).join("") +
          "</select></div>" +
        "</div>" +
        "<div class='ea-adm-switch-row'><span>Forzar Método Socrático (guiar sin dar respuesta directa)</span><input type='checkbox' id='ai-p-soc' " + (ai.prompts.socratic_mode ? "checked" : "") + " /></div>" +
        "<div class='ea-adm-field'><label>Instrucción base (System Prompt)</label><textarea id='ai-p-txt' rows='3'>" + esc(ai.prompts.system_prompt) + "</textarea></div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Guardrails, Integridad Académica y Alertas Tempranas</h3>" +
        "<div class='ea-adm-switch-row'><span>Filtro de contenido inapropiado, violencia y lenguaje ofensivo</span><input type='checkbox' id='ai-g-mod' " + (ai.guardrails.content_moderation ? "checked" : "") + " /></div>" +
        "<div class='ea-adm-switch-row'><span>Escudo anti Prompt-Injection</span><input type='checkbox' id='ai-g-inj' " + (ai.guardrails.prompt_injection_shield ? "checked" : "") + " /></div>" +
        "<div class='ea-adm-switch-row'><span>Alertas tempranas automáticas a Orientación / Bienestar</span><input type='checkbox' id='ai-g-al' " + (ai.guardrails.early_alert_wellness ? "checked" : "") + " /></div>" +
        "<div class='ea-adm-switch-row'><span><strong>Modo de Evaluación</strong> (restringe tutores en horario: " + esc(ai.guardrails.exam_mode_window) + ")</span><input type='checkbox' id='ai-g-exam' " + (ai.guardrails.exam_mode_enabled ? "checked" : "") + " /></div>" +
        "<button class='ea-adm-btn is-primary' id='btn-save-ai' style='margin-top:12px'>Guardar Gobernanza IA</button>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Bandeja de Alertas Tempranas (Orientación / Bienestar)</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Fecha</th><th>Curso</th><th>Señal detectada</th><th>Severidad</th><th>Estado</th></tr></thead><tbody>" +
        ai.early_alerts.map(function (a) {
          return "<tr><td>" + esc(a.date) + "</td><td>" + esc(a.course) + "</td><td>" + esc(a.category) + "</td><td><span class='ea-adm-badge " + (a.severity === "Alta" ? "is-danger" : "is-warn") + "'>" + esc(a.severity) + "</span></td><td>" + esc(a.status) + "</td></tr>";
        }).join("") +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function renderAnalyticsTab() {
    var s = state.realStats || {};
    return (
      "<div class='ea-adm-header'><div><h2>4. Analíticas, Monitoreo y Reportes</h2>" +
      "<p>Métricas reales de la base de datos, sesiones activas, adopción y control de costos IA.</p></div>" +
      "<div class='ea-adm-row-actions'>" +
        "<a class='ea-adm-btn' href='/api/admin/reports/export?kind=adoption' target='_blank'>CSV Adopción</a>" +
        "<a class='ea-adm-btn' href='/api/admin/reports/export?kind=costs' target='_blank'>CSV Costos IA</a>" +
        "<button class='ea-adm-btn is-primary' id='btn-print-pdf'>Exportar PDF</button>" +
      "</div></div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Unidades / Materiales (BD real)</div><div class='ea-adm-kpi-value'>" + esc(s.units || 0) + " / " + esc(s.materials || 0) + "</div><div class='ea-adm-kpi-sub'>Sesiones activas ahora: " + esc(s.active_sessions || 1) + "</div></div>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Evaluaciones e Intentos (BD real)</div><div class='ea-adm-kpi-value'>" + esc(s.quizzes || 0) + " / " + esc(s.attempts || 0) + "</div><div class='ea-adm-kpi-sub'>Preguntas revisadas: " + esc(s.questions || 0) + "</div></div>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Usuarios Activos (DAU / MAU)</div><div class='ea-adm-kpi-value'>0 / 0</div><div class='ea-adm-kpi-sub'>Sin historial previo · Listo para iniciar</div></div>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Consumo y Costo IA (Mes)</div><div class='ea-adm-kpi-value'>0 tok</div><div class='ea-adm-kpi-sub'>Costo est.: $0.00 USD · Latencia: 0 ms · Error: 0.0%</div></div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Analíticas Pedagógicas Agregadas (Privacidad preservada)</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Materia / Tema</th><th>Consultas (30 días)</th><th>Índice de dificultad</th><th>Estado</th></tr></thead><tbody>" +
          "<tr><td>Matemáticas · Probabilidad</td><td>0</td><td><span class='ea-adm-badge'>Sin datos</span></td><td>Listo para nuevas prácticas</td></tr>" +
          "<tr><td>Informática · Ciberseguridad y Desarrollo Web</td><td>0</td><td><span class='ea-adm-badge'>Sin datos</span></td><td>Listo para nuevas prácticas</td></tr>" +
          "<tr><td>Inteligencia Artificial · ML, Redes Neuronales e IA Generativa</td><td>0</td><td><span class='ea-adm-badge'>Sin datos</span></td><td>Listo para nuevas prácticas</td></tr>" +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function renderSecurityTab(d) {
    var sec = d.security_privacy;
    var logs = state.auditLogs.filter(function (l) {
      if (!state.auditFilter) return true;
      return (l.actor + " " + l.action + " " + l.target + " " + l.reason).toLowerCase().indexOf(state.auditFilter.toLowerCase()) !== -1;
    });
    return (
      "<div class='ea-adm-header'><div><h2>5. Seguridad, Privacidad y Auditoría</h2>" +
      "<p>Argon2id (OWASP), sesiones HttpOnly SHA-256, cabeceras CSP/HSTS, protección de menores y Audit Logs inmutables.</p></div>" +
      "<div class='ea-adm-row-actions'>" +
        "<a class='ea-adm-btn' href='/api/admin/reports/export?kind=audit' target='_blank'>Exportar Audit Log CSV</a>" +
        "<button class='ea-adm-btn is-primary' id='btn-create-backup'>Crear Backup SQLite Ahora</button>" +
      "</div></div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-card'><h3>Protección de Datos y Menores</h3>" +
          "<div class='ea-adm-switch-row'><span>Anonimizar PII antes de enviar a APIs externas</span><input type='checkbox' id='sec-anon' " + (sec.anonymize_pii ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-switch-row'><span>Enmascarar RUT / Cédula y correos automáticamente</span><input type='checkbox' id='sec-rut' " + (sec.strip_rut_dni ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-switch-row'><span>Exigir consentimiento de apoderados · <strong>" + esc(sec.guardian_consents_pct) + "%</strong></span><input type='checkbox' id='sec-cons' " + (sec.guardian_consent_required ? "checked" : "") + " /></div>" +
          "<div class='ea-adm-field' style='margin-top:8px'><label>Retención automática de historiales (días)</label><input id='sec-ret' type='number' value='" + esc(sec.chat_retention_days) + "' /></div>" +
          "<button class='ea-adm-btn is-primary' id='btn-save-sec'>Guardar Políticas</button>" +
        "</div>" +
        "<div class='ea-adm-card'><h3>Copias de Seguridad (Backups)</h3>" +
          "<p><small>Programación automática: <strong>" + esc(sec.backup_schedule) + "</strong></small></p>" +
          "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Archivo</th><th>Tamaño</th><th>Fecha</th></tr></thead><tbody>" +
          (sec.backups && sec.backups.length ? sec.backups.map(function (b) {
            return "<tr><td>" + esc(b.file) + "</td><td>" + esc(b.size_kb) + " KB</td><td><small>" + esc(b.created_at) + "</small></td></tr>";
          }).join("") : "<tr><td colspan='3'><small>Aún no hay respaldos manuales.</small></td></tr>") +
          "</tbody></table></div>" +
        "</div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Registro de Auditoría Inmutable (Audit Logs)</h3>" +
        "<div class='ea-adm-field'><input id='audit-search' placeholder='Filtrar por actor, acción, objetivo o motivo...' value='" + esc(state.auditFilter) + "' /></div>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>Fecha / Hora</th><th>Actor</th><th>Rol</th><th>Acción</th><th>Objetivo</th><th>Motivo / IP</th></tr></thead><tbody>" +
        logs.map(function (l) {
          return "<tr><td><small>" + esc(l.timestamp) + "</small></td><td>" + esc(l.actor) + "</td><td>" + esc(l.actor_role) + "</td><td><span class='ea-adm-badge'>" + esc(l.action) + "</span></td><td>" + esc(l.target) + "</td><td><small>" + esc(l.reason || "-") + " · " + esc(l.ip) + "</small></td></tr>";
        }).join("") +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function renderLicensingTab(d) {
    var lic = d.licensing;
    return (
      "<div class='ea-adm-header'><div><h2>6. Administración Comercial y Licenciamiento</h2>" +
      "<p>Gestión de planes SaaS, cupos de licencias, vigencia y Feature Flags.</p></div></div>" +
      "<div class='ea-adm-card'><h3>Plan y Licencias Institucionales</h3>" +
        "<div class='ea-adm-form-grid'>" +
          "<div class='ea-adm-field'><label>Plan activo</label><select id='lic-plan'>" +
            ["Gratuito", "Institucional", "Premium"].map(function (p) {
              return "<option " + (lic.plan === p ? "selected" : "") + ">" + esc(p) + "</option>";
            }).join("") +
          "</select></div>" +
          "<div class='ea-adm-field'><label>Cupos totales</label><input id='lic-seats' type='number' value='" + esc(lic.seats_total) + "' /></div>" +
          "<div class='ea-adm-field'><label>Vigencia hasta</label><input id='lic-valid' type='date' value='" + esc(lic.valid_until) + "' /></div>" +
        "</div>" +
        "<p>Cupos ocupados actualmente: <strong>" + esc(lic.seats_used) + " / " + esc(lic.seats_total) + "</strong></p>" +
      "</div>" +
      "<div class='ea-adm-card'><h3>Feature Flags (Módulos Beta y Premium)</h3>" +
        lic.feature_flags.map(function (f, idx) {
          return "<div class='ea-adm-switch-row'><div><strong>" + esc(f.name) + "</strong> <small>(" + esc(f.scope) + ")</small></div><input type='checkbox' data-ff-idx='" + idx + "' " + (f.enabled ? "checked" : "") + " /></div>";
        }).join("") +
        "<button class='ea-adm-btn is-primary' id='btn-save-lic' style='margin-top:12px'>Guardar Plan y Feature Flags</button>" +
      "</div>"
    );
  }

  function renderSiteTab(d) {
    var site = d.site_config;
    var h = state.health || {};
    var tickets = d.tickets.items || [];
    return (
      "<div class='ea-adm-header'><div><h2>7. Configuración Global del Sitio, Salud y Soporte</h2>" +
      "<p>Branding institucional, banners activos, modo mantenimiento real, Health Check en vivo y soporte.</p></div>" +
      "<button class='ea-adm-btn is-primary' id='btn-refresh-health'>Refrescar Health Check</button></div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Base de Datos (Netlify Blobs)</div><div class='ea-adm-kpi-value'>" + (h.database && h.database.ok ? "Online" : "Error") + "</div><div class='ea-adm-kpi-sub'>Latencia: " + esc(h.database ? h.database.latency_ms : "-") + " ms · Almacenamiento: " + esc(h.disk_free_gb || "Cloud Blobs") + "</div></div>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Motor IA (" + esc(h.ai_provider ? h.ai_provider.engine : "-") + ")</div><div class='ea-adm-kpi-value'>" + (h.ai_provider && h.ai_provider.configured ? "Conectado" : "Sin API Key") + "</div><div class='ea-adm-kpi-sub'>Modelo: " + esc(h.ai_provider ? h.ai_provider.model : "-") + "</div></div>" +
        "<div class='ea-adm-kpi'><div class='ea-adm-kpi-label'>Ciberseguridad + Núcleo Nativo</div><div class='ea-adm-kpi-value'>Argon2id + C++20</div><div class='ea-adm-kpi-sub'>" + (h.native_core && h.native_core.active ? ("C++20 Activo (" + esc(h.native_core.version) + ")") : "Python fallback") + " · HttpOnly · CSP · HSTS</div></div>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Personalización (Branding), Banner y Modo Mantenimiento</h3>" +
        "<div class='ea-adm-form-grid'>" +
          "<div class='ea-adm-field'><label>Nombre / Marca</label><input id='s-brand' value='" + esc(site.brand_name) + "' /></div>" +
          "<div class='ea-adm-field'><label>Dominio activo</label><input id='s-domain' value='" + esc(site.domain) + "' /></div>" +
          "<div class='ea-adm-field'><label>Color primario</label><input id='s-color' type='color' value='" + esc(site.primary_color) + "' /></div>" +
        "</div>" +
        "<div class='ea-adm-field'><label>Banner de anuncio global</label><input id='s-banner' value='" + esc(site.banner_text) + "' /></div>" +
        "<div class='ea-adm-switch-row'><span>Mostrar banner global en la plataforma</span><input type='checkbox' id='s-banner-on' " + (site.banner_active ? "checked" : "") + " /></div>" +
        "<div class='ea-adm-switch-row'><span><strong>Modo Mantenimiento</strong> (bloquea API y acceso a no-administradores)</span><input type='checkbox' id='s-maint' " + (site.maintenance_mode ? "checked" : "") + " /></div>" +
        "<button class='ea-adm-btn is-primary' id='btn-save-site' style='margin-top:12px'>Guardar Configuración del Sitio</button>" +
      "</div>" +

      "<div class='ea-adm-card'><h3>Mesa de Ayuda / Tickets y Feedback Negativo IA</h3>" +
        "<div class='ea-adm-table-wrap'><table class='ea-adm-table'><thead><tr><th>ID</th><th>Remitente</th><th>Tipo</th><th>Asunto</th><th>Estado</th><th>Acción</th></tr></thead><tbody>" +
        tickets.map(function (t, idx) {
          return "<tr><td>" + esc(t.id) + "</td><td>" + esc(t.from) + "</td><td>" + esc(t.type) + "</td><td>" + esc(t.subject) + "</td><td><span class='ea-adm-badge " + (t.status === "Resuelto" ? "is-ok" : "is-warn") + "'>" + esc(t.status) + "</span></td><td><button class='ea-adm-btn is-sm' data-toggle-tck='" + idx + "'>Cambiar estado</button></td></tr>";
        }).join("") +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function renderLimitsTab() {
    var transcriptHtml = state.chatTranscript
      ? "<div class='ea-adm-card' style='border-color:#0039a6;background:#f8faff'><h3>Extracto auditado (" + esc(state.chatTranscript.chat_id) + ")</h3>" +
        state.chatTranscript.transcript.map(function (m) {
          return "<p><strong>" + esc(m.sender) + ":</strong> " + esc(m.text) + "</p>";
        }).join("") +
        "<p><small>Acceso registrado en el Audit Log inmutable.</small></p></div>"
      : "";

    return (
      "<div class='ea-adm-header'><div><h2>8. Límites Recomendados para el Administrador</h2>" +
      "<p>Privacidad de chats con trazabilidad obligatoria y buenas prácticas de administración.</p></div></div>" +

      "<div class='ea-adm-grid'>" +
        "<div class='ea-adm-card'><h3>Alcance del Administrador</h3>" +
          "<p>Perfil activo en esta sesión: <strong>Administrador</strong> (" + esc(currentEmail()) + ").</p>" +
          "<ul style='margin:0;padding-left:18px;font-size:0.9rem;color:#2c3e66'>" +
            "<li><strong>Gestión integral:</strong> usuarios (Argon2id), cursos, repositorio RAG, prompts pedagógicos, APIs, costos, backups y seguridad.</li>" +
            "<li><strong>Trazabilidad:</strong> toda modificación queda registrada en el Audit Log inmutable con fecha, hora e IP.</li>" +
          "</ul>" +
        "</div>" +
        "<div class='ea-adm-card'><h3>Acceso Excepcional a Chats Privados</h3>" +
          "<p style='font-size:0.88rem;color:#556582'>Por privacidad, ningún administrador puede leer conversaciones libremente. Todo acceso excepcional exige motivo registrado.</p>" +
          "<div class='ea-adm-field'><label>ID de conversación con alerta/ticket</label><select id='chat-id-sel'><option value='CHAT-AL-101'>CHAT-AL-101 (Alerta Bienestar)</option><option value='CHAT-TCK-204'>CHAT-TCK-204 (Ticket Soporte)</option></select></div>" +
          "<div class='ea-adm-field'><label>Motivo obligatorio (mín. 8 caracteres)</label><input id='chat-reason' placeholder='Ej. Revisión por alerta temprana #101' /></div>" +
          "<button class='ea-adm-btn is-danger' id='btn-chat-access'>Registrar Motivo y Consultar Extracto</button>" +
        "</div>" +
      "</div>" +
      transcriptHtml
    );
  }

  function renderBody() {
    if (!state.data) return "<div class='ea-adm-card'>Cargando consola segura de administración...</div>";
    switch (state.activeTab) {
      case "users": return renderUsersTab(state.data);
      case "academic": return renderAcademicTab(state.data);
      case "ai": return renderAiTab(state.data);
      case "analytics": return renderAnalyticsTab();
      case "security": return renderSecurityTab(state.data);
      case "licensing": return renderLicensingTab(state.data);
      case "site": return renderSiteTab(state.data);
      case "limits": return renderLimitsTab();
      default: return "";
    }
  }

  function render() {
    var root = document.getElementById("ea-admin-console");
    if (!root) return;
    var navHtml = SECTIONS.map(function (s) {
      return "<button class='ea-adm-nav-item " + (state.activeTab === s.id ? "is-active" : "") + "' data-tab='" + s.id + "'>" + esc(s.title) + "</button>";
    }).join("");

    root.innerHTML =
      "<header class='ea-adm-topbar'>" +
        "<div class='ea-adm-brand'><span>EduAndes AI · Consola Admin</span><span class='ea-adm-pill'>" + esc(currentEmail()) + "</span></div>" +
        "<div class='ea-adm-top-actions'>" +
          "<span class='ea-adm-pill'>Administrador</span>" +
          "<button class='ea-adm-top-btn' id='ea-adm-go-app'>Ir a Plataforma</button>" +
          "<button class='ea-adm-top-btn is-logout' id='ea-adm-logout'>Cerrar sesión</button>" +
        "</div>" +
      "</header>" +
      "<div class='ea-adm-shell'>" +
        "<aside class='ea-adm-sidebar'>" + navHtml + "</aside>" +
        "<main class='ea-adm-main'>" + renderBody() + "</main>" +
      "</div>";

    bindEvents(root);
  }

  function bindEvents(root) {
    root.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.activeTab = btn.getAttribute("data-tab");
        render();
      });
    });

    var goApp = root.querySelector("#ea-adm-go-app");
    if (goApp) {
      goApp.addEventListener("click", function () {
        try { sessionStorage.setItem(ADMIN_VIEW_KEY, "0"); } catch (_) {}
        window.location.hash = "#/";
        mountOrUnmount();
      });
    }

    var logoutBtn = root.querySelector("#ea-adm-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        if (typeof window.__eduandesLogout === "function") {
          window.__eduandesLogout();
        } else {
          fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(function () {
            window.location.reload();
          });
        }
      });
    }

    var searchU = root.querySelector("#u-search");
    if (searchU) {
      searchU.addEventListener("input", function () {
        state.userFilter = searchU.value;
        render();
        var el = document.querySelector("#u-search");
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    }

    var searchA = root.querySelector("#audit-search");
    if (searchA) {
      searchA.addEventListener("input", function () {
        state.auditFilter = searchA.value;
        render();
        var el = document.querySelector("#audit-search");
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    }

    var btnAddUser = root.querySelector("#btn-add-user");
    if (btnAddUser) {
      btnAddUser.addEventListener("click", function () {
        var name = root.querySelector("#u-name").value.trim();
        var email = root.querySelector("#u-email").value.trim().toLowerCase();
        var password = root.querySelector("#u-pass").value;
        var role = root.querySelector("#u-role").value;
        var inst = root.querySelector("#u-inst").value.trim();
        api("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, email: email, password: password, role: role, institution: inst }),
        })
          .then(function (r) {
            state.data.users.accounts = r.accounts;
            state.auditLogs = r.audit_logs;
            showToast("Usuario creado con hash Argon2id.");
            render();
          })
          .catch(function (e) { showToast(e.message); });
      });
    }

    root.querySelectorAll("[data-del-student]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var sid = btn.getAttribute("data-del-student");
        var sname = btn.getAttribute("data-student-name") || sid;
        if (!window.confirm("¿Eliminar definitivamente al alumno '" + sname + "' y todo su historial?")) return;
        api("/api/admin/students/" + encodeURIComponent(sid), { method: "DELETE" })
          .then(function (r) {
            state.studentProfiles = r.student_profiles || [];
            state.auditLogs = r.audit_logs || state.auditLogs;
            showToast("Alumno eliminado: " + sname);
            render();
          })
          .catch(function (e) { showToast(e.message); });
      });
    });

    root.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        var id = btn.getAttribute("data-id");
        if (act === "reset-pw") {
          var newPw = window.prompt("Nueva contraseña para " + btn.getAttribute("data-email") + " (mín. 10 caracteres, mayúscula, minúscula, número y símbolo):");
          if (!newPw) return;
          return api("/api/admin/users/" + encodeURIComponent(id) + "/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_password: newPw }),
          })
            .then(function (r) { state.auditLogs = r.audit_logs; showToast("Contraseña actualizada (Argon2id) y sesiones cerradas."); render(); })
            .catch(function (e) { showToast(e.message); });
        }
        if (act === "toggle-status") {
          return api("/api/admin/users/" + encodeURIComponent(id) + "/toggle-status", { method: "POST" })
            .then(function (r) { state.data.users.accounts = r.accounts; state.auditLogs = r.audit_logs; showToast("Estado actualizado."); render(); })
            .catch(function (e) { showToast(e.message); });
        }
        if (act === "toggle-mfa") {
          return api("/api/admin/users/" + encodeURIComponent(id) + "/toggle-mfa", { method: "POST" })
            .then(function (r) { state.data.users.accounts = r.accounts; state.auditLogs = r.audit_logs; showToast("MFA actualizado."); render(); })
            .catch(function (e) { showToast(e.message); });
        }
        if (act === "del-user") {
          if (!window.confirm("¿Eliminar definitivamente esta cuenta?")) return;
          return api("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" })
            .then(function (r) { state.data.users.accounts = r.accounts; state.auditLogs = r.audit_logs; showToast("Cuenta eliminada."); render(); })
            .catch(function (e) { showToast(e.message); });
        }
      });
    });

    var btnRevoke = root.querySelector("#btn-revoke-all");
    if (btnRevoke) {
      btnRevoke.addEventListener("click", function () {
        api("/api/admin/sessions/revoke-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "Otras sesiones activas", reason: "Cierre remoto global" }),
        }).then(function (r) { showToast(r.message); loadAll(); }).catch(function (e) { showToast(e.message); });
      });
    }

    var btnSaveSso = root.querySelector("#btn-save-sso");
    if (btnSaveSso) {
      btnSaveSso.addEventListener("click", function () {
        state.data.users.sso_providers = {
          google_workspace: root.querySelector("#sso-google").checked,
          microsoft_365: root.querySelector("#sso-ms").checked,
          saml_oauth: root.querySelector("#sso-saml").checked,
          mfa_required_admins_teachers: root.querySelector("#sso-mfa").checked,
        };
        saveSection("users", state.data.users, "UPDATE_SSO_MFA", "SSO y MFA").catch(function (e) { showToast(e.message); });
      });
    }

    var btnCsv = root.querySelector("#btn-import-csv");
    if (btnCsv) {
      btnCsv.addEventListener("click", function () {
        var txt = "email,name,role,institution\n" + root.querySelector("#csv-import-box").value.trim();
        api("/api/admin/users/import-csv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv_text: txt }),
        })
          .then(function (r) { showToast("Importados " + r.added + " usuarios con Argon2id."); loadAll(); })
          .catch(function (e) { showToast(e.message); });
      });
    }

    var btnRbac = root.querySelector("#btn-save-rbac");
    if (btnRbac) {
      btnRbac.addEventListener("click", function () {
        root.querySelectorAll("[data-rbac-idx]").forEach(function (chk) {
          var idx = Number(chk.getAttribute("data-rbac-idx"));
          var role = chk.getAttribute("data-rbac-role");
          state.data.rbac.permissions[idx][role] = chk.checked;
        });
        saveSection("rbac", state.data.rbac, "UPDATE_RBAC_MATRIX", "Matriz de permisos").catch(function (e) { showToast(e.message); });
      });
    }

    var btnAddCourse = root.querySelector("#btn-add-course");
    if (btnAddCourse) {
      btnAddCourse.addEventListener("click", function () {
        var name = root.querySelector("#c-name").value.trim();
        if (!name) return showToast("Ingresa el nombre del curso.");
        state.data.academic.courses.push({
          id: "cur-" + Date.now(),
          name: name,
          level: root.querySelector("#c-level").value,
          teacher: root.querySelector("#c-teacher").value.trim(),
          students: Number(root.querySelector("#c-students").value || 0),
          tutor: "Tutor General",
        });
        saveSection("academic", state.data.academic, "CREATE_COURSE", name).catch(function (e) { showToast(e.message); });
      });
    }

    var btnAddRag = root.querySelector("#btn-add-rag");
    if (btnAddRag) {
      btnAddRag.addEventListener("click", function () {
        var title = root.querySelector("#rag-title").value.trim();
        if (!title) return showToast("Ingresa el título del documento.");
        state.data.rag_docs.documents.push({
          id: "doc-" + Date.now(),
          title: title,
          subject: root.querySelector("#rag-subj").value.trim() || "General",
          kind: root.querySelector("#rag-kind").value,
          pages: 18,
          status: "Indexado",
        });
        saveSection("rag_docs", state.data.rag_docs, "INDEX_CURRICULUM_DOC", title).catch(function (e) { showToast(e.message); });
      });
    }

    root.querySelectorAll("[data-del-doc]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-del-doc");
        state.data.rag_docs.documents = state.data.rag_docs.documents.filter(function (x) { return x.id !== id; });
        saveSection("rag_docs", state.data.rag_docs, "DELETE_CURRICULUM_DOC", id).catch(function (e) { showToast(e.message); });
      });
    });

    var btnSaveMods = root.querySelector("#btn-save-modules");
    if (btnSaveMods) {
      btnSaveMods.addEventListener("click", function () {
        root.querySelectorAll("[data-mod-idx]").forEach(function (chk) {
          state.data.academic.modules[Number(chk.getAttribute("data-mod-idx"))].enabled = chk.checked;
        });
        saveSection("academic", state.data.academic, "UPDATE_SUBJECT_MODULES", "Tutores por asignatura").catch(function (e) { showToast(e.message); });
      });
    }

    var btnSaveAi = root.querySelector("#btn-save-ai");
    if (btnSaveAi) {
      btnSaveAi.addEventListener("click", function () {
        var ai = state.data.ai_governance;
        ai.models.fast_chat = root.querySelector("#ai-m-fast").value.trim();
        ai.models.exam_generation = root.querySelector("#ai-m-exam").value.trim();
        ai.models.document_analysis = root.querySelector("#ai-m-doc").value.trim();
        ai.models.fallback_provider = root.querySelector("#ai-m-fb").value.trim();
        ai.rate_limits.messages_per_day_student = Number(root.querySelector("#ai-r-msg").value || 60);
        ai.rate_limits.tokens_per_day_user = Number(root.querySelector("#ai-r-tok").value || 45000);
        ai.rate_limits.max_pdf_mb = Number(root.querySelector("#ai-r-pdf").value || 8);
        ai.rate_limits.monthly_institution_budget_usd = Number(root.querySelector("#ai-r-usd").value || 120);
        ai.prompts.version = root.querySelector("#ai-p-ver").value.trim();
        ai.prompts.age_adaptation = root.querySelector("#ai-p-age").value;
        ai.prompts.socratic_mode = root.querySelector("#ai-p-soc").checked;
        ai.prompts.system_prompt = root.querySelector("#ai-p-txt").value.trim();
        ai.guardrails.content_moderation = root.querySelector("#ai-g-mod").checked;
        ai.guardrails.prompt_injection_shield = root.querySelector("#ai-g-inj").checked;
        ai.guardrails.early_alert_wellness = root.querySelector("#ai-g-al").checked;
        ai.guardrails.exam_mode_enabled = root.querySelector("#ai-g-exam").checked;
        saveSection("ai_governance", ai, "UPDATE_AI_GOVERNANCE", "Modelos, Prompt " + ai.prompts.version + " y Guardrails").catch(function (e) { showToast(e.message); });
      });
    }

    var btnPrint = root.querySelector("#btn-print-pdf");
    if (btnPrint) btnPrint.addEventListener("click", function () { window.print(); });

    var btnBkp = root.querySelector("#btn-create-backup");
    if (btnBkp) {
      btnBkp.addEventListener("click", function () {
        api("/api/admin/backups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Respaldo manual" }),
        }).then(function (r) { showToast("Backup creado: " + r.backup.file); loadAll(); }).catch(function (e) { showToast(e.message); });
      });
    }

    var btnSec = root.querySelector("#btn-save-sec");
    if (btnSec) {
      btnSec.addEventListener("click", function () {
        var sec = state.data.security_privacy;
        sec.anonymize_pii = root.querySelector("#sec-anon").checked;
        sec.strip_rut_dni = root.querySelector("#sec-rut").checked;
        sec.guardian_consent_required = root.querySelector("#sec-cons").checked;
        sec.chat_retention_days = Number(root.querySelector("#sec-ret").value || 90);
        saveSection("security_privacy", sec, "UPDATE_PRIVACY_POLICY", "Privacidad y menores").catch(function (e) { showToast(e.message); });
      });
    }

    var btnLic = root.querySelector("#btn-save-lic");
    if (btnLic) {
      btnLic.addEventListener("click", function () {
        var lic = state.data.licensing;
        lic.plan = root.querySelector("#lic-plan").value;
        lic.seats_total = Number(root.querySelector("#lic-seats").value || 250);
        lic.valid_until = root.querySelector("#lic-valid").value;
        root.querySelectorAll("[data-ff-idx]").forEach(function (chk) {
          lic.feature_flags[Number(chk.getAttribute("data-ff-idx"))].enabled = chk.checked;
        });
        saveSection("licensing", lic, "UPDATE_LICENSING", "Plan " + lic.plan).catch(function (e) { showToast(e.message); });
      });
    }

    var btnHealth = root.querySelector("#btn-refresh-health");
    if (btnHealth) {
      btnHealth.addEventListener("click", function () {
        api("/api/admin/health").then(function (h) { state.health = h; showToast("Health Check actualizado."); render(); }).catch(function (e) { showToast(e.message); });
      });
    }

    var btnSite = root.querySelector("#btn-save-site");
    if (btnSite) {
      btnSite.addEventListener("click", function () {
        var site = state.data.site_config;
        site.brand_name = root.querySelector("#s-brand").value.trim();
        site.domain = root.querySelector("#s-domain").value.trim();
        site.primary_color = root.querySelector("#s-color").value;
        site.banner_text = root.querySelector("#s-banner").value.trim();
        site.banner_active = root.querySelector("#s-banner-on").checked;
        site.maintenance_mode = root.querySelector("#s-maint").checked;
        saveSection("site_config", site, "UPDATE_SITE_CONFIG", site.domain).catch(function (e) { showToast(e.message); });
      });
    }

    root.querySelectorAll("[data-toggle-tck]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var t = state.data.tickets.items[Number(btn.getAttribute("data-toggle-tck"))];
        t.status = t.status === "Abierto" ? "Resuelto" : "Abierto";
        saveSection("tickets", state.data.tickets, "UPDATE_TICKET", t.id).catch(function (e) { showToast(e.message); });
      });
    });

    var btnChat = root.querySelector("#btn-chat-access");
    if (btnChat) {
      btnChat.addEventListener("click", function () {
        var chatId = root.querySelector("#chat-id-sel").value;
        var reason = root.querySelector("#chat-reason").value.trim();
        if (reason.length < 8) return showToast("Debes indicar un motivo detallado (mín. 8 caracteres).");
        api("/api/admin/chat-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, reason: reason }),
        }).then(function (r) { state.chatTranscript = r; showToast("Acceso auditado en el Audit Log."); loadAll(); }).catch(function (e) { showToast(e.message); });
      });
    }
  }

  window.addEventListener("hashchange", mountOrUnmount);
  window.addEventListener("eduandes-auth-changed", mountOrUnmount);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountOrUnmount);
  } else {
    mountOrUnmount();
  }
})();

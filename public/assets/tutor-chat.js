(function () {
  "use strict";

  var AUTH_WELCOME_KEY = "eduandes.welcome.entered";
  var state = {
    open: false,
    loading: false,
    courses: [],
    selectedCourseId: "",
    messages: [],
  };

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isLoggedIn() {
    try {
      return sessionStorage.getItem(AUTH_WELCOME_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function isBlockedScreen() {
    if (!isLoggedIn()) return true;
    if (document.documentElement.classList.contains("ea-welcome-open")) return true;
    if (document.getElementById("ea-admin-console")) return true;
    if (document.getElementById("ea-maintenance-overlay")) return true;
    return false;
  }

  function getActiveCourseId() {
    if (state.selectedCourseId) return state.selectedCourseId;
    try {
      return localStorage.getItem("educore.course-id") || "";
    } catch (_) {
      return "";
    }
  }

  function getActiveUnitId() {
    try {
      var storedCourse = localStorage.getItem("educore.course-id") || "";
      if (!state.selectedCourseId || state.selectedCourseId === storedCourse) {
        return localStorage.getItem("educore.unit-id") || "";
      }
    } catch (_) {}
    return "";
  }

  function suggestionsFor(course) {
    var code = ((course && course.code) || "").toUpperCase();
    if (code.indexOf("MAT") !== -1) {
      return [
        "¿Qué es la probabilidad de un evento?",
        "Explícame un ejemplo práctico con juegos de azar",
        "¿Cómo se relacionan los casos favorables y posibles?",
      ];
    }
    if (code.indexOf("INF") !== -1) {
      return [
        "¿Qué controles propone la norma ISO/IEC 27001?",
        "¿Cuál es la diferencia entre autenticación y autorización?",
        "¿Cómo protege Microsoft Purview la información?",
      ];
    }
    return [
      "¿Qué es una red neuronal artificial y cómo aprende?",
      "¿Qué diferencia el aprendizaje supervisado del no supervisado?",
      "¿Cuáles son las principales aplicaciones de la IA generativa?",
    ];
  }

  function loadCourses() {
    if (!isLoggedIn()) return Promise.resolve();
    return fetch("/api/courses", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        if (Array.isArray(list)) {
          state.courses = list;
          var cur = getActiveCourseId();
          var exists = list.some(function (c) { return c.id === cur; });
          if (!exists && list.length) {
            state.selectedCourseId = list[0].id;
          } else if (cur) {
            state.selectedCourseId = cur;
          }
        }
      })
      .catch(function () {});
  }

  function formatReply(text) {
    return esc(text)
      .replace(/^###\s*(.+)$/gm, "<strong>$1</strong>")
      .replace(/^##\s*(.+)$/gm, "<strong>$1</strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .replace(/\n/g, "<br>");
  }

  function renderWidget() {
    var host = document.getElementById("ea-tutor-root");
    if (isBlockedScreen()) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "ea-tutor-root";
      document.body.appendChild(host);
    }

    var activeCourse = state.courses.find(function (c) { return c.id === getActiveCourseId(); }) || state.courses[0] || null;
    var chips = suggestionsFor(activeCourse);

    var courseOpts =
      "<option value=''" + (!state.selectedCourseId ? " selected" : "") + ">Todas las asignaturas</option>" +
      state.courses.map(function (c) {
        return "<option value='" + esc(c.id) + "' " + (c.id === state.selectedCourseId ? "selected" : "") + ">" + esc(c.code + " · " + c.title) + "</option>";
      }).join("");

    var msgsHtml = state.messages.length
      ? state.messages.map(function (m) {
          return (
            "<div class='ea-bot-msg is-" + m.role + "'>" +
              "<div class='ea-bot-bubble'>" + formatReply(m.content) + "</div>" +
            "</div>"
          );
        }).join("")
      : (
        "<div class='ea-bot-welcome'>" +
          "<p><strong>¡Hola! Soy AndesBot</strong>, tu tutor IA binacional (Chile – Ecuador).</p>" +
          "<p>Pregúntame cualquier duda sobre el tema que estés estudiando y te explicaré de forma clara y concisa.</p>" +
          "<div class='ea-bot-chips'>" +
            chips.map(function (q) {
              return "<button type='button' class='ea-bot-chip' data-bot-q='" + esc(q) + "'>" + esc(q) + "</button>";
            }).join("") +
          "</div>" +
        "</div>"
      );

    var typingHtml = state.loading
      ? "<div class='ea-bot-msg is-assistant'><div class='ea-bot-bubble is-typing'>Pensando una explicación clara...</div></div>"
      : "";

    var panelHtml = state.open
      ? (
        "<section class='ea-bot-panel' role='dialog' aria-label='Chat Tutor AndesBot'>" +
          "<header class='ea-bot-head'>" +
            "<div class='ea-bot-head-left'>" +
              "<span class='ea-bot-avatar-sm'><img src='/assets/eduandes-bot.jpg' alt='AndesBot' /></span>" +
              "<div><strong>AndesBot · Tutor IA</strong><small>Groq IA · Asistente Chile–Ecuador</small></div>" +
            "</div>" +
            "<div class='ea-bot-head-actions'>" +
              "<button type='button' class='ea-bot-icon-btn' id='ea-bot-clear' title='Limpiar conversación'>&#8635;</button>" +
              "<button type='button' class='ea-bot-icon-btn' id='ea-bot-close' aria-label='Cerrar chat'>&times;</button>" +
            "</div>" +
          "</header>" +
          "<div class='ea-bot-ctx-bar'>" +
            "<label for='ea-bot-course-sel'>Tema:</label>" +
            "<select id='ea-bot-course-sel'>" + courseOpts + "</select>" +
          "</div>" +
          "<div class='ea-bot-body' id='ea-bot-body'>" + msgsHtml + typingHtml + "</div>" +
          "<form class='ea-bot-form' id='ea-bot-form'>" +
            "<input id='ea-bot-input' type='text' maxlength='1000' placeholder='Escribe tu pregunta sobre el tema...' autocomplete='off' " + (state.loading ? "disabled" : "") + " />" +
            "<button type='submit' class='ea-bot-send' " + (state.loading ? "disabled" : "") + ">Enviar</button>" +
          "</form>" +
        "</section>"
      )
      : "";

    var fabHtml =
      "<button type='button' class='ea-bot-fab " + (state.open ? "is-open" : "") + "' id='ea-bot-fab' aria-label='Abrir chat tutor AndesBot' title='Pregunta a AndesBot (Tutor IA)'>" +
        "<img src='/assets/eduandes-bot.jpg' alt='AndesBot Chile Ecuador' />" +
        "<span class='ea-bot-pulse' aria-hidden='true'></span>" +
      "</button>";

    host.innerHTML = panelHtml + fabHtml;

    var bodyEl = host.querySelector("#ea-bot-body");
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;

    var fab = host.querySelector("#ea-bot-fab");
    if (fab) {
      fab.addEventListener("click", function () {
        state.open = !state.open;
        if (state.open && !state.courses.length) {
          loadCourses().then(renderWidget);
        } else {
          renderWidget();
        }
      });
    }

    var closeBtn = host.querySelector("#ea-bot-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        state.open = false;
        renderWidget();
      });
    }

    var clearBtn = host.querySelector("#ea-bot-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        state.messages = [];
        renderWidget();
      });
    }

    var sel = host.querySelector("#ea-bot-course-sel");
    if (sel) {
      sel.addEventListener("change", function () {
        state.selectedCourseId = sel.value;
        renderWidget();
      });
    }

    host.querySelectorAll("[data-bot-q]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        sendQuestion(chip.getAttribute("data-bot-q") || "");
      });
    });

    var form = host.querySelector("#ea-bot-form");
    var inp = host.querySelector("#ea-bot-input");
    if (form && inp) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var text = (inp.value || "").trim();
        if (!text || state.loading) return;
        sendQuestion(text);
      });
      if (state.open && !state.loading) {
        setTimeout(function () { if (inp) inp.focus(); }, 30);
      }
    }
  }

  function sendQuestion(text) {
    if (!text || state.loading) return;
    var history = state.messages.slice(-6).map(function (m) {
      return { role: m.role, content: m.content };
    });
    state.messages.push({ role: "user", content: text });
    state.loading = true;
    renderWidget();

    fetch("/api/tutor/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        course_id: getActiveCourseId() || null,
        unit_id: getActiveUnitId() || null,
        history: history,
      }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.detail || "No se pudo consultar al tutor IA.");
          return data;
        });
      })
      .then(function (data) {
        state.loading = false;
        state.messages.push({
          role: "assistant",
          content: data.reply || "No recibí respuesta del tutor.",
        });
        renderWidget();
      })
      .catch(function (err) {
        state.loading = false;
        state.messages.push({
          role: "assistant",
          content: "⚠️ " + (err && err.message ? err.message : "Error de conexión con el tutor IA."),
        });
        renderWidget();
      });
  }

  function syncMount() {
    if (isBlockedScreen()) {
      var host = document.getElementById("ea-tutor-root");
      if (host) host.remove();
      return;
    }
    if (!state.courses.length) {
      loadCourses().then(renderWidget);
    } else {
      renderWidget();
    }
  }

  window.addEventListener("eduandes-auth-changed", syncMount);
  window.addEventListener("hashchange", syncMount);
  var obs = new MutationObserver(function () {
    var shouldHide = isBlockedScreen();
    var hasHost = !!document.getElementById("ea-tutor-root");
    if (shouldHide && hasHost) renderWidget();
    else if (!shouldHide && !hasHost) syncMount();
  });

  function init() {
    syncMount();
    if (document.body) obs.observe(document.body, { childList: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

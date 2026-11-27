(function () {
  "use strict";
  var rawFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  if (!rawFetch) return;
  window.__eduandesRawFetch = rawFetch;

  function urlPath(input) {
    try {
      var u = typeof input === "string" ? input : (input && input.url) || "";
      return new URL(u, window.location.origin).pathname;
    } catch (_) {
      return "";
    }
  }

  function isSessionReady() {
    try {
      return sessionStorage.getItem("eduandes.welcome.entered") === "1";
    } catch (_) {
      return false;
    }
  }

  function jsonOk(payload) {
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  window.fetch = function (input, init) {
    var path = urlPath(input);
    var opts = Object.assign({ credentials: "same-origin" }, init || {});

    // Evitar los 3 errores 401 iniciales de React antes de iniciar sesión
    if (!isSessionReady() && path.indexOf("/api/") === 0 && path.indexOf("/api/auth/") !== 0 && path !== "/api/health") {
      if (path === "/api/courses" || path === "/api/students") return jsonOk([]);
      if (path === "/api/engine/status") return jsonOk({ mode: "openai_compat", question_engine: { state: "listo" } });
      return jsonOk({});
    }

    return rawFetch(input, opts).then(function (res) {
      if (res && res.ok && path === "/api/engine/status") {
        try {
          res.clone().json().then(function (d) {
            window.__eduandesEngineStatus = d;
            window.dispatchEvent(new CustomEvent("eduandes-engine-status", { detail: d }));
          }).catch(function () {});
        } catch (_) {}
      }
      return res;
    });
  };
})();

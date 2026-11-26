// Registro de eventos e erros (executa no mundo da página).
// Cada entrada é guardada na memória e enviada ao bridge.js, que a persiste em chrome.storage.
(() => {
  const WAAS = (window.WAAS = window.WAAS || {});
  if (WAAS.log) return;

  WAAS.VERSION = "0.7.2";
  WAAS.sessionId = Math.random().toString(36).slice(2, 10);
  WAAS.entries = [];
  WAAS.activeRun = null; // id da operação em andamento (criar/enviar)
  const MAX_MEM = 3000;
  const listeners = new Set();

  function maskIds(s) {
    // Oculta números longos (telefones, ids de grupo) deixando os 3 últimos dígitos.
    return s.replace(/\d{7,}/g, (m) => "…" + m.slice(-3));
  }

  function sanitize(value, depth = 0) {
    if (value == null) return value;
    if (depth > 4) return "[profundidade máxima]";
    if (value instanceof Error || (value && typeof value === "object" && "stack" in value && "message" in value)) {
      return { name: value.name, message: maskIds(String(value.message)), stack: maskIds(String(value.stack || "")).slice(0, 4000) };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) return { blob: true, size: value.size, type: value.type };
    if (value instanceof ArrayBuffer) return { arrayBuffer: value.byteLength };
    if (ArrayBuffer.isView(value)) return { bytes: value.byteLength };
    if (typeof value === "string") return maskIds(value.length > 3000 ? value.slice(0, 3000) + "…" : value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function") return "[função " + (value.name || "anônima") + "]";
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
    if (typeof value === "object") {
      const out = {};
      let n = 0;
      for (const k of Object.keys(value)) {
        if (n++ > 60) { out["…"] = "demais chaves omitidas"; break; }
        try { out[k] = sanitize(value[k], depth + 1); } catch (e) { out[k] = "[ilegível]"; }
      }
      return out;
    }
    return String(value);
  }

  function log(level, event, data) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      run: WAAS.activeRun,
      session: WAAS.sessionId,
      data: sanitize(data),
    };
    WAAS.entries.push(entry);
    if (WAAS.entries.length > MAX_MEM) WAAS.entries.splice(0, WAAS.entries.length - MAX_MEM);
    try { window.postMessage({ __waas: "log", entry }, location.origin); } catch (e) { /* sem bridge */ }
    // Só console.debug: console.warn/error fariam o evento aparecer na página de erros de
    // chrome://extensions como se fosse uma falha da extensão. O nível fica guardado no registro.
    console.debug("[WAAS]", level, event, entry.data ?? "");
    for (const l of listeners) { try { l(entry); } catch (e) { /* ignorar */ } }
    return entry;
  }

  WAAS.log = log;
  WAAS.info = (event, data) => log("info", event, data);
  WAAS.warn = (event, data) => log("warn", event, data);
  WAAS.error = (event, data) => log("error", event, data);
  WAAS.onLog = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  WAAS.maskIds = maskIds;

  // Executa fn dentro de uma "operação" com id próprio; registra início, fim, duração e erro.
  WAAS.run = async function (name, fn) {
    const prev = WAAS.activeRun;
    const id = name + "-" + Date.now().toString(36);
    WAAS.activeRun = id;
    const t0 = performance.now();
    log("info", name + ":inicio", null);
    try {
      const r = await fn();
      log("info", name + ":fin", { ms: Math.round(performance.now() - t0) });
      return r;
    } catch (err) {
      log("error", name + ":error", { ms: Math.round(performance.now() - t0), error: err });
      throw err;
    } finally {
      WAAS.activeRun = prev;
    }
  };

  // Erros globais: são registrados se vierem da extensão ou se houver uma operação em andamento.
  const EXT_MARK = "chrome-extension://";
  window.addEventListener("error", (ev) => {
    const stack = (ev.error && ev.error.stack) || "";
    const fromExt = (ev.filename || "").startsWith(EXT_MARK) || stack.includes(EXT_MARK);
    if (!fromExt && !WAAS.activeRun) return;
    log("error", fromExt ? "error-global-extension" : "error-global-pagina", {
      message: ev.message, file: ev.filename, line: ev.lineno, col: ev.colno, error: ev.error,
    });
  }, true);
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    const stack = (r && r.stack) || "";
    const fromExt = stack.includes(EXT_MARK);
    if (!fromExt && !WAAS.activeRun) return;
    log("error", fromExt ? "promesa-rechazada-extension" : "promesa-rechazada-pagina", { reason: r });
  });

  // Pede o registro completo persistido (via bridge). Devolve [] se não houver resposta.
  WAAS.getStoredLog = function () {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 3000);
      function onMsg(ev) {
        const d = ev.data;
        if (ev.source !== window || !d || d.__waas !== "logResponse" || d.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(d.log || []);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ __waas: "getLog", reqId }, location.origin);
    });
  };

  log("info", "logger:listo", { version: WAAS.VERSION, url: location.href, ua: navigator.userAgent });
})();

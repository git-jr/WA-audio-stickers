// Inicialização: espera o WhatsApp Web terminar de carregar, registra um diagnóstico e monta o botão.
(() => {
  const WAAS = window.WAAS;
  if (!WAAS || WAAS._started) return;
  WAAS._started = true;

  async function waitForWA(maxMs = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        if (WAAS.wa.hasLoader()) {
          const CC = WAAS.wa.ns("WAWebChatCollection");
          if (CC && CC.ChatCollection) return Date.now() - t0;
        }
      } catch (e) { /* ainda carregando */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("O WhatsApp Web não terminou de carregar em 3 minutos (a sessão foi encerrada ou o código mudou?)");
  }

  (async () => {
    try {
      WAAS.mountUI(); // o botão aparece mesmo que o WA não esteja pronto, para poder salvar o registro
    } catch (e) {
      WAAS.error("ui:error-montaje", e);
    }
    try {
      const ms = await waitForWA();
      WAAS.info("wa:listo", { ms });
      // As opções (AB props) da conta chegam alguns segundos depois de a interface carregar.
      await new Promise((r) => setTimeout(r, 8000));
      await WAAS.wa.diagnose();
    } catch (e) {
      WAAS.error("wa:no-listo", e);
    }
  })();
})();

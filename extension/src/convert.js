// Conversão no navegador: vídeo, GIF ou imagem + áudio -> figurinha WebP + áudio Ogg/Opus (formato do WhatsApp).
// Não depende do WhatsApp; usa <video>, ImageDecoder (GIF), canvas (WebP), WebAudio e WebCodecs.
(() => {
  const WAAS = (window.WAAS = window.WAAS || {});
  const log = (lvl, ev, data) => (WAAS.log ? WAAS.log(lvl, ev, data) : console.log(ev, data));

  const SIDE = 512;                    // lado máximo (o WhatsApp usa 512; maior que isso não fica melhor e pesa 4 vezes mais)
  const MAX_STICKER_BYTES = 1_000_000; // o servidor do WhatsApp rejeita figurinhas maiores (HTTP 413)
  const SAFE_BYTES = 900_000;          // margem para a estimativa (verde = estimado ≤ 900 KB)
  const MAX_AUDIO_BYTES = 1_000_000;   // limite do WhatsApp Web para o áudio da figurinha
  const SAMPLE_RATE = 48000;
  const CAPTURE_MEM_BYTES = 320e6;     // memória máxima para os quadros capturados (10 s a 30 fps cabem a 512 px)
  const SIDES = [512, 448, 384, 320, 256, 224, 192, 160, 128, 96, 64];
  const FPS_LIST = [30, 25, 20, 15, 12, 10, 8, 6, 5];
  const Q_MIN = 0.15;
  // Qualidade WebP por lado: com menos pixels convém comprimir menos.
  const Q_BY_SIDE = { 512: 0.75, 448: 0.7, 384: 0.65, 320: 0.6, 256: 0.55, 224: 0.55, 192: 0.5, 160: 0.5, 128: 0.45, 96: 0.45, 64: 0.4 };

  // Preferência para a opção automática: a fluidez pesa mais que a resolução (na tela uma
  // figurinha é pequena), mas sem descer de ~160 px a menos que não haja outra saída.
  // Mais de 20 fps quase não acrescenta (só desempata); descer de 192 px penaliza.
  const FPS_SCORE = { 30: 101, 25: 100.5, 20: 100, 15: 80, 12: 55, 10: 40, 8: 25, 6: 12, 5: 5 };
  function score(side, fps) {
    return (FPS_SCORE[fps] || 0) + (40 * side) / 512 - (side < 192 ? (192 - side) / 3 : 0);
  }

  // fps de captura conforme a duração: o que pode chegar a caber em 1 MB.
  function captureFpsFor(dur) {
    return dur <= 10 ? 30 : dur <= 20 ? 25 : dur <= 40 ? 20 : dur <= 80 ? 15 : 12;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const te = new TextEncoder();

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException("Cancelado pelo usuário", "AbortError");
  }

  // ---------------------------------------------------------------- vídeo
  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      const url = URL.createObjectURL(file);
      const timer = setTimeout(() => reject(new Error("Tempo esgotado ao carregar o vídeo")), 30000);
      v.onloadeddata = async () => {
        clearTimeout(timer);
        // Alguns vídeos cortados mantêm marcas de tempo que não começam em 0
        // (p. ex., começam em 130 s). O Chrome se posiciona no primeiro quadro: essa é a defasagem.
        v._waasOffset = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        if (v.readyState < 4) {
          await new Promise((r) => { const t = setTimeout(r, 5000); v.addEventListener("canplaythrough", () => { clearTimeout(t); r(); }, { once: true }); });
        }
        // O Chrome só corrige a duração quando chega ao final do arquivo: pula-se para o final
        // enquanto a duração continuar crescendo, e depois volta-se ao início.
        const seekWait = (t) => new Promise((r) => {
          const to = setTimeout(r, 3000);
          v.addEventListener("seeked", () => { clearTimeout(to); r(); }, { once: true });
          v.currentTime = t;
        });
        const initialDuration = v.duration;
        for (let i = 0; i < 8 && Number.isFinite(v.duration); i++) {
          const d = v.duration;
          await seekWait(Math.max(0, d - 0.01));
          await sleep(40);
          if (!(v.duration > d + 0.01)) break;
        }
        await seekWait(v._waasOffset);
        if (v.duration !== initialDuration) log("info", "video:duracion-corregida", { inicial: initialDuration, final: v.duration, desfase: v._waasOffset });
        resolve(v);
      };
      v.onerror = () => {
        clearTimeout(timer);
        const e = v.error;
        reject(new Error("O navegador não conseguiu ler o vídeo" + (e ? ` (código ${e.code}: ${e.message || "formato não suportado"})` : "")));
      };
      v.src = url;
      v._waasUrl = url;
    });
  }

  function seek(v, t) {
    return new Promise((resolve, reject) => {
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return resolve();
      const timer = setTimeout(() => { v.removeEventListener("seeked", done); reject(new Error(`Tempo esgotado ao buscar o segundo ${t.toFixed(2)}`)); }, 8000);
      function done() { clearTimeout(timer); resolve(); }
      v.addEventListener("seeked", done, { once: true });
      v.currentTime = t;
    });
  }

  // Dimensões de qualquer fonte desenhável: <video>, VideoFrame (GIF) ou ImageBitmap (imagem).
  const srcW = (s) => s.videoWidth || s.displayWidth || s.width;
  const srcH = (s) => s.videoHeight || s.displayHeight || s.height;

  function drawFrame(ctx, v, mode, side) {
    const vw = srcW(v), vh = srcH(v);
    ctx.clearRect(0, 0, side, side);
    const s = mode === "recortar" ? Math.max(side / vw, side / vh) : Math.min(side / vw, side / vh);
    const w = vw * s, h = vh * s;
    ctx.drawImage(v, (side - w) / 2, (side - h) / 2, w, h);
  }

  async function probeVideo(file) {
    const v = await loadVideo(file);
    try {
      const offset = v._waasOffset || 0;
      return { duration: v.duration - offset, offset, width: v.videoWidth, height: v.videoHeight };
    } finally {
      URL.revokeObjectURL(v._waasUrl);
    }
  }

  function makeSnapper(side, mode) {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext("2d");
    const fpCanvas = new OffscreenCanvas(32, 32);
    const fpCtx = fpCanvas.getContext("2d", { willReadFrequently: true });
    return (v) => {
      drawFrame(ctx, v, mode, side);
      fpCtx.clearRect(0, 0, 32, 32);
      fpCtx.drawImage(canvas, 0, 0, 32, 32);
      const fp = fpCtx.getImageData(0, 0, 32, 32).data;
      return { bmpPromise: createImageBitmap(canvas), fp, used: false };
    };
  }

  // Captura reproduzindo o vídeo e pegando cada quadro exibido (requestVideoFrameCallback).
  // É muito mais rápida que pular quadro a quadro em vídeos longos.
  function captureByPlayback(v, t0, dur, fps, side, mode, onProgress, signal) {
    return new Promise((resolve, reject) => {
      if (typeof v.requestVideoFrameCallback !== "function") return reject(new Error("sem requestVideoFrameCallback"));
      const n = Math.max(1, Math.round(dur * fps));
      const T = Array.from({ length: n }, (_, k) => t0 + (k + 0.5) / fps);
      const tEnd = t0 + dur;
      const slots = new Array(n);
      const snap = makeSnapper(side, mode);
      let next = 0, last = null, pendingFirst = 0, done = false, presented = 0;
      // O elemento é anexado ao documento (quase invisível) para que o Chrome componha os quadros dele.
      v.style.cssText = "position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1";
      document.body.appendChild(v);
      let watchdog = setTimeout(() => finish(new Error("A reprodução não entregou quadros")), 4000);
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        v.pause();
        v.remove();
        if (err) {
          for (const s of new Set(slots.filter(Boolean).concat(last ? [last] : []))) s.bmpPromise.then((b) => b.close());
          return reject(err);
        }
        while (next < n && last) slots[next++] = last;
        if (last) last.used = true;
        resolve({ slots, presented });
      };
      const cb = (now, meta) => {
        if (done) return;
        if (signal && signal.aborted) return finish(new DOMException("Cancelado pelo usuário", "AbortError"));
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(new Error("A reprodução parou")), 4000);
        presented++;
        const mt = meta.mediaTime;
        // Os pontos de amostragem anteriores a este quadro pertencem ao quadro anterior.
        while (next < n && T[next] < mt - 1e-4) {
          if (last) { slots[next++] = last; last.used = true; } else { pendingFirst++; next++; }
        }
        if (last && !last.used) last.bmpPromise.then((b) => b.close());
        last = snap(v);
        if (pendingFirst) { for (let i = 0; i < pendingFirst; i++) slots[i] = last; last.used = true; pendingFirst = 0; }
        if (onProgress && presented % 10 === 0) onProgress(`Lendo quadros ${next}/${n}`, next / n);
        if (next >= n || mt >= tEnd || v.ended) return finish();
        v.requestVideoFrameCallback(cb);
      };
      v.addEventListener("ended", () => finish(), { once: true });
      seek(v, t0).then(() => {
        v.requestVideoFrameCallback(cb);
        v.playbackRate = 1;
        return v.play();
      }).catch((e) => finish(e));
    });
  }

  // Captura pulando quadro a quadro (reserva, mais lenta, mas não depende da reprodução).
  async function captureBySeeking(v, t0, dur, fps, side, mode, onProgress, signal) {
    const n = Math.max(1, Math.round(dur * fps));
    const snap = makeSnapper(side, mode);
    const maxT = Math.max(0, v.duration - 0.001);
    const slots = [];
    for (let i = 0; i < n; i++) {
      checkAbort(signal);
      // Pega-se o quadro no meio de cada intervalo: se o salto cair exatamente na borda entre
      // dois quadros, o navegador às vezes devolve o anterior e perdem-se quadros.
      await seek(v, Math.min(t0 + (i + 0.5) / fps, maxT));
      const s = snap(v);
      s.used = true;
      slots.push(s);
      if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress(`Lendo quadros ${i + 1}/${n}`, (i + 1) / n);
    }
    return { slots, presented: n };
  }

  // Por padrão pula-se quadro a quadro: é mais lento, porém exato (cada instante recebe seu quadro).
  // A reprodução fica como reserva caso um salto trave.
  async function captureFrames(file, start, dur, fps, side, mode, onProgress, signal, method = "saltos") {
    const t0 = performance.now();
    let v = await loadVideo(file);
    try {
      if (!v.videoWidth || !v.videoHeight) throw new Error("O vídeo não tem imagem (é só áudio?)");
      const offset = v._waasOffset || 0;
      const methods = method === "reproduccion" ? ["reproduccion", "saltos"] : ["saltos", "reproduccion"];
      let res, metodo;
      for (let i = 0; i < methods.length; i++) {
        metodo = methods[i];
        try {
          res = metodo === "saltos"
            ? await captureBySeeking(v, offset + start, dur, fps, side, mode, onProgress, signal)
            : await captureByPlayback(v, offset + start, dur, fps, side, mode, onProgress, signal);
          break;
        } catch (e) {
          if ((e && e.name === "AbortError") || i === methods.length - 1) throw e;
          log("info", "video:captura-respaldo", { fallo: metodo, motivo: String(e && e.message || e) });
          URL.revokeObjectURL(v._waasUrl);
          v = await loadVideo(file);
        }
      }
      // Resolver os bitmaps e eliminar referências duplicadas.
      const frames = [];
      const cache = new Map();
      for (const s of res.slots) {
        if (!cache.has(s)) cache.set(s, { bmp: await s.bmpPromise, fp: s.fp });
        frames.push(cache.get(s));
      }
      let unique = 0;
      for (let i = 0; i < frames.length; i++) if (i === 0 || !sameBytes(frames[i].fp, frames[i - 1].fp)) unique++;
      log("info", "video:cuadros", { metodo, cuadros: frames.length, distintos: unique, mostrados: res.presented, fpsCaptura: fps, ladoCaptura: side, ms: Math.round(performance.now() - t0), ancho: v.videoWidth, alto: v.videoHeight, duracionVideo: v.duration, desfase: offset });
      if (offset > 0) log("info", "video:desfase", `O vídeo começa em ${offset.toFixed(3)} s; foi compensado`);
      return frames;
    } finally {
      URL.revokeObjectURL(v._waasUrl);
      v.removeAttribute("src");
      v.load();
    }
  }

  // ---------------------------------------------------------------- GIF e imagens
  // GIF, WebP animado e APNG são decodificados com ImageDecoder (WebCodecs): o <video> não os abre.
  const animCache = new WeakMap(); // File -> { durs (ms por quadro), width, height }

  function isAnimationFile(file) {
    return /^image\/(gif|webp|png|apng)$/i.test(file.type || "") || /\.(gif|webp|png|apng)$/i.test(file.name || "");
  }

  function imageType(file) {
    if (file.type && file.type.startsWith("image/")) return file.type;
    const ext = (file.name || "").split(".").pop().toLowerCase();
    return { gif: "image/gif", webp: "image/webp", png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] || "image/gif";
  }

  async function openDecoder(file) {
    if (typeof ImageDecoder === "undefined") throw new Error("Este navegador não consegue ler GIFs animados (falta o ImageDecoder). Use o Chrome ou o Edge atualizados.");
    const type = imageType(file);
    if (!(await ImageDecoder.isTypeSupported(type))) throw new Error("O navegador não consegue ler imagens " + type);
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
    await dec.completed;
    await dec.tracks.ready;
    return dec;
  }

  // Duração de cada quadro. Os navegadores exibem a 100 ms os quadros de GIF que dizem durar
  // 10 ms ou menos (muitos GIFs antigos dizem 0); aqui se faz o mesmo para que fique igual.
  async function probeAnimation(file) {
    if (animCache.has(file)) return animCache.get(file);
    const dec = await openDecoder(file);
    try {
      const track = dec.tracks.selectedTrack;
      const n = track ? track.frameCount : 1;
      const durs = [];
      let width = 0, height = 0;
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (!i) { width = image.displayWidth; height = image.displayHeight; }
        const ms = image.duration != null ? image.duration / 1000 : 0;
        durs.push(ms > 10 ? ms : 100);
        image.close();
      }
      const info = { frames: n, durs, duration: n > 1 ? durs.reduce((a, b) => a + b, 0) / 1000 : 0, width, height, animated: n > 1 };
      animCache.set(file, info);
      return info;
    } finally {
      dec.close();
    }
  }

  // Captura um GIF a fps fixo durante dur segundos (se dur superar o GIF, ele se repete).
  async function captureAnimation(file, dur, fps, side, mode, onProgress, signal) {
    const t0 = performance.now();
    const info = await probeAnimation(file);
    const ends = [];
    let acc = 0;
    for (const d of info.durs) { acc += d; ends.push(acc); }
    const total = acc || 1;
    const n = Math.max(1, Math.round(dur * fps));
    const want = [];
    for (let i = 0; i < n; i++) {
      const t = (((i + 0.5) * 1000) / fps) % total;
      let k = 0;
      while (k < ends.length - 1 && ends[k] <= t) k++;
      want.push(k);
    }
    const needed = [...new Set(want)].sort((a, b) => a - b);
    const snap = makeSnapper(side, mode);
    const byIndex = new Map();
    const dec = await openDecoder(file);
    try {
      for (let j = 0; j < needed.length; j++) {
        checkAbort(signal);
        const { image } = await dec.decode({ frameIndex: needed[j] });
        const s = snap(image);
        image.close();
        byIndex.set(needed[j], { bmp: await s.bmpPromise, fp: s.fp });
        if (onProgress && (j % 5 === 0 || j === needed.length - 1)) onProgress(`Lendo quadros do GIF ${j + 1}/${needed.length}`, (j + 1) / needed.length);
      }
    } finally {
      dec.close();
    }
    const frames = want.map((k) => byIndex.get(k));
    log("info", "gif:cuadros", { cuadrosGif: info.frames, usados: needed.length, cuadros: frames.length, fpsCaptura: fps, ladoCaptura: side, duracionGif: info.duration, ms: Math.round(performance.now() - t0) });
    return frames;
  }

  // Imagem fixa (JPG, PNG, WebP…). Em um GIF, usa-se o primeiro quadro.
  async function probeImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error("O navegador não conseguiu ler a imagem (" + (e && e.message ? e.message : e) + ")"); }
    const out = { width: bmp.width, height: bmp.height, animated: false };
    bmp.close();
    if (isAnimationFile(file) && typeof ImageDecoder !== "undefined") {
      try { out.animated = (await probeAnimation(file)).animated; } catch (e) { /* usa-se como imagem fixa */ }
    }
    return out;
  }

  async function captureImage(file, side, mode) {
    const bmp = await createImageBitmap(file);
    try {
      const s = makeSnapper(side, mode)(bmp);
      return { bmp: await s.bmpPromise, fp: s.fp };
    } finally {
      bmp.close();
    }
  }

  // Linha do tempo da figurinha: os quadros capturados (que cobrem capDur) são distribuídos em dur
  // segundos. Se dur for maior, a animação se repete ("repetir") ou fica no último quadro.
  function fitTimeline(captured, capDur, dur, fps, fit) {
    const n = Math.max(1, Math.round(dur * fps));
    if (n === captured.length) return captured;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / fps;
      const tv = fit === "repetir" ? t % capDur : Math.min(t, capDur);
      out[i] = captured[Math.max(0, Math.min(captured.length - 1, Math.floor(tv * fps)))];
    }
    return out;
  }

  // ---------------------------------------------------------------- WebP
  function readChunks(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WEBP") throw new Error("O canvas não devolveu um WebP válido");
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = tag(i);
      const size = dv.getUint32(i + 4, true);
      chunks.push({ fourcc, data: bytes.subarray(i + 8, i + 8 + size) });
      i += 8 + size + (size & 1);
    }
    return chunks;
  }

  function chunk(fourcc, data) {
    const pad = data.length & 1;
    const out = new Uint8Array(8 + data.length + pad);
    out.set(te.encode(fourcc), 0);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  }

  function concat(parts) {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function u24(arr, off, v) { arr[off] = v & 255; arr[off + 1] = (v >> 8) & 255; arr[off + 2] = (v >> 16) & 255; }

  // Codifica um quadro como WebP estático e devolve os sub-chunks de imagem (ALPH + VP8 / VP8L).
  async function encodeStaticFrame(bitmap, quality, canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") throw new Error("Este navegador não consegue gerar WebP (devolveu " + blob.type + "). Use o Chrome ou o Edge.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = readChunks(bytes).filter((c) => c.fourcc === "ALPH" || c.fourcc === "VP8 " || c.fourcc === "VP8L");
    if (!parts.some((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L")) throw new Error("WebP sem dados de imagem");
    const payload = concat(parts.map((c) => chunk(c.fourcc, c.data)));
    const hasAlpha = parts.some((c) => c.fourcc === "ALPH" || c.fourcc === "VP8L");
    return { payload, hasAlpha };
  }

  function buildAnimatedWebp(frames, exif, side = SIDE) {
    // frames: [{payload, hasAlpha, durationMs}]
    const anyAlpha = frames.some((f) => f.hasAlpha);
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0) | (exif ? 0x08 : 0); // animação, alfa, EXIF
    u24(vp8x, 4, side - 1);
    u24(vp8x, 7, side - 1);
    const anim = new Uint8Array(6); // cor de fundo 0 (transparente), loop infinito
    const parts = [chunk("VP8X", vp8x), chunk("ANIM", anim)];
    for (const f of frames) {
      const hdr = new Uint8Array(16);
      u24(hdr, 0, 0); u24(hdr, 3, 0);
      u24(hdr, 6, side - 1); u24(hdr, 9, side - 1);
      u24(hdr, 12, Math.max(1, Math.min(0xffffff, f.durationMs)));
      hdr[15] = 0x02; // sem mesclagem (cada quadro substitui o anterior), sem descarte
      parts.push(chunk("ANMF", concat([hdr, f.payload])));
    }
    if (exif) parts.push(chunk("EXIF", exif));
    const body = concat(parts);
    const riff = new Uint8Array(12);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
    riff.set(te.encode("WEBP"), 8);
    return concat([riff, body]);
  }

  // WebP fixo (um único quadro, sem animação) com os metadados do WhatsApp.
  function buildStillWebp(frame, exif, side = SIDE) {
    const vp8x = new Uint8Array(10);
    vp8x[0] = (frame.hasAlpha ? 0x10 : 0) | (exif ? 0x08 : 0);
    u24(vp8x, 4, side - 1);
    u24(vp8x, 7, side - 1);
    const body = concat([chunk("VP8X", vp8x), frame.payload].concat(exif ? [chunk("EXIF", exif)] : []));
    const riff = new Uint8Array(12);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
    riff.set(te.encode("WEBP"), 8);
    return concat([riff, body]);
  }

  function exifWhatsApp(meta) {
    // Bloco TIFF big-endian com uma única tag 0x5741 ("WA") que contém o JSON (igual ao WhatsApp).
    const js = te.encode(JSON.stringify(meta));
    const out = new Uint8Array(26 + js.length);
    const dv = new DataView(out.buffer);
    out.set([0x4d, 0x4d, 0x00, 0x2a], 0);
    dv.setUint32(4, 8);
    dv.setUint16(8, 1);
    dv.setUint16(10, 0x5741);
    dv.setUint16(12, 7);
    dv.setUint32(14, js.length);
    dv.setUint32(18, 26);
    dv.setUint32(22, 0);
    out.set(js, 26);
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Escolhe quais quadros capturados usar para um fps e quanto dura cada um.
  function plan(nCaptured, dur, fps, captureFps) {
    const totalMs = Math.round(dur * 1000);
    const count = Math.max(1, Math.round(dur * fps));
    const out = [];
    for (let k = 0; k < count; k++) {
      const startMs = Math.round((k * 1000) / fps);
      const endMs = k === count - 1 ? totalMs : Math.min(totalMs, Math.round(((k + 1) * 1000) / fps));
      const idx = Math.min(nCaptured - 1, Math.round((k * captureFps) / fps));
      out.push({ idx, durationMs: Math.max(1, endMs - startMs) });
    }
    return out;
  }

  // Codifica a figurinha para um lado e fps dados. Começa com a qualidade do lado e a reduz
  // só se necessário para não passar de 1 MB.
  async function encodeWebp(an, side, fps, exifMeta, { onProgress, signal, syncMs = 0, still = false }) {
    const { frames, dur, captureFps } = an;
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext("2d");
    const p = plan(frames.length, dur, fps, captureFps);
    const qStart = Q_BY_SIDE[side] || 0.5;
    const qList = [];
    for (let q = qStart; q >= Q_MIN - 1e-9; q -= 0.1) qList.push(+q.toFixed(2));
    if (qList[qList.length - 1] > Q_MIN) qList.push(Q_MIN);
    const attempts = [];
    let best = null;
    for (let i = 0; i < qList.length; i++) {
      const q = qList[i];
      // Com a amostra da análise, pula-se direto para uma qualidade que provavelmente caiba.
      if (best && an.sampleBytes && i < qList.length - 1) {
        const ratio = sampleAvg(an, side, q) / sampleAvg(an, side, best.q);
        if (ratio > 0 && best.bytes.length * ratio > MAX_STICKER_BYTES * 0.98) { attempts.push({ q, saltado: true, previsto: Math.round(best.bytes.length * ratio) }); continue; }
      }
      const cache = new Map();
      const out = [];
      let prevF = null;
      for (let k = 0; k < p.length; k++) {
        checkAbort(signal);
        const f = frames[p[k].idx];
        const prev = out[out.length - 1];
        // Quadro repetido (mesmo critério da estimativa): alonga-se o anterior e não se codifica.
        if (prev && prevF && (f === prevF || sameBytes(f.fp, prevF.fp))) { prev.durationMs += p[k].durationMs; continue; }
        let enc = cache.get(f);
        if (!enc) { enc = await encodeStaticFrame(f.bmp, q, canvas, ctx); cache.set(f, enc); }
        prevF = f;
        if (prev && sameBytes(prev.payload, enc.payload)) prev.durationMs += p[k].durationMs;
        else out.push({ payload: enc.payload, hasAlpha: enc.hasAlpha, durationMs: p[k].durationMs });
        if (onProgress && k % 10 === 0) onProgress(`Codificando (${side} px, ${fps} fps, qualidade ${Math.round(q * 100)}) ${k + 1}/${p.length}`, (k + 1) / p.length);
      }
      // Compensação de defasagem: o primeiro quadro é exibido syncMs a mais, para que a imagem espere o áudio.
      if (syncMs > 0 && !still) out[0] = { ...out[0], durationMs: out[0].durationMs + syncMs };
      const bytes = still ? buildStillWebp(out[0], exifWhatsApp(exifMeta), side) : buildAnimatedWebp(out, exifWhatsApp(exifMeta), side);
      attempts.push({ q, bytes: bytes.length, cuadros: out.length });
      best = { bytes, side, fps, q, frames: out.length };
      if (bytes.length <= MAX_STICKER_BYTES) break;
    }
    log("info", "webp:intentos", { side, fps, intentos: attempts });
    if (!best || best.bytes.length > MAX_STICKER_BYTES) {
      throw new Error(`Não cabe em 1 MB nem com a qualidade mínima (${Math.round(best.bytes.length / 1000)} KB). Escolha menos fps ou menos resolução.`);
    }
    return best;
  }

  function sampleAvg(an, side, q) {
    const m = an.sampleBytes && an.sampleBytes[side];
    if (!m) return 0;
    if (m[q] != null) return m[q];
    // Interpolação linear entre as qualidades medidas.
    const qs = Object.keys(m).map(Number).sort((x, y) => x - y);
    if (q <= qs[0]) return m[qs[0]];
    if (q >= qs[qs.length - 1]) return m[qs[qs.length - 1]];
    for (let i = 0; i < qs.length - 1; i++) if (q >= qs[i] && q <= qs[i + 1]) {
      const t = (q - qs[i]) / (qs[i + 1] - qs[i]);
      return m[qs[i]] + t * (m[qs[i + 1]] - m[qs[i]]);
    }
    return 0;
  }

  // ---------------------------------------------------------------- áudio
  // O áudio decodificado é guardado por arquivo: a forma de onda e a criação não o decodificam duas vezes.
  const audioCache = new WeakMap();
  function decodeAudioFile(file) {
    if (!audioCache.has(file)) {
      const p = (async () => {
        const buf = await file.arrayBuffer();
        try {
          const dctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
          return await dctx.decodeAudioData(buf);
        } catch (e) {
          const err = new Error("Não foi possível ler o áudio. O arquivo tem som? (" + (e && e.message ? e.message : e) + ")");
          err.cause = e;
          throw err;
        }
      })();
      p.catch(() => audioCache.delete(file));
      audioCache.set(file, p);
    }
    return audioCache.get(file);
  }

  // Duração e forma de onda (picos por trecho) de um arquivo de áudio ou de vídeo.
  async function probeAudio(file, buckets = 1200) {
    const d = await decodeAudioFile(file);
    const chans = Array.from({ length: d.numberOfChannels }, (_, c) => d.getChannelData(c));
    const per = Math.max(1, Math.floor(d.length / buckets));
    const peaks = new Float32Array(Math.ceil(d.length / per));
    let max = 0;
    for (let b = 0; b < peaks.length; b++) {
      let p = 0;
      const end = Math.min(d.length, (b + 1) * per);
      for (const ch of chans) for (let i = b * per; i < end; i += 4) { const a = Math.abs(ch[i]); if (a > p) p = a; }
      peaks[b] = p;
      if (p > max) max = p;
    }
    return { duration: d.duration, channels: d.numberOfChannels, peaks, peakMax: max };
  }

  async function extractAudio(file, start, dur, fadeMs = 0) {
    const decoded = await decodeAudioFile(file);
    if (decoded.duration < start + 0.05) throw new Error(`O áudio dura ${decoded.duration.toFixed(2)} s e o trecho começa em ${start.toFixed(2)} s`);
    const len = Math.max(1, Math.round(dur * SAMPLE_RATE));
    const octx = new OfflineAudioContext(1, len, SAMPLE_RATE);
    const src = octx.createBufferSource();
    src.buffer = decoded;
    src.connect(octx.destination); // mixa para mono
    src.start(0, start, dur);
    const rendered = await octx.startRendering();
    const pcm = rendered.getChannelData(0);
    // Fade muito curto nas bordas: um corte no meio de uma onda soa como um "clique".
    if (fadeMs > 0) {
      const f = Math.min(Math.floor(pcm.length / 2), Math.round((fadeMs / 1000) * SAMPLE_RATE));
      for (let i = 0; i < f; i++) { const g = i / f; pcm[i] *= g; pcm[pcm.length - 1 - i] *= g; }
    }
    let peak = 0, sumsq = 0;
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; sumsq += pcm[i] * pcm[i]; }
    const rms = Math.sqrt(sumsq / pcm.length);
    log("info", "audio:pcm", { canalesOriginales: decoded.numberOfChannels, rateOriginal: decoded.sampleRate, duracionAudio: decoded.duration, muestras: pcm.length, pico: +peak.toFixed(4), rms: +rms.toFixed(4) });
    if (peak < 0.0005) log("warn", "audio:silencio", "O trecho escolhido parece não ter som");
    return pcm;
  }

  async function encodeOpus(pcm, bitrate = 32000) {
    if (typeof AudioEncoder === "undefined") throw new Error("Este navegador não tem WebCodecs (AudioEncoder). Use o Chrome ou o Edge atualizados.");
    const base = { codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate };
    const candidates = [
      { ...base, bitrateMode: "variable", opus: { frameDuration: 20000, complexity: 10, application: "voip", signal: "voice" } },
      { ...base, bitrateMode: "variable", opus: { frameDuration: 20000 } },
      base,
    ];
    let config = null;
    for (const c of candidates) {
      try { if ((await AudioEncoder.isConfigSupported(c)).supported) { config = c; break; } } catch (e) { /* tentar o próximo */ }
    }
    if (!config) throw new Error("O navegador não consegue codificar Opus com WebCodecs");
    const packets = [];
    let description = null;
    let encError = null;
    const enc = new AudioEncoder({
      output: (chunkOut, meta) => {
        const b = new Uint8Array(chunkOut.byteLength);
        chunkOut.copyTo(b);
        packets.push(b);
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          const d = meta.decoderConfig.description;
          description = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        }
      },
      error: (e) => { encError = e; },
    });
    enc.configure(config);
    const BLOCK = 960 * 50;
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const n = Math.min(BLOCK, pcm.length - i);
      const data = new Float32Array(pcm.subarray(i, i + n));
      const ad = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
    if (encError) throw encError;
    let preSkip = 312;
    if (description && description.length >= 12 && String.fromCharCode(...description.subarray(0, 8)) === "OpusHead") {
      preSkip = description[10] | (description[11] << 8);
    }
    return { packets, preSkip, config };
  }

  // Ogg (RFC 3533) + encapsulamento Opus (RFC 7845)
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      t[i] = r >>> 0;
    }
    return t;
  })();
  function oggCrc(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return c >>> 0;
  }
  function oggPage(headerType, granule, serial, seq, packetList) {
    const lacing = [];
    for (const p of packetList) {
      let len = p.length;
      while (len >= 255) { lacing.push(255); len -= 255; }
      lacing.push(len);
    }
    if (lacing.length > 255) throw new Error("Página Ogg com segmentos demais");
    const dataLen = packetList.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + dataLen);
    const dv = new DataView(page.buffer);
    page.set(te.encode("OggS"), 0);
    page[4] = 0;
    page[5] = headerType;
    dv.setBigInt64(6, BigInt(granule), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packetList) { page.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc(page), true);
    return page;
  }
  function buildOggOpus(packets, preSkip, totalSamples) {
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const head = new Uint8Array(19);
    head.set(te.encode("OpusHead"), 0);
    head[8] = 1; head[9] = 1;
    new DataView(head.buffer).setUint16(10, preSkip, true);
    new DataView(head.buffer).setUint32(12, SAMPLE_RATE, true);
    const vendor = te.encode("WAAudioStickers");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(te.encode("OpusTags"), 0);
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    const pages = [oggPage(0x02, 0, serial, 0, [head]), oggPage(0x00, 0, serial, 1, [tags])];
    const finalGranule = preSkip + totalSamples;
    const PER_PAGE = 50; // ~1 s por página com quadros de 20 ms
    let seq = 2;
    for (let i = 0; i < packets.length; i += PER_PAGE) {
      const group = packets.slice(i, i + PER_PAGE);
      const last = i + PER_PAGE >= packets.length;
      const granule = last ? finalGranule : Math.min(finalGranule, preSkip + (i + group.length) * 960);
      pages.push(oggPage(last ? 0x04 : 0x00, granule, serial, seq++, group));
    }
    return concat(pages);
  }

  async function sha256b64(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let s = "";
    for (const b of h) s += String.fromCharCode(b);
    return btoa(s);
  }

  async function verifyOgg(bytes) {
    try {
      const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer);
      return { ok: true, duracion: +buf.duration.toFixed(3) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // ---------------------------------------------------------------- metadados da figurinha
  // O WhatsApp mostra o nome do pacote e o autor embaixo da figurinha. As figurinhas com o mesmo
  // pacote e autor compartilham identificador (calculado a partir dos dois) para se agruparem.
  async function packIdFor(packName, publisher) {
    if (!packName && !publisher) return crypto.randomUUID();
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode("stickers-con-sonido|" + packName + "|" + publisher)));
    const x = Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
  }
  async function stickerMeta({ packName = "", publisher = "", soundSha }) {
    packName = String(packName || "").trim().slice(0, 128);
    publisher = String(publisher || "").trim().slice(0, 128);
    const meta = { "sticker-pack-id": await packIdFor(packName, publisher) };
    if (packName) meta["sticker-pack-name"] = packName;
    if (publisher) meta["sticker-pack-publisher"] = publisher;
    meta.emojis = ["🔊"];
    meta["sound-sha256"] = soundSha;
    return meta;
  }
  // Altera os metadados (EXIF) de uma figurinha já criada sem recodificá-la.
  async function retagWebp(blob, { packName, publisher, soundSha }) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = readChunks(bytes).filter((c) => c.fourcc !== "EXIF");
    const vp8x = chunks.find((c) => c.fourcc === "VP8X");
    if (vp8x) { const d = new Uint8Array(vp8x.data); d[0] |= 0x08; vp8x.data = d; }
    const meta = await stickerMeta({ packName, publisher, soundSha });
    const body = concat([te.encode("WEBP")].concat(chunks.map((c) => chunk(c.fourcc, c.data)), [chunk("EXIF", exifWhatsApp(meta))]));
    const riff = new Uint8Array(8);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, body.length, true);
    return new Blob([concat([riff, body])], { type: "image/webp" });
  }

  // ---------------------------------------------------------------- API pública
  // Passo 1: captura o trecho uma única vez e estima quanto pesaria cada combinação de
  // resolução e fps. Os quadros ficam na memória para criar a figurinha sem recapturar.
  //
  // Fontes:
  // - visual: { kind: "video" | "gif" | "image", file, start, dur }  (um GIF é usado por inteiro: start 0)
  // - audio:  { file, start, dur }  (pode ser outro arquivo; por padrão, o mesmo vídeo e trecho)
  // - fit, quando a imagem e o áudio duram tempos diferentes:
  //   "repetir"       a figurinha dura o mesmo que o áudio e a animação se repete;
  //   "congelar"      a figurinha dura o mesmo que o áudio e fica no último quadro;
  //   "independiente" cada um mantém a sua duração (o WhatsApp não exige que coincidam).
  // Se a animação for mais longa que o áudio, com "repetir"/"congelar" ela é cortada no tamanho do áudio.
  // Uma imagem fixa sempre dura o mesmo que o áudio.
  async function analyze({ file, start = 0, duration, mode = "ajustar", visual, audio, fit = "repetir", onProgress, signal }) {
    if (!visual) visual = { kind: "video", file, start, dur: duration };
    if (!audio) audio = { file: visual.file, start: visual.start, dur: visual.dur };
    const prog = onProgress || (() => {});
    const t0 = performance.now();
    const vDur = visual.kind === "image" ? audio.dur : visual.dur;
    const dur = visual.kind === "image" || fit !== "independiente" ? audio.dur : vDur; // duração da figurinha
    const capDur = Math.min(vDur, dur);                                                // o que é capturado
    const base = { file: visual.file, start: visual.start || 0, visual, audio, fit, dur, vDur, mode };

    if (visual.kind === "image") {
      // Um único quadro que dura o áudio inteiro: não há combinações de fps para escolher.
      log("info", "analizar:parametros", { tipo: "imagen", archivo: visual.file.name, bytes: visual.file.size, duracionAudio: audio.dur, modo: mode });
      prog("Lendo a imagem…", 0.3);
      const f = await captureImage(visual.file, SIDE, mode);
      const cells = SIDES.map((side) => ({ side, fps: 1, estado: "ok", score: side }));
      const an = { ...base, frames: [f], captureFps: 1, captureSide: SIDE, distinct: { 1: 1 }, cells, auto: cells[0], ms: Math.round(performance.now() - t0) };
      prog("Imagem pronta", 1);
      return an;
    }

    const captureFps = captureFpsFor(dur);
    const slots = Math.ceil(capDur * captureFps);
    const captureSide = Math.max(64, Math.min(SIDE, Math.floor(Math.sqrt(CAPTURE_MEM_BYTES / (4 * slots)))));
    log("info", "analizar:parametros", {
      tipo: visual.kind, archivo: visual.file.name, bytes: visual.file.size, inicio: visual.start || 0, duracionImagen: vDur,
      audioAparte: audio.file !== visual.file, duracionAudio: audio.dur, ajuste: fit, duracionSticker: dur, modo: mode, captureFps, captureSide,
    });
    const capProg = (t, f) => prog(t, f * 0.8);
    const captured = visual.kind === "gif"
      ? await captureAnimation(visual.file, capDur, captureFps, captureSide, mode, capProg, signal)
      : await captureFrames(visual.file, visual.start || 0, capDur, captureFps, captureSide, mode, capProg, signal);
    const frames = fitTimeline(captured, capDur, dur, captureFps, fit);
    const sides = SIDES.filter((x) => x <= captureSide);
    const fpsList = FPS_LIST.filter((x) => x <= captureFps);
    // Quadros distintos para cada fps (os repetidos são mesclados e quase não pesam).
    const distinct = {};
    for (const f of fpsList) {
      const p = plan(frames.length, dur, f, captureFps);
      let d = 0;
      for (let k = 0; k < p.length; k++) {
        const a = frames[p[k].idx], b = k ? frames[p[k - 1].idx] : null;
        if (!b || (a !== b && !sameBytes(a.fp, b.fp))) d++;
      }
      distinct[f] = d;
    }
    // Amostra: até 24 quadros distintos distribuídos pelo trecho, com um deslocamento
    // irregular para não coincidir com conteúdos que se repetem em ciclos (p. ex., a cada segundo).
    const uniq = [];
    for (let i = 0; i < frames.length; i++) if (!i || (frames[i] !== frames[i - 1] && !sameBytes(frames[i].fp, frames[i - 1].fp))) uniq.push(frames[i]);
    const M = Math.min(24, uniq.length);
    const sample = Array.from({ length: M }, (_, i) => uniq[Math.min(uniq.length - 1, Math.floor(((i + ((i * 0.618) % 1)) * uniq.length) / M))]);
    const sampleBytes = {};
    let done = 0;
    for (const side of sides) {
      const canvas = new OffscreenCanvas(side, side);
      const ctx = canvas.getContext("2d");
      sampleBytes[side] = {};
      for (const q of [Q_BY_SIDE[side], 0.35, Q_MIN]) {
        if (sampleBytes[side][q] != null) continue;
        let sum = 0;
        for (const f of sample) { checkAbort(signal); sum += (await encodeStaticFrame(f.bmp, q, canvas, ctx)).payload.length; }
        sampleBytes[side][q] = sum / sample.length;
      }
      prog("Calculando opções…", 0.8 + (0.2 * ++done) / sides.length);
    }
    const overhead = 32; // cabeçalho ANMF + chunk
    const cells = [];
    for (const side of SIDES) for (const fps of FPS_LIST) {
      if (!sampleBytes[side] || distinct[fps] == null) { cells.push({ side, fps, estado: "fuera" }); continue; }
      const n = distinct[fps];
      const est = (sampleBytes[side][Q_BY_SIDE[side]] + overhead) * n + 400;
      const estMin = (sampleBytes[side][Q_MIN] + overhead) * n + 400;
      const estado = est <= SAFE_BYTES ? "ok" : estMin <= SAFE_BYTES ? "baja" : "no";
      cells.push({ side, fps, est: Math.round(est), estMin: Math.round(estMin), estado, score: score(side, fps) });
    }
    const pick = (st) => cells.filter((c) => c.estado === st).sort((x, y) => y.score - x.score)[0];
    const auto = pick("ok") || pick("baja") || null;
    const an = { ...base, frames, captureFps, captureSide, sampleBytes, distinct, cells, auto, ms: Math.round(performance.now() - t0) };
    log("info", "analizar:resultado", {
      ms: an.ms, captureFps, captureSide, distintos: distinct, muestra: M,
      auto: auto && { side: auto.side, fps: auto.fps, est: auto.est, estado: auto.estado },
      caben: cells.filter((c) => c.estado === "ok").length, conMenosCalidad: cells.filter((c) => c.estado === "baja").length,
    });
    prog("Opções prontas", 1);
    return an;
  }

  function release(an) {
    if (!an || !an.frames) return;
    for (const f of new Set(an.frames)) { try { f.bmp.close(); } catch (e) { /* ya cerrado */ } }
    an.frames = null;
  }

  // Passo 2: codifica o áudio e a figurinha com a combinação escolhida.
  async function create(an, { side, fps, syncMs = 0, still = false, audio = null, onProgress, signal, packName = "", publisher = "" }) {
    if (!an || !an.frames) throw new Error("Primeiro calcule as opções do trecho");
    syncMs = Math.max(0, Math.min(1000, Math.round(+syncMs || 0)));
    still = !!still && an.visual.kind === "image";
    const prog = onProgress || (() => {});
    const t0 = performance.now();
    const { dur } = an;
    // O áudio pode mudar depois da análise sem recalcular: com "independiente" não afeta os quadros.
    const A = audio || an.audio;
    if (an.visual.kind === "image" || an.fit !== "independiente") {
      if (Math.abs(A.dur - an.audio.dur) > 0.002) throw new Error("A duração do áudio mudou: calcule as opções de novo");
    }
    const cell = an.cells.find((c) => c.side === side && c.fps === fps);
    log("info", "crear:parametros", { side, fps, compensacionMs: syncMs, estatico: still, estimado: cell && cell.est, estado: cell && cell.estado });

    // Áudio: a taxa de bits diminui em clipes longos para não passar de 1 MB (limite do WhatsApp).
    const bitrate = Math.max(12000, Math.min(32000, Math.floor((0.9 * MAX_AUDIO_BYTES * 8) / A.dur)));
    if ((bitrate / 8) * A.dur > 0.97 * MAX_AUDIO_BYTES) throw new Error(`Com ${Math.round(A.dur)} s o áudio não cabe em 1 MB (limite do WhatsApp). O máximo é cerca de ${Math.floor((0.9 * MAX_AUDIO_BYTES * 8) / 12000 / 60)} minutos.`);
    prog("Extraindo o áudio…", 0);
    // Um áudio separado é cortado onde o usuário quiser: suaviza-se o corte para evitar cliques.
    const pcm = await extractAudio(A.file, A.start, A.dur, A.file !== an.visual.file ? 8 : 0);
    checkAbort(signal);
    prog("Codificando o áudio…", 0.05);
    const { packets, preSkip, config } = await encodeOpus(pcm, bitrate);
    const ogg = buildOggOpus(packets, preSkip, pcm.length);
    if (ogg.length > MAX_AUDIO_BYTES) throw new Error(`O áudio pesa ${Math.round(ogg.length / 1000)} KB (máximo de 1000 KB)`);
    const soundSha = await sha256b64(ogg);
    const oggCheck = await verifyOgg(ogg);
    log(oggCheck.ok ? "info" : "error", "audio:ogg", { bytes: ogg.length, paquetes: packets.length, preSkip, config, verificacion: oggCheck, soundSha256: soundSha });
    if (!oggCheck.ok) throw new Error("O áudio gerado não pode ser reproduzido: " + oggCheck.error);

    const exifMeta = await stickerMeta({ packName, publisher, soundSha });
    const w = await encodeWebp(an, side, fps, exifMeta, { onProgress: prog, signal, syncMs, still });
    const info = {
      tipo: an.visual.kind, ajuste: an.fit,
      duracion: dur, duracionAudio: A.dur, segundosAudio: Math.max(1, Math.round(A.dur)),
      fps: an.visual.kind === "image" ? null : w.fps, calidad: w.q, lado: w.side, cuadros: w.frames, isAnimated: !still,
      compensacionMs: syncMs, webpBytes: w.bytes.length, estimado: cell && cell.est,
      oggBytes: ogg.length, audioKbps: Math.round(bitrate / 1000), soundSha256: soundSha, paquete: exifMeta["sticker-pack-name"] || "", autor: exifMeta["sticker-pack-publisher"] || "",
      msTotal: Math.round(performance.now() - t0),
    };
    log("info", "crear:resultado", info);
    prog("Pronto", 1);
    return { webp: new Blob([w.bytes], { type: "image/webp" }), ogg: new Blob([ogg], { type: "audio/ogg; codecs=opus" }), info };
  }

  // Atalho (testes): analisar + escolher (automático ou fixo) + criar.
  async function convert({ file, start = 0, duration, mode = "ajustar", visual, audio, fit, still = false, syncMs = 0, side = "auto", fps = "auto", onProgress, signal }) {
    const an = await analyze({ file, start, duration, mode, visual, audio, fit, onProgress, signal });
    try {
      let c = an.auto;
      if (side !== "auto" || fps !== "auto") {
        const ok = an.cells.filter((x) => (side === "auto" || x.side === +side) && (fps === "auto" || x.fps === +fps) && x.estado !== "no" && x.estado !== "fuera");
        c = ok.sort((x, y) => y.score - x.score)[0];
      }
      if (!c) throw new Error("Nenhuma combinação cabe em 1 MB para este trecho");
      const r = await create(an, { side: c.side, fps: c.fps, syncMs, still, onProgress, signal });
      r.analysis = { auto: an.auto, cells: an.cells, ms: an.ms, captureFps: an.captureFps, captureSide: an.captureSide };
      return r;
    } finally {
      release(an);
    }
  }

  // Verificações do navegador para o diagnóstico.
  async function capabilities() {
    const out = { offscreenCanvas: typeof OffscreenCanvas !== "undefined", webCodecsAudio: typeof AudioEncoder !== "undefined" };
    try {
      const c = new OffscreenCanvas(4, 4);
      c.getContext("2d").fillRect(0, 0, 2, 2);
      const b = await c.convertToBlob({ type: "image/webp", quality: 0.5 });
      out.webpEncode = b.type;
    } catch (e) { out.webpEncode = "error: " + e.message; }
    if (out.webCodecsAudio) {
      try { out.opus = (await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 })).supported; } catch (e) { out.opus = "error: " + e.message; }
    }
    return out;
  }

  WAAS.convert = convert;
  WAAS.probeVideo = probeVideo;
  WAAS.probeAudio = probeAudio;
  WAAS.probeImage = probeImage;
  WAAS.probeAnimation = probeAnimation;
  WAAS.isAnimationFile = isAnimationFile;
  WAAS.capabilities = capabilities;
  WAAS.analyze = analyze;
  WAAS.retagWebp = retagWebp;
  WAAS.create = create;
  WAAS.release = release;
  WAAS.limits = { SIDE, MAX_STICKER_BYTES, MAX_AUDIO_BYTES, SIDES, FPS_LIST };
  WAAS._internals = { buildOggOpus, buildAnimatedWebp, buildStillWebp, fitTimeline, exifWhatsApp, readChunks, plan, sha256b64, score };
})();

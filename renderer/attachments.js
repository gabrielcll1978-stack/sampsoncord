'use strict';
/*
 * Imagens no chat.
 * A imagem fica guardada no IndexedDB de quem tem (não no localStorage, que é pequeno).
 * A mensagem leva só { id, w, h }. Quem não tem a imagem pede pros membros online ("att-req")
 * e quem tem responde ("att"). Assim o histórico sincroniza rápido e as imagens chegam sob demanda.
 */

// Texto que vai junto quando a imagem não tem legenda: apps antigos (sem suporte a imagem) mostram isso
const IMG_PLACEHOLDER = '📷 [imagem — atualize o Sampsoncord para ver]';
const MAX_IMG_BYTES = 900 * 1024;

const attachments = (() => {
  const mem = new Map();      // id -> dataURL (cache em memória)
  const waiting = new Map();  // id -> momento do último pedido
  let dbp = null;

  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('salinha-att', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('att');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function get(id) {
    if (mem.has(id)) return mem.get(id);
    try {
      const d = await db();
      const v = await new Promise((res) => { const r = d.transaction('att').objectStore('att').get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (v) mem.set(id, v);
      return v || null;
    } catch { return null; }
  }
  async function put(id, data) {
    mem.set(id, data);
    try { const d = await db(); d.transaction('att', 'readwrite').objectStore('att').put(data, id); } catch { }
  }

  const validData = (data) => typeof data === 'string' && data.length <= MAX_IMG_BYTES * 1.4 && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data);

  // Pede a imagem para todo mundo online (no máximo 1 pedido a cada 10s por imagem)
  function request(id) {
    const last = waiting.get(id) || 0;
    if (Date.now() - last < 10000) return;
    waiting.set(id, Date.now());
    for (const s of sessions.values()) s.broadcast({ t: 'att-req', id });
  }

  async function serve(m, id) {
    if (typeof id !== 'string' || id.length > 24) return;
    const data = await get(id);
    if (data && m.conn && m.conn.open) { try { m.conn.send({ t: 'att', id, data }); } catch { } }
  }

  async function receive(id, data) {
    if (typeof id !== 'string' || mem.has(id) || !validData(data)) return;
    await put(id, data);
    waiting.delete(id);
    // mostra em todo lugar onde essa imagem estava esperando
    $$(`img[data-att="${id}"]`).forEach((img) => { img.src = data; img.classList.remove('loading'); });
  }

  // Preenche as imagens do chat que acabaram de ser desenhadas
  async function hydrate(root) {
    for (const img of $$('img[data-att]', root)) {
      const id = img.dataset.att;
      const data = await get(id);
      if (data) { img.src = data; img.classList.remove('loading'); } else request(id);
    }
  }

  // Reduz a imagem para no máximo 1600px e ~900 KB (GIF fica como está se for pequeno)
  function prepare(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Esse arquivo não é uma imagem.'));
      if (file.type === 'image/gif' && file.size <= MAX_IMG_BYTES) {
        const fr = new FileReader();
        fr.onload = () => { const img = new Image(); img.onload = () => resolve({ data: fr.result, w: img.width, h: img.height }); img.onerror = () => reject(new Error('GIF inválido.')); img.src = fr.result; };
        fr.readAsDataURL(file);
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let q = 0.85, data = c.toDataURL('image/jpeg', q);
        while (data.length > MAX_IMG_BYTES * 1.33 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
        resolve({ data, w, h });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir essa imagem.')); };
      img.src = url;
    });
  }

  return { get, put, request, serve, receive, hydrate, prepare };
})();

// ---------------------------------------------------------------- arquivos no chat (qualquer tipo/tamanho)
/*
 * O arquivo NÃO vai inteiro pra todo mundo: a mensagem leva só { id, name, size, type }.
 * Quem clica em "Baixar" pergunta quem tem ("file-ask"), escolhe o primeiro que responder ("file-have")
 * e recebe direto dele em pedaços de 64 KB ("file-get" -> "file-chunk"), pela conexão P2P.
 * Depois de baixar, a pessoa também passa a ter o arquivo e pode mandar pros outros.
 * Por isso funciona com qualquer tamanho, desde que alguém que tenha o arquivo esteja online.
 */
const FILE_PLACEHOLDER = (name) => `📎 [arquivo: ${name} — atualize o Sampsoncord para baixar]`;
const isFilePlaceholder = (t) => /^📎 \[arquivo: .* — atualize o Sampsoncord para baixar\]$/.test(t || '');
const BIG_TEXT = 2000; // texto maior que isso vira um .txt automático
const FILE_CHUNK = 64 * 1024;

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toLocaleString('pt-BR', { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + u[i];
}
function fileIcon(name, type) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (/^image\//.test(type)) return '🖼️';
  if (/^video\//.test(type)) return '🎬';
  if (/^audio\//.test(type)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['txt', 'md', 'log', 'csv', 'json'].includes(ext)) return '📄';
  if (ext === 'pdf') return '📕';
  if (['exe', 'msi', 'bat', 'cmd', 'ps1', 'scr'].includes(ext)) return '⚠️';
  return '📎';
}

const files = (() => {
  const mem = new Map();        // id -> Blob (arquivos que eu tenho)
  const downloads = new Map();  // id -> download em andamento
  const failed = new Map();     // id -> motivo do último erro
  const sending = new Set();    // `${peer}:${id}` enviando agora
  let dbp = null;

  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('salinha-files', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function get(id) {
    if (mem.has(id)) return mem.get(id);
    try {
      const d = await db();
      const v = await new Promise((res) => { const r = d.transaction('files').objectStore('files').get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (v instanceof Blob) { mem.set(id, v); return v; }
    } catch { }
    return null;
  }
  async function put(id, blob) {
    mem.set(id, blob); // na memória já dá pra mandar; no disco é pra continuar tendo depois de reabrir
    try { const d = await db(); d.transaction('files', 'readwrite').objectStore('files').put(blob, id); } catch { }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const validId = (id) => typeof id === 'string' && /^[a-z0-9]{6,24}$/.test(id);

  // ---------------- quem tem o arquivo
  async function onAsk(m, id) {
    if (!validId(id) || !(await get(id))) return;
    try { m.conn && m.conn.open && m.conn.send({ t: 'file-have', id }); } catch { }
  }
  async function onGet(m, id) {
    if (!validId(id)) return;
    const blob = await get(id);
    const key = m.id + ':' + id;
    if (!blob || sending.has(key)) return;
    sending.add(key);
    try {
      const conn = m.conn;
      let i = 0;
      for (let off = 0; off < blob.size || i === 0; off += FILE_CHUNK) {
        if (!conn || !conn.open || !sending.has(key)) return;
        // controle de fluxo: não enche a conexão (senão o chat e a voz travam)
        while (conn.open && ((conn.dataChannel && conn.dataChannel.bufferedAmount > 2 * 1024 * 1024) || conn.bufferSize > 32)) await sleep(25);
        const data = new Uint8Array(await blob.slice(off, off + FILE_CHUNK).arrayBuffer());
        conn.send({ t: 'file-chunk', id, i: i++, data, done: off + FILE_CHUNK >= blob.size });
      }
    } catch (e) { console.warn('file send', e); } finally { sending.delete(key); }
  }
  function onCancel(m, id) { sending.delete(m.id + ':' + id); }

  // ---------------- quem baixa
  function sessionsOf() { return [...sessions.values()]; }
  function download(meta) {
    const { id } = meta;
    if (downloads.has(id)) return;
    failed.delete(id);
    const d = { meta, from: null, parts: [], partBytes: 0, got: 0, next: 0, lastAt: Date.now(), save: true };
    downloads.set(id, d);
    for (const s of sessionsOf()) s.broadcast({ t: 'file-ask', id });
    d.timer = setInterval(() => {
      const idle = Date.now() - d.lastAt;
      if (!d.from && idle > 10000) fail(id, 'Ninguém que tem esse arquivo está online agora. Tente quando quem mandou estiver online.');
      else if (d.from && idle > 20000) fail(id, 'A transferência parou (a pessoa saiu ou a internet caiu). Tente de novo.');
    }, 2000);
    refresh(id);
  }
  function onHave(m, id) {
    const d = downloads.get(id);
    if (!d || d.from) return; // já estou baixando de alguém
    d.from = m;
    d.lastAt = Date.now();
    try { m.conn.send({ t: 'file-get', id }); } catch { fail(id, 'Não consegui pedir o arquivo.'); }
  }
  async function onChunk(m, d0) {
    const { id } = d0;
    const d = downloads.get(id);
    if (!d || d.from !== m) return;
    if (d0.i !== d.next) return fail(id, 'O arquivo chegou com pedaços faltando. Tente de novo.');
    const raw = d0.data instanceof ArrayBuffer ? new Uint8Array(d0.data) : d0.data;
    if (!(raw instanceof Uint8Array)) return fail(id, 'Pedaço inválido.');
    d.next++;
    d.parts.push(raw);
    d.partBytes += raw.length;
    d.got += raw.length;
    d.lastAt = Date.now();
    // de 32 em 32 MB junta os pedaços num Blob (o navegador guarda no disco: arquivo enorme não estoura a memória)
    if (d.partBytes > 32 * 1024 * 1024) { d.parts = [new Blob(d.parts)]; d.partBytes = 0; }
    if (d.got > d.meta.size) return fail(id, 'O arquivo veio maior do que devia.');
    if (!d0.done) { refresh(id); return; }
    const blob = new Blob(d.parts, { type: d.meta.type || 'application/octet-stream' });
    if (blob.size !== d.meta.size) return fail(id, 'O arquivo veio incompleto. Tente de novo.');
    clearInterval(d.timer);
    downloads.delete(id);
    await put(id, blob);
    refresh(id);
    if (d.save) saveToDisk(id, d.meta.name);
  }
  function fail(id, why) {
    const d = downloads.get(id);
    if (d) {
      clearInterval(d.timer);
      if (d.from && d.from.conn && d.from.conn.open) { try { d.from.conn.send({ t: 'file-cancel', id }); } catch { } }
      downloads.delete(id);
    }
    failed.set(id, why);
    refresh(id);
  }
  function cancel(id) { fail(id, 'Download cancelado.'); }
  // quem desconectou no meio: falha na hora (sem esperar os 20s)
  function onPeerGone(m) { for (const [id, d] of downloads) if (d.from === m) fail(id, 'Quem estava mandando o arquivo saiu. Tente de novo.'); }

  async function saveToDisk(id, name) {
    const blob = await get(id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'arquivo';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------------- cartão do arquivo na mensagem
  function cardHTML(f) {
    return `<div class="file-card" data-file="${esc(f.id)}" data-name="${esc(f.name)}" data-size="${f.size}" data-type="${esc(f.type || '')}">
      <span class="fc-ico">${fileIcon(f.name, f.type)}</span>
      <span class="fc-info"><b class="fc-name" title="${esc(f.name)}">${esc(f.name)}</b><span class="fc-sub muted small">${fmtSize(f.size)}</span></span>
      <span class="fc-act"></span>
    </div>`;
  }
  async function paint(card) {
    const id = card.dataset.file;
    const d = downloads.get(id);
    const act = card.querySelector('.fc-act'), sub = card.querySelector('.fc-sub');
    const size = +card.dataset.size || 0;
    if (d) {
      const pct = size ? Math.floor((d.got / size) * 100) : 0;
      sub.innerHTML = d.from ? `Baixando… ${pct}% · ${fmtSize(d.got)} de ${fmtSize(size)}` : 'Procurando quem tem o arquivo…';
      act.innerHTML = '<button class="sm ghost" data-file-act="cancel" title="Cancelar">✕</button>';
      card.style.setProperty('--pct', pct + '%');
      card.classList.add('busy');
      return;
    }
    card.classList.remove('busy');
    card.style.removeProperty('--pct');
    const have = !!(await get(id));
    const err = failed.get(id);
    sub.innerHTML = `${fmtSize(size)}${err ? ` · <span class="fc-err">${esc(err)}</span>` : ''}`;
    act.innerHTML = have
      ? '<button class="sm primary" data-file-act="save">💾 Salvar</button>'
      : '<button class="sm primary" data-file-act="get">⬇ Baixar</button>';
  }
  function refresh(id) { $$(`.file-card[data-file="${id}"]`).forEach(paint); }
  function hydrate(root) { $$('.file-card', root).forEach(paint); }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-file-act]');
    if (!b) return;
    const card = b.closest('.file-card');
    const meta = { id: card.dataset.file, name: card.dataset.name, size: +card.dataset.size || 0, type: card.dataset.type };
    const a = b.dataset.fileAct;
    if (a === 'get') download(meta);
    else if (a === 'save') saveToDisk(meta.id, meta.name);
    else if (a === 'cancel') cancel(meta.id);
  });

  return { get, put, onAsk, onHave, onGet, onChunk, onCancel, onPeerGone, download, cardHTML, hydrate, saveToDisk };
})();

// ---------------------------------------------------------------- links no chat
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
const ytIdOf = (url) => { const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i); return m ? m[1] : null; };

// Texto da mensagem com links clicáveis (tudo escapado)
function linkify(text) {
  let out = '', last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += esc(text.slice(last, m.index));
    out += `<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const previewCache = new Map();
async function getPreview(url) {
  if (previewCache.has(url)) return previewCache.get(url);
  let p = null;
  const yt = ytIdOf(url);
  if (window.desktop && window.desktop.linkPreview) { try { p = await window.desktop.linkPreview(url); } catch { } }
  if (!p && yt) p = { kind: 'youtube', videoId: yt, title: 'Vídeo do YouTube', site: 'YouTube', image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
  previewCache.set(url, p);
  return p;
}

// Preenche os cartões de prévia de link
async function hydratePreviews(root) {
  for (const box of $$('.link-preview[data-url]', root)) {
    if (box.dataset.done) continue;
    box.dataset.done = '1';
    const url = box.dataset.url;
    const p = await getPreview(url);
    if (!p) { box.remove(); continue; }
    const safeImg = p.image && /^https:\/\//i.test(p.image) ? esc(p.image) : '';
    if (p.kind === 'youtube') {
      box.classList.add('yt');
      box.innerHTML = `<div class="lp-site">${esc(p.site || 'YouTube')}</div>
        <a class="lp-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(p.title || 'Vídeo do YouTube')}</a>
        <div class="yt-thumb" data-yt="${esc(p.videoId)}" title="Tocar aqui">
          ${safeImg ? `<img src="${safeImg}" alt="">` : ''}<span class="yt-play">▶</span>
        </div>
        <div class="lp-actions"><button class="sm" data-action="yt-together" data-yt="${esc(p.videoId)}">👥 Assistir junto no canal de voz</button></div>`;
    } else if (p.kind === 'image') {
      box.innerHTML = safeImg ? `<img class="lp-only-img" src="${safeImg}" alt="">` : '';
      if (!safeImg) box.remove();
    } else {
      box.innerHTML = `<div class="lp-site">${esc(p.site || '')}</div>
        <a class="lp-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(p.title || url)}</a>
        ${p.desc ? `<div class="lp-desc">${esc(p.desc)}</div>` : ''}
        ${safeImg ? `<img class="lp-img" src="${safeImg}" alt="">` : ''}`;
    }
  }
}

// Clique na miniatura do YouTube: toca o vídeo ali mesmo
document.addEventListener('click', (e) => {
  const th = e.target.closest('.yt-thumb[data-yt]');
  if (th) {
    const id = th.dataset.yt;
    th.outerHTML = `<iframe class="yt-inline" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    return;
  }
  // imagem do chat: abre grande
  const img = e.target.closest('img.chat-img');
  if (img && img.src && !img.classList.contains('loading')) {
    openModal(`<img class="lightbox-img" src="${img.src}" alt=""><div class="modal-actions"><button class="primary" data-x>Fechar</button></div>`,
      (c) => { c.classList.add('lightbox'); c.querySelector('[data-x]').onclick = closeModal; });
  }
});

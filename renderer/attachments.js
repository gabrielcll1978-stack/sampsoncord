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

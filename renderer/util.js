'use strict';
// ---------------------------------------------------------------- utilidades gerais
// Migração única: na 1.4 o app passou a abrir em app://sampsoncord (antes era arquivo local).
// O processo principal leu os dados da origem antiga; aqui eles são gravados na nova,
// antes de qualquer outra coisa ler o localStorage. Nada é apagado da origem antiga.
(() => {
  try {
    if (!window.desktop || !window.desktop.takeMigration) return;
    const dump = window.desktop.takeMigration();
    if (!dump) return;
    const alreadyHasData = localStorage.getItem('salinha-accounts') || localStorage.getItem('salinha-user');
    if (!alreadyHasData) for (const [k, v] of Object.entries(dump)) localStorage.setItem(k, v);
    window.desktop.migrationDone();
  } catch (e) { console.error('migração', e); }
})();

// Versão do app, disponível desde o início (antes de qualquer conexão).
// No app instalado vem do Electron; na versão web vem de web-version.js (gerado ao publicar).
const IS_WEB = !window.desktop;
window.APP_VERSION = (window.desktop && window.desktop.appVersion) || window.WEB_VERSION || '';

// Na web o navegador só deixa tocar som depois de um clique/tecla: no primeiro gesto,
// libera o áudio e dá play em tudo que estava esperando (voz dos amigos, vídeos).
if (IS_WEB) {
  const unlock = () => {
    try { audioCtx(); } catch { }
    document.querySelectorAll('audio, video').forEach((el) => { if (el.srcObject && el.paused) el.play().catch(() => { }); });
    try { for (const s of sessions.values()) for (const m of s.members.values()) if (m.audio.srcObject && m.audio.paused) m.audio.play().catch(() => { }); } catch { }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

// Tempo parado (para o "Ausente" automático). App: tempo sem mexer no PC. Web: sem mexer nesta aba.
let lastActivity = Date.now();
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
async function idleSeconds() {
  if (window.desktop && window.desktop.idleTime) { try { return await window.desktop.idleTime(); } catch { } }
  return (Date.now() - lastActivity) / 1000;
}
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Servidores TURN (retransmissão) para quem está em rede que bloqueia conexão direta
// (internet móvel, CGNAT). Não existe TURN público gratuito confiável: para ativar, crie uma conta
// grátis num serviço de TURN (ex: Metered ou Cloudflare) e coloque aqui, ex:
//   { urls: ['turn:SEU-HOST:80', 'turn:SEU-HOST:443?transport=tcp'], username: '...', credential: '...' }
const TURN_SERVERS = [];

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...TURN_SERVERS,
    ],
  },
};

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rand = (n = 10) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const genCode = () => Array.from({ length: 8 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
function parseCode(s) {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? c : null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function colorFor(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 55% 45%)`; }
function initials(name, max = 1) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return esc(words.slice(0, max).map((w) => w[0]).join('').toUpperCase() || '?');
}
const cleanName = (s, max = 30) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Hoje às ' + hm;
  return d.toLocaleDateString('pt-BR') + ' ' + hm;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } },
  del(k) { localStorage.removeItem(k); },
};

// ---------------------------------------------------------------- configurações deste PC
const DEFAULT_SETTINGS = { micId: '', outId: '', notify: true, sounds: true, announce: true, theme: 'dark' };
const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('salinha-settings', {}));
const saveSettings = () => store.set('salinha-settings', settings);

// Volumes por pessoa (voz e tela separados), lembrados entre sessões. 0..1
const volumes = store.get('salinha-volumes', {});
const getVol = (uid, kind) => { const v = volumes[uid] && volumes[uid][kind]; return typeof v === 'number' ? v : 1; };
function saveVol(uid, kind, v) {
  if (!uid) return;
  volumes[uid] = { ...(volumes[uid] || {}), [kind]: v };
  store.set('salinha-volumes', volumes);
}

// ---------------------------------------------------------------- tema (escuro / claro / igual ao Windows)
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme || 'dark';
  document.documentElement.dataset.theme = t === 'system' ? (darkMQ.matches ? 'dark' : 'light') : t;
}
darkMQ.addEventListener('change', applyTheme);
applyTheme();

// ---------------------------------------------------------------- perfis
const STATUS = {
  online: { label: 'Disponível', cls: 's-online' },
  idle: { label: 'Ausente', cls: 's-idle' },
  dnd: { label: 'Não perturbe', cls: 's-dnd' },
};
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

// Limpa um perfil que veio da rede (nunca confiar no que chega)
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  if (typeof p.avatar === 'string' && p.avatar.length <= 60000 && AVATAR_RE.test(p.avatar)) out.avatar = p.avatar;
  if (STATUS[p.status]) out.status = p.status;
  if (typeof p.custom === 'string') out.custom = cleanName(p.custom, 80);
  if (typeof p.bio === 'string') out.bio = String(p.bio).slice(0, 300);
  if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) out.color = p.color;
  return out;
}

// Cache de perfis por id de usuário (pra mostrar foto mesmo de quem está offline)
const profileCache = store.get('salinha-profiles', {});
let profileSaveTimer;
function cacheProfile(uid, name, profile) {
  if (!uid) return;
  profileCache[uid] = { name, ...profile, ts: Date.now() };
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => store.set('salinha-profiles', profileCache), 1000);
}

// Reduz a foto escolhida para 128x128 (recorte central) em JPEG, ~10 KB
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Escolha um arquivo de imagem.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 128, c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir essa imagem.')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- áudio
let actx = null;
function audioCtx() {
  if (!actx) {
    actx = new AudioContext();
    if (settings.outId && actx.setSinkId) actx.setSinkId(settings.outId).catch(() => { });
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function beep(freqs) {
  if (!settings.sounds) return;
  try {
    const ctx = audioCtx();
    let t = ctx.currentTime;
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.16);
      t += 0.1;
    }
  } catch { }
}
const soundJoin = () => beep([520, 780]);
const soundLeave = () => beep([780, 520]);
const soundMsg = () => beep([880]);

// Anúncio falado de quem entra/sai do canal de voz ("Gabriel entrou"). Sem voz disponível, toca o bipe.
let ptVoice = null;
function pickVoice() {
  if (typeof speechSynthesis === 'undefined') return null;
  const vs = speechSynthesis.getVoices();
  return vs.find((v) => /pt[-_]BR/i.test(v.lang)) || vs.find((v) => /^pt/i.test(v.lang)) || null;
}
if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = () => { ptVoice = pickVoice(); };
function announceVoice(name, joined) {
  if (!settings.sounds) return;
  if (settings.announce !== false && typeof speechSynthesis !== 'undefined') {
    try {
      ptVoice = ptVoice || pickVoice();
      const u = new SpeechSynthesisUtterance(`${String(name || 'Alguém').slice(0, 24)} ${joined ? 'entrou' : 'saiu'}`);
      u.lang = 'pt-BR';
      if (ptVoice) u.voice = ptVoice;
      u.rate = 1.1; u.volume = 0.9;
      speechSynthesis.speak(u);
      return;
    } catch { }
  }
  joined ? soundJoin() : soundLeave();
}

function watchSpeaking(stream, onChange) {
  try {
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let speaking = false, last = 0;
    const id = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      if (Math.sqrt(sum / buf.length) > 0.03) last = Date.now();
      const s = Date.now() - last < 250;
      if (s !== speaking) { speaking = s; onChange(s); }
    }, 80);
    return () => { clearInterval(id); try { src.disconnect(); } catch { } onChange(false); };
  } catch { return () => { }; }
}

// ---------------------------------------------------------------- ícones (SVG, centralizados)
const svg = (d, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  headphones: svg('M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z'),
  speaker: svg('M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'),
  screen: svg('M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z'),
  hangup: svg('M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z'),
  mic: svg('M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z'),
  micOff: svg('M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5a3 3 0 0 0-6 0v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52a5.2 5.2 0 0 1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z'),
  plus: svg('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'),
  expand: svg('M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z'),
  shrink: svg('M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22z'),
  fullscreen: svg('M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z'),
  volOff: svg('M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z'),
  gear: svg('M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.92 2h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.72 8.47a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z'),
};

// ---------------------------------------------------------------- UI helpers
let toastTimer;
// toast(msg) ou toast(msg, { label: 'Assistir', fn }) para aviso com botão
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'primary sm';
    b.textContent = action.label;
    b.onclick = () => { t.classList.add('hidden'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), action ? 8000 : 2500);
}
async function copyText(t, msg) {
  let ok = false;
  try { if (window.desktop && window.desktop.copy) ok = await window.desktop.copy(t); } catch { }
  if (!ok) { try { await navigator.clipboard.writeText(t); ok = true; } catch { } }
  toast(ok ? (msg || 'Copiado: ' + t) : 'Não consegui copiar. Selecione o texto e use Ctrl+C.');
  return ok;
}

function openModal(html, onMount) {
  const root = $('#modal');
  root.innerHTML = `<div class="modal-card">${html}</div>`;
  root.classList.remove('hidden');
  if (onMount) onMount(root.firstElementChild);
  const first = root.querySelector('input:not([type=checkbox])');
  if (first) setTimeout(() => first.focus(), 0);
}
function closeModal() {
  const root = $('#modal');
  root.classList.add('hidden');
  root.innerHTML = '';
}

// Substitui window.prompt (que não existe no Electron)
function askText({ title, label = '', placeholder = '', value = '', ok = 'Salvar', max = 30 }) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <form class="ask-form">
        <label class="field">${esc(label)}<input maxlength="${max}" placeholder="${esc(placeholder)}" value="${esc(value)}" /></label>
        <div class="modal-actions"><button type="button" class="ghost" data-x>Cancelar</button><button class="primary">${esc(ok)}</button></div>
      </form>`, (card) => {
      card.querySelector('[data-x]').onclick = () => { closeModal(); resolve(null); };
      card.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const v = card.querySelector('input').value.trim();
        if (!v) return;
        closeModal();
        resolve(v);
      };
    });
  });
}

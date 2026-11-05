'use strict';
// ---------------------------------------------------------------- estado da interface
let user = null;   // conta logada: { id, name }
let active = null; // código do servidor aberto, ou null = página inicial

// Contas salvas neste PC. Cada conta tem sua própria lista de servidores
// ("salinha-servers-<id>"); os dados de cada servidor (canais, mensagens) ficam por código.
function loadAccounts() {
  let accs = store.get('salinha-accounts', null);
  if (!accs) {
    // Migra a versão antiga (uma conta só)
    accs = [];
    const old = store.get('salinha-user', null);
    if (old && old.id) {
      accs.push({ id: old.id, name: old.name });
      store.set('salinha-servers-' + old.id, store.get('salinha-servers', []));
    }
    store.set('salinha-accounts', accs);
    store.del('salinha-user');
    store.del('salinha-servers');
  }
  return accs;
}
const PROFILE_FIELDS = ['avatar', 'status', 'custom', 'bio', 'color'];
const INSTALLER_URL = 'https://github.com/gabrielcll1978-stack/salinha/releases/latest';
function saveAccount(acc) {
  const accs = loadAccounts();
  const i = accs.findIndex((a) => a.id === acc.id);
  const clean = { id: acc.id, name: acc.name };
  for (const k of PROFILE_FIELDS) if (acc[k]) clean[k] = acc[k];
  if (i >= 0) accs[i] = clean; else accs.push(clean);
  store.set('salinha-accounts', accs);
}

// ---------------------------------------------------------------- perfil
let autoIdle = false; // "Ausente" automático por inatividade
const myStatus = () => (autoIdle && (user.status || 'online') === 'online' ? 'idle' : (user.status || 'online'));
function myProfile() {
  const p = { status: myStatus() };
  for (const k of ['avatar', 'custom', 'bio', 'color']) if (user[k]) p[k] = user[k];
  return p;
}
function profileOf(uid) {
  if (user && uid === user.id) return { name: user.name, ...myProfile() };
  for (const s of sessions.values()) for (const m of s.members.values()) if (m.uid === uid && m.named) return { name: m.name, ...m.profile };
  return profileCache[uid] || null;
}
function broadcastProfile() { for (const s of sessions.values()) s.sendProfile(); }

// Avatar (foto ou inicial). p: { uid?, id?, name }
function avatarHTML(p, cls = '', withStatus = false) {
  const pr = p.uid ? profileOf(p.uid) : null;
  const img = pr && pr.avatar;
  const inner = img
    ? `<span class="avatar ${cls}" style="background-image:url('${img}')"></span>`
    : `<span class="avatar ${cls}" style="background:${colorFor(p.uid || p.id)}">${initials(p.name)}</span>`;
  if (!withStatus) return inner;
  const st = STATUS[(pr && pr.status) || 'online'] || STATUS.online;
  return `<span class="av-wrap">${inner}<i class="sdot ${st.cls}" title="${st.label}"></i></span>`;
}

// Notificação do Windows para mensagem nova
function notifyMessage(s, cid) {
  if (!settings.notify || myStatus() === 'dnd' || typeof Notification === 'undefined') return;
  const c = s.channel(cid);
  const m = s.msgs(cid).slice(-1)[0];
  if (!c || !m || m.uid === user.id) return;
  const pr = profileOf(m.uid);
  try {
    const n = new Notification(`${m.author} (#${c.name} · ${s.name})`, {
      body: m.att ? ('📷 Imagem' + (m.text && m.text !== IMG_PLACEHOLDER ? ': ' + m.text.slice(0, 180) : '')) : m.text.slice(0, 200), icon: (pr && pr.avatar) || '../build/icon.png', silent: true,
    });
    n.onclick = () => {
      if (window.desktop && window.desktop.focusWindow) window.desktop.focusWindow();
      active = s.code;
      setView(s, { type: 'text', cid });
      renderAll();
    };
  } catch { }
}
const serversOf = (uid) => store.get('salinha-servers-' + uid, []);
const serverList = () => (user ? serversOf(user.id) : []);
const saveServerList = (l) => store.set('salinha-servers-' + user.id, l);
const activeSession = () => (active ? sessions.get(active) : null);

const ICON_MIC_OFF = '<svg class="ico-red" viewBox="0 0 24 24"><title>mutado</title><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5a3 3 0 0 0-6 0v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52a5.2 5.2 0 0 1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
const ICON_DEAF = '<svg class="ico-red" viewBox="0 0 24 24"><title>ensurdecido</title><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z"/><path d="M3 4.3 4.3 3 21 19.7 19.7 21z"/></svg>';
// s: sessão — quando passada, o "AO VIVO" vira botão de assistir
const badges = (p, s) => (p.sharing
  ? `<span class="live-pill${s ? ' watch' : ''}"${s ? ` data-action="watch" data-code="${s.code}" data-id="${esc(p.id)}" title="Assistir a tela"` : ''}>${s ? '▶ ' : ''}AO VIVO</span>`
  : '') + (p.deaf ? ICON_DEAF : p.muted ? ICON_MIC_OFF : '');

// Sliders de volume de uma pessoa (voz e, se estiver compartilhando, som da tela)
function volumeSliders(m) {
  return `<div class="vols">
    <label class="vol-row" title="Volume da voz">🎙️<input type="range" class="vol" min="0" max="100" value="${Math.round(m.volume * 100)}" data-vol="${m.id}" data-kind="voice"></label>
    ${m.sharing ? `<label class="vol-row" title="Volume do som da tela">🖥️<input type="range" class="vol" min="0" max="100" value="${Math.round(m.screenVolume * 100)}" data-vol="${m.id}" data-kind="screen"></label>` : ''}
  </div>`;
}

// Visão atual de um servidor: { type: 'text' | 'voice' | 'none', cid }
function viewOf(s) {
  const v = store.get('salinha-view-' + s.code, null);
  if (v && s.channel(v.cid) && canAccess(s.state, user.id, v.cid)) return v;
  const t = s.visibleChannels('text')[0];
  if (t) return { type: 'text', cid: t.id };
  const vc = s.visibleChannels('voice')[0];
  return vc ? { type: 'voice', cid: vc.id } : { type: 'none' };
}
function setView(s, view) {
  store.set('salinha-view-' + s.code, view);
  if (view.cid) s.unread.delete(view.cid);
  renderMain();
  ui.refresh();
}

// Participantes de um canal de voz (inclui você)
function voiceParticipants(s, cid) {
  const list = [];
  if (voice.code === s.code && voice.cid === cid) {
    list.push({ id: 'me', uid: user.id, name: user.name, muted, deaf, sharing: screenStream ? shareInfo : null, me: true });
  }
  for (const m of s.members.values()) if (m.named && m.vc === cid) list.push(m);
  return list;
}

// ---------------------------------------------------------------- ui (chamado pela rede)
const ui = {
  pending: false,
  refresh() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (!user || $('#app').classList.contains('hidden')) return;
      renderRail(); renderSidebar(); renderMembers(); renderUserPanel(); renderVoicePanel(); renderVoiceView();
    });
  },
  onServerChanged(s) {
    // Canal de voz em que estou foi apagado?
    if (voice.code === s.code && (!s.channel(voice.cid) || !canAccess(s.state, user.id, voice.cid))) leaveVoice();
    if (active === s.code) renderMain();
    this.refresh();
  },
  onMessage(s, cid, live) {
    const v = viewOf(s);
    const viewing = active === s.code && v.type === 'text' && v.cid === cid;
    if (viewing) renderChat();
    else { s.unread.add(cid); if (live && myStatus() !== 'dnd') soundMsg(); }
    if (live && (!viewing || !document.hasFocus())) notifyMessage(s, cid);
    this.refresh();
  },
  // Conectou com alguém: avisa (uma vez) se a pessoa está com versão mais antiga que a minha
  warnedOld: new Set(),
  onPeerVersion(s, m) {
    const mine = window.APP_VERSION;
    if (!mine || this.warnedOld.has(m.uid)) return;
    if (!m.version || cmpVersion(m.version, mine) < 0) {
      this.warnedOld.add(m.uid);
      toast(`⚠ ${m.name} está com uma versão antiga do Sampsoncord${m.version ? ' (v' + m.version + ')' : ''}. Algumas coisas podem não funcionar pra ele: peça pra atualizar.`);
    }
  },
  // Alguém do meu canal de voz começou a compartilhar a tela
  onShareStarted(s, m) {
    const v = viewOf(s);
    const looking = active === s.code && v.type === 'voice' && v.cid === m.vc && document.hasFocus();
    if (!$('#tiles .tile')) pendingFocus = m.id; // primeira tela do canal: já abre ampliada
    if (!looking) toast(`🖥️ ${m.name} começou a compartilhar a tela`, { label: 'Assistir', fn: () => watchScreen(s.code, m.id) });
  },
  onProfileChanged() {
    this.refresh();
    if (this.chatTimer) return; // fotos no chat: re-desenha no máximo 1x por segundo
    this.chatTimer = setTimeout(() => { this.chatTimer = null; renderChat(); }, 300);
  },
};

// Estilo do ícone de servidor: foto (se tiver) ou cor + iniciais
function srvIconStyle(s, isActive) {
  if (s.state.icon && AVATAR_RE.test(s.state.icon)) return `style="background:center/cover url('${s.state.icon}')"`;
  return `style="background:${isActive ? 'var(--accent)' : colorFor(s.code)}"`;
}

// ---------------------------------------------------------------- render: barra de servidores
function renderRail() {
  let html = `<button class="rail-btn home ${active ? '' : 'active'}" data-action="home" title="Início"><img src="../build/icon.png" alt=""></button><div class="rail-sep"></div>`;
  for (const code of serverList()) {
    const s = sessions.get(code);
    if (!s) continue;
    const unread = s.unread.size > 0;
    html += `<button class="rail-btn ${active === code ? 'active' : ''} ${unread ? 'unread' : ''}" data-action="server" data-code="${code}" title="${esc(s.name)}" ${srvIconStyle(s, active === code)}>${s.state.icon ? '' : initials(s.name, 2)}</button>`;
  }
  html += `<button class="rail-btn add" data-action="add-server" title="Criar ou entrar em servidor">${ICON.plus}</button>`;
  $('#rail').innerHTML = html;
}

// ---------------------------------------------------------------- render: barra de canais
function renderSidebar() {
  const s = activeSession();
  if (!s) {
    $('#side-header').innerHTML = '<div class="side-title">Início</div>';
    const list = serverList().map((c) => sessions.get(c)).filter(Boolean);
    $('#side-body').innerHTML = `
      <div class="section-title">SEUS SERVIDORES</div>
      ${list.map((x) => `<button class="row" data-action="server" data-code="${x.code}"><span class="mini-ico" ${srvIconStyle(x)}>${x.state.icon ? '' : initials(x.name, 2)}</span><span class="row-name">${esc(x.name)}</span></button>`).join('') || '<div class="muted pad">Nenhum servidor ainda.</div>'}
    `;
    return;
  }
  const v = viewOf(s);
  const dd = $('#side-header .dropdown');
  const open = dd && !dd.classList.contains('hidden') && $('#side-header').dataset.code === s.code;
  $('#side-header').dataset.code = s.code;
  $('#side-header').innerHTML = `
    <button class="side-title btn-title" data-action="server-menu">${esc(s.name)} <span class="chev">▾</span></button>
    <div class="dropdown ${open ? '' : 'hidden'}">
      <div class="dd-code">Código de convite<b>${fmtCode(s.code)}</b></div>
      <button data-action="copy-code">📋 Copiar código</button>
      <button data-action="server-settings">⚙️ Configurações do servidor</button>
      <button data-action="leave-server" class="red">🚪 Sair do servidor</button>
    </div>`;

  const st = s.state;
  const canCh = can(st, user.id, 'manageChannels');
  const lock = (c) => (st.perms && st.perms.access && st.perms.access[c.id] ? ' <span class="lock" title="Canal restrito a alguns cargos">🔒</span>' : '');
  const status = s.online ? `<span class="dot on"></span>${s.onlineCount()} online` : '<span class="dot"></span>conectando…';
  let html = `<div class="srv-status">${status}</div>`;
  if (s.failed.size) html += `<button class="conn-warn" data-action="conn-help">⚠ Não consegui conectar com ${s.failed.size} pessoa${s.failed.size > 1 ? 's' : ''}. Por quê?</button>`;

  html += `<div class="section-title">CANAIS DE TEXTO ${canCh ? '<button class="add-ch" data-action="add-channel" data-type="text" title="Criar canal de texto">+</button>' : ''}</div>`;
  for (const c of s.visibleChannels('text')) {
    const sel = v.type === 'text' && v.cid === c.id;
    html += `<div class="row ch ${sel ? 'active' : ''} ${s.unread.has(c.id) ? 'unread' : ''}" data-action="channel" data-cid="${c.id}">
      <span class="ch-ico">#</span><span class="row-name">${esc(c.name)}${lock(c)}</span>
      ${canCh ? `<button class="del-ch" data-action="del-channel" data-cid="${c.id}" title="Apagar canal">✕</button>` : ''}</div>`;
  }
  html += `<div class="section-title">CANAIS DE VOZ ${canCh ? '<button class="add-ch" data-action="add-channel" data-type="voice" title="Criar canal de voz">+</button>' : ''}</div>`;
  for (const c of s.visibleChannels('voice')) {
    const sel = v.type === 'voice' && v.cid === c.id;
    const here = voice.code === s.code && voice.cid === c.id;
    html += `<div class="row ch ${sel ? 'active' : ''} ${here ? 'connected' : ''}" data-action="channel" data-cid="${c.id}">
      <span class="ch-ico">${ICON.speaker}</span><span class="row-name">${esc(c.name)}${lock(c)}</span>
      ${canCh ? `<button class="del-ch" data-action="del-channel" data-cid="${c.id}" title="Apagar canal">✕</button>` : ''}</div>`;
    for (const p of voiceParticipants(s, c.id)) {
      const sp = p.me ? 'me' : p.id;
      html += `<div class="vc-user ${speaking.has(sp) ? 'speaking' : ''}" data-speak="${sp}" data-action="profile" data-uid="${esc(p.uid || '')}">
        ${avatarHTML(p, 'xs')}
        <span class="row-name">${esc(p.name)}</span><span class="badges">${badges(p, s)}</span></div>`;
    }
  }
  $('#side-body').innerHTML = html;
}

function renderUserPanel() {
  const wrap = $('#me-avatar-wrap');
  wrap.innerHTML = avatarHTML({ uid: user.id, name: user.name }, '', true);
  wrap.classList.toggle('speaking', speaking.has('me'));
  $('#me-name').textContent = user.name;
  const st = STATUS[myStatus()];
  $('#me-status').textContent = user.custom || (voice.code ? 'Na voz' : st.label);
  $('#btn-settings').innerHTML = ICON.gear;
  $('#btn-mute').classList.toggle('off', muted);
  $('#btn-deaf').classList.toggle('off', deaf);
  $('#btn-mute').title = muted ? 'Desmutar' : 'Mutar microfone';
  $('#btn-deaf').title = deaf ? 'Voltar a ouvir' : 'Ensurdecer';
}

function renderVoicePanel() {
  const s = voiceSession();
  const el = $('#voice-panel');
  if (!s) { el.classList.add('hidden'); return; }
  const c = s.channel(voice.cid);
  el.classList.remove('hidden');
  el.innerHTML = `
    <button class="vp-info" data-action="goto-voice">
      <div class="vp-status">● Voz conectada</div>
      <div class="vp-where">${esc(c ? c.name : '')} / ${esc(s.name)}</div>
    </button>
    <button class="icon-btn ${screenStream ? 'on-live' : ''}" data-action="share" title="${screenStream ? 'Parar de compartilhar' : 'Compartilhar tela'}">${ICON.screen}</button>
    <button class="icon-btn danger-bg" data-action="disconnect" title="Desconectar">${ICON.hangup}</button>`;
}

// ---------------------------------------------------------------- render: membros online
function renderMembers() {
  const s = activeSession();
  const el = $('#members');
  if (!s) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const list = [{ id: 'me', uid: user.id, name: user.name + ' (você)', vc: voice.code === s.code ? voice.cid : null, muted, deaf, sharing: voice.code === s.code && screenStream ? shareInfo : null, me: true },
    ...[...s.members.values()].filter((m) => m.named)];
  let html = `<div class="section-title">ONLINE — ${list.length}</div>`;
  for (const p of list) {
    const ch = p.vc && s.channel(p.vc);
    const sp = p.me ? 'me' : p.id;
    const canVol = !p.me && inMyChannel(s, p);
    const pr = profileOf(p.uid) || {};
    const old = !p.me && window.APP_VERSION && (!p.version || cmpVersion(p.version, window.APP_VERSION) < 0);
    html += `<div class="member ${speaking.has(sp) ? 'speaking' : ''}" data-speak="${sp}" data-action="profile" data-uid="${esc(p.uid || '')}">
      ${avatarHTML(p, '', true)}
      <div class="info"><div class="mname" ${roleColor(s.state, p.uid) ? `style="color:${roleColor(s.state, p.uid)}"` : ''}>${esc(p.name)}${old ? ' <span class="old-tag" title="Está com uma versão antiga do Sampsoncord">antiga</span>' : ''}</div>
        ${ch ? `<div class="msub">${ICON.speaker}${esc(ch.name)}</div>` : pr.custom ? `<div class="msub">${esc(pr.custom)}</div>` : ''}
        ${canVol ? volumeSliders(p) : ''}
      </div><span class="badges">${badges(p, p.vc ? s : null)}</span></div>`;
  }
  if (s.members.size === 0) html += `<div class="muted pad small">Ninguém mais online. Convide a galera com o código <b>${fmtCode(s.code)}</b>.</div>`;
  // não re-renderiza enquanto arrasta o volume
  if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.vol && el.contains(document.activeElement)) return;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- render: área principal
function showView(id) { $$('.view').forEach((v) => v.classList.toggle('shown', v.id === id)); }

function renderMain() {
  const s = activeSession();
  if (!s) {
    $('#main-header').innerHTML = '<span>🏠 Início</span>';
    renderHome();
    showView('home-view');
    return;
  }
  const v = viewOf(s);
  if (v.type === 'none') {
    $('#main-header').innerHTML = `<span>${esc(s.name)}</span>`;
    $('#wait-view').innerHTML = `<div class="center-box">
      <div class="big-emoji">⏳</div><h2>Sincronizando servidor…</h2>
      <p class="muted">Para baixar os canais e mensagens, alguém que já é membro desse servidor precisa estar online.<br>Assim que alguém aparecer, tudo carrega sozinho.</p>
      <p>Código: <b>${fmtCode(s.code)}</b></p>
      ${s.failed.size ? `<p><button class="conn-warn" data-action="conn-help">⚠ Achei alguém online, mas não consegui conectar. Por quê?</button></p>` : ''}
      <p class="muted small">Dica: todo mundo precisa estar com o Sampsoncord <b>instalado</b> (não o .exe antigo da Salinha).</p></div>`;
    showView('wait-view');
    return;
  }
  const c = s.channel(v.cid);
  if (v.type === 'text') {
    $('#main-header').innerHTML = `<span class="ch-ico">#</span><span>${esc(c.name)}</span>`;
    $('#chat-input').placeholder = `Conversar em #${c.name}`;
    showView('text-view');
    renderChat(true);
    $('#chat-input').focus();
  } else {
    $('#main-header').innerHTML = `<span class="ch-ico">${ICON.speaker}</span><span>${esc(c.name)}</span>`;
    showView('voice-view');
    renderVoiceView();
  }
}

function renderHome() {
  const list = serverList().map((c) => sessions.get(c)).filter(Boolean);
  $('#home-view').innerHTML = `
    <div class="home-page">
      <h1>Olá, ${esc(user.name)}! 👋</h1>
      <p class="muted">Crie um servidor para a galera ou entre em um com o código de convite.</p>
      <div class="home-actions">
        <button class="home-card" data-action="create-server"><div class="big-emoji">✨</div><b>Criar servidor</b><span class="muted">Gera um código para chamar os amigos</span></button>
        <button class="home-card" data-action="join-server"><div class="big-emoji">🔑</div><b>Entrar com código</b><span class="muted">Use o código que um amigo te passou</span></button>
      </div>
      ${list.length ? `<h3>Seus servidores</h3><div class="server-cards">${list.map((s) => `
        <button class="server-card" data-action="server" data-code="${s.code}">
          <span class="srv-ico" ${srvIconStyle(s)}>${s.state.icon ? '' : initials(s.name, 2)}</span>
          <span class="srv-txt"><b>${esc(s.name)}</b><span class="muted">${fmtCode(s.code)} · ${s.online ? s.onlineCount() + ' online' : 'conectando…'}</span></span>
        </button>`).join('')}</div>` : ''}
      <div class="app-version muted small home-version">${window.APP_VERSION ? 'Sampsoncord v' + window.APP_VERSION : ''}</div>
    </div>`;
}

function renderChat(forceBottom) {
  const s = activeSession();
  if (!s) return;
  const v = viewOf(s);
  if (v.type !== 'text') return;
  const c = s.channel(v.cid);
  const log = $('#chat-log');
  const atBottom = forceBottom || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  let html = `<div class="chat-welcome"><div class="welcome-ico">#</div><h2>Bem-vindo(a) a #${esc(c.name)}!</h2><p class="muted">Esse é o começo do canal #${esc(c.name)}.</p></div>`;
  let prev = null;
  for (const m of s.msgs(v.cid)) {
    const grouped = prev && prev.uid === m.uid && m.ts - prev.ts < 5 * 60e3;
    const content = msgContent(m);
    const color = roleColor(s.state, m.uid) || colorFor(m.uid);
    if (grouped) html += `<div class="msg cont">${content}</div>`;
    else html += `<div class="msg"><span class="clickable" data-action="profile" data-uid="${esc(m.uid)}">${avatarHTML({ uid: m.uid, name: m.author })}</span><div class="body">
      <div><span class="who clickable" data-action="profile" data-uid="${esc(m.uid)}" style="color:${color}">${esc(m.author)}</span><span class="time">${fmtTime(m.ts)}</span></div>
      ${content}</div></div>`;
    prev = m;
  }
  log.innerHTML = html;
  if (atBottom) log.scrollTop = log.scrollHeight;
  attachments.hydrate(log);
  hydratePreviews(log).then(() => { if (atBottom) log.scrollTop = log.scrollHeight; });
  // imagens que carregam depois mudam a altura: mantém no fim se já estava no fim
  $$('img', log).forEach((img) => img.addEventListener('load', () => { if (atBottom) log.scrollTop = log.scrollHeight; }, { once: true }));
}

// Corpo de uma mensagem: texto com links, imagem anexada e prévia do primeiro link
function msgContent(m) {
  let out = '';
  const text = m.att && m.text === IMG_PLACEHOLDER ? '' : m.text;
  if (text) out += `<div class="text">${linkify(text)}</div>`;
  if (m.att) {
    const ratio = m.att.w && m.att.h ? `style="aspect-ratio:${m.att.w}/${m.att.h}"` : '';
    out += `<img class="chat-img loading" data-att="${esc(m.att.id)}" ${ratio} alt="imagem">`;
  }
  const url = (text.match(URL_RE) || [])[0];
  if (url) out += `<div class="link-preview" data-url="${esc(url)}"></div>`;
  return out;
}

function renderVoiceView() {
  const s = activeSession();
  if (!s || !$('#voice-view').classList.contains('shown')) return;
  const v = viewOf(s);
  if (v.type !== 'voice') return;
  const c = s.channel(v.cid);
  const here = voice.code === s.code && voice.cid === v.cid;
  const join = $('#voice-join');
  $('#tiles').classList.toggle('hidden', !here);
  $('#voice-controls').classList.toggle('hidden', !here);
  if (!here) {
    const people = voiceParticipants(s, v.cid);
    join.classList.remove('hidden');
    join.innerHTML = `<div class="center-box"><div class="big-ico">${ICON.speaker}</div><h2>${esc(c.name)}</h2>
      <p class="muted">${people.length ? people.map((p) => esc(p.name)).join(', ') + (people.length > 1 ? ' estão' : ' está') + ' aqui.' : 'Ninguém no canal ainda.'}</p>
      <button class="primary big" data-action="join-voice" data-cid="${v.cid}">Entrar na voz</button></div>`;
    $('#voice-people').innerHTML = '';
    return;
  }
  join.classList.add('hidden');
  const hasTiles = !!$('#tiles .tile');
  $('#voice-view').classList.toggle('with-tiles', hasTiles);
  $('#voice-people').innerHTML = voiceParticipants(s, v.cid).map((p) => {
    const sp = p.me ? 'me' : p.id;
    const watching = p.sharing && $(`.tile.focused[data-id="${sp}"]`);
    return `<div class="person ${speaking.has(sp) ? 'speaking' : ''} ${p.sharing ? 'sharing' : ''}" data-speak="${sp}" data-action="profile" data-uid="${esc(p.uid || '')}">
      ${avatarHTML(p, 'xl')}
      <div class="pname">${esc(p.name)} ${badges(p, s)}</div>
      ${p.sharing && !watching ? `<button class="primary sm watch-btn" data-action="watch" data-code="${s.code}" data-id="${sp}">▶ ${p.me ? 'Ver minha tela' : 'Assistir tela'}</button>` : ''}
    </div>`;
  }).join('');
  $('#vc-mute').innerHTML = muted ? ICON.micOff : ICON.mic;
  $('#vc-share').innerHTML = ICON.screen;
  $('#vc-hangup').innerHTML = ICON.hangup;
  $('#vc-mute').classList.toggle('off', muted);
  $('#vc-share').classList.toggle('on-live', !!screenStream);
  $('#vc-share').title = screenStream ? 'Parar de compartilhar' : 'Compartilhar tela';
  $$('#tiles .tile').forEach((t) => { if (t.dataset.id !== 'yt') t.querySelector('.lbl').textContent = tileLabel(t.dataset.id); });
}

function renderAll() { renderMain(); ui.refresh(); }

// ---------------------------------------------------------------- servidores
function openServer(code) {
  active = code;
  const s = sessions.get(code);
  const v = viewOf(s);
  if (v.cid) s.unread.delete(v.cid);
  renderAll();
}

function createServer(name) {
  const code = genCode();
  store.set('salinha-server-' + code, newServerState(code, cleanName(name, 40), user.id));
  saveServerList([...serverList(), code]);
  sessions.set(code, new ServerSession(code));
  openServer(code);
  openModal(`<h2>Servidor criado! 🎉</h2>
    <p>Passe este código para seus amigos entrarem:</p>
    <div class="big-code">${fmtCode(code)}</div>
    <div class="modal-actions"><button class="ghost" data-x>Fechar</button><button class="primary" data-copy>📋 Copiar código</button></div>`,
  (card) => {
    card.querySelector('[data-x]').onclick = closeModal;
    card.querySelector('[data-copy]').onclick = () => { copyText(fmtCode(code)); closeModal(); };
  });
}

function joinServer(code) {
  if (!serverList().includes(code)) {
    saveServerList([...serverList(), code]);
    sessions.set(code, new ServerSession(code));
  }
  openServer(code);
}

function openServerModal(mode) {
  openModal(`
    <div class="tabs"><button data-tab="create" class="${mode === 'create' ? 'on' : ''}">Criar servidor</button><button data-tab="join" class="${mode === 'join' ? 'on' : ''}">Entrar com código</button></div>
    <form data-pane="create" class="${mode === 'create' ? '' : 'hidden'}">
      <label class="field">Nome do servidor<input name="name" maxlength="40" placeholder="ex: Galera do FDS" value="Servidor de ${esc(user.name)}"></label>
      <div class="modal-actions"><button type="button" class="ghost" data-x>Cancelar</button><button class="primary">Criar</button></div>
    </form>
    <form data-pane="join" class="${mode === 'join' ? '' : 'hidden'}">
      <label class="field">Código de convite<input name="code" maxlength="12" placeholder="ex: K7QM-29XA" style="text-transform:uppercase"></label>
      <p class="error" data-err></p>
      <div class="modal-actions"><button type="button" class="ghost" data-x>Cancelar</button><button class="primary">Entrar</button></div>
    </form>`, (card) => {
    $$('[data-x]', card).forEach((b) => (b.onclick = closeModal));
    $$('[data-tab]', card).forEach((b) => (b.onclick = () => {
      $$('[data-tab]', card).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', card).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      const i = card.querySelector(`[data-pane="${b.dataset.tab}"] input`); i.focus(); i.select();
    }));
    card.querySelector('[data-pane="create"]').onsubmit = (e) => {
      e.preventDefault();
      const name = cleanName(e.target.name.value, 40);
      if (!name) return;
      closeModal();
      createServer(name);
    };
    card.querySelector('[data-pane="join"]').onsubmit = (e) => {
      e.preventDefault();
      const code = parseCode(e.target.code.value);
      if (!code) { card.querySelector('[data-err]').textContent = 'Código inválido. Ele tem 8 caracteres, tipo K7QM-29XA.'; return; }
      closeModal();
      joinServer(code);
    };
    const i = card.querySelector(`[data-pane="${mode}"] input`); setTimeout(() => { i.focus(); i.select(); }, 0);
  });
}

function leaveServer(s) {
  if (!confirm(`Sair do servidor "${s.name}"? As mensagens salvas nesse PC serão apagadas.`)) return;
  if (voice.code === s.code) leaveVoice();
  s.destroy();
  sessions.delete(s.code);
  saveServerList(serverList().filter((c) => c !== s.code));
  const usedByOther = loadAccounts().some((a) => a.id !== user.id && serversOf(a.id).includes(s.code));
  if (!usedByOther) {
    for (const c of Object.keys(s.state.channels)) store.del(s.msgKey(c));
    store.del('salinha-server-' + s.code);
    store.del('salinha-view-' + s.code);
  }
  active = null;
  renderAll();
}

// ---------------------------------------------------------------- ações (cliques)
const actions = {
  home: () => { active = null; renderAll(); },
  server: (el) => openServer(el.dataset.code),
  'add-server': () => openServerModal('create'),
  'create-server': () => openServerModal('create'),
  'join-server': () => openServerModal('join'),
  'server-menu': () => $('#side-header .dropdown').classList.toggle('hidden'),
  'copy-code': () => { copyText(fmtCode(active)); $('#side-header .dropdown').classList.add('hidden'); },
  'rename-server': async () => {
    const s = activeSession();
    const name = await askText({ title: 'Renomear servidor', label: 'Nome do servidor', value: s.name, max: 40 });
    if (name) s.rename(name);
  },
  'leave-server': () => leaveServer(activeSession()),
  channel: (el) => {
    const s = activeSession(), c = s.channel(el.dataset.cid);
    if (!c) return;
    setView(s, { type: c.type, cid: c.id });
    if (c.type === 'voice') joinVoice(s, c.id);
  },
  'join-voice': (el) => joinVoice(activeSession(), el.dataset.cid),
  'goto-voice': () => {
    const s = voiceSession();
    if (!s) return;
    active = s.code;
    setView(s, { type: 'voice', cid: voice.cid });
    renderAll();
  },
  'add-channel': async (el) => {
    const s = activeSession(), type = el.dataset.type;
    const name = await askText({
      title: type === 'text' ? 'Criar canal de texto' : 'Criar canal de voz',
      label: 'Nome do canal', placeholder: type === 'text' ? 'ex: memes' : 'ex: Jogando', ok: 'Criar',
    });
    if (!name) return;
    const id = s.createChannel(type, type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name);
    setView(s, { type, cid: id });
    if (type === 'voice') joinVoice(s, id);
  },
  'del-channel': (el) => {
    const s = activeSession(), c = s.channel(el.dataset.cid);
    if (c && confirm(`Apagar o canal "${c.name}" para todo mundo?`)) s.deleteChannel(c.id);
  },
  mute: () => { if (deaf) setDeaf(false); else setMuted(!muted); },
  deaf: () => setDeaf(!deaf),
  share: () => (screenStream ? (stopShare(), ui.refresh()) : openSharePicker()),
  disconnect: () => leaveVoice(),
  account: () => openAccountModal(),
  settings: () => openSettingsModal(),
  watch: (el) => watchScreen(el.dataset.code, el.dataset.id),
  yt: () => watchTogether.askLink(),
  'server-settings': () => openServerSettings(activeSession()),
  'conn-help': () => openModal(`
    <h2>Por que não conectou?</h2>
    <p>O Sampsoncord liga um PC direto no outro. Encontramos alguém no servidor, mas a conexão direta não fechou. As causas mais comuns:</p>
    <ul class="help-list">
      <li><b>Versão antiga:</b> quem usa o primeiro <code>Salinha.exe</code> (sem instalar) está em outro sistema e não se atualiza.
        Precisa instalar a versão nova: <code>github.com/gabrielcll1978-stack/salinha/releases/latest</code></li>
      <li><b>Rede que bloqueia conexão direta:</b> internet de celular (roteador 4G/5G), alguns provedores com CGNAT ou redes de empresa/escola.
        Tente outra rede (ex: cabo/Wi-Fi de casa) ou reinicie o roteador.</li>
      <li><b>Firewall/antivírus</b> bloqueando o Sampsoncord: libere o app quando o Windows perguntar.</li>
    </ul>
    <p class="muted small">O app tenta de novo sozinho. Assim que a conexão fechar, a pessoa aparece na lista.</p>
    <div class="modal-actions"><button class="primary" data-x>Entendi</button></div>`, (c) => { c.querySelector('[data-x]').onclick = closeModal; }),
  profile: (el) => { if (el.dataset.uid) openProfileCard(el.dataset.uid); },
  'status-menu': () => toggleStatusMenu(),
  'set-status': (el) => {
    user.status = el.dataset.status;
    saveAccount(user);
    broadcastProfile();
    $('#status-menu').classList.add('hidden');
    ui.refresh();
  },
  'login-acc': (el) => {
    const acc = loadAccounts().find((a) => a.id === el.dataset.id);
    if (acc) enterAccount(acc);
  },
  'del-acc': (el) => {
    const acc = loadAccounts().find((a) => a.id === el.dataset.id);
    if (!acc || !confirm(`Remover a conta "${acc.name}" deste PC?\n\nDica: antes, copie o código da conta (em "Minha conta") se quiser usá-la de novo.`)) return;
    store.set('salinha-accounts', loadAccounts().filter((a) => a.id !== acc.id));
    store.del('salinha-servers-' + acc.id);
    renderLogin();
  },
  'import-acc': () => openImportModal(),
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('#status-menu') && !e.target.closest('[data-action="status-menu"]')) $('#status-menu').classList.add('hidden');
  // cliques em campos (ex: slider de volume dentro de um membro) não abrem nada
  if (e.target.matches('input, textarea, select') && !e.target.dataset.action) return;
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (!e.target.closest('#side-header')) $$('#side-header .dropdown').forEach((d) => d.classList.add('hidden'));
    return;
  }
  e.stopPropagation();
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Abre a tela de alguém: vai pro canal de voz dela (entra se precisar) e amplia a tela
function watchScreen(code, id) {
  const s = sessions.get(code);
  if (!s) return;
  closeModal();
  let cid;
  if (id === 'me') cid = voice.code === code ? voice.cid : null;
  else { const m = s.members.get(id); cid = m && m.vc; if (m) resumeWatching(s, m); }
  if (!cid) return;
  active = code;
  setView(s, { type: 'voice', cid });
  if (!(voice.code === code && voice.cid === cid)) joinVoice(s, cid);
  if ($(`.tile[data-id="${id}"]`)) focusTile(id); else pendingFocus = id;
  renderAll();
}

document.addEventListener('input', (e) => {
  const id = e.target.dataset && e.target.dataset.vol;
  if (!id) return;
  const s = voiceSession(), m = s && s.members.get(id);
  if (m) setMemberVolume(m, e.target.dataset.kind === 'screen' ? 'screen' : 'voice', e.target.value / 100);
});

// ---------------------------------------------------------------- enviar mensagem (texto + imagem)
let pendingImage = null; // { data, w, h } esperando o "enviar"

async function setPendingImage(file) {
  try {
    pendingImage = await attachments.prepare(file);
    $('#attach-preview').innerHTML = `<img src="${pendingImage.data}" alt=""><span>Imagem pronta: aperte Enter para enviar</span><button type="button" class="ghost sm" id="attach-cancel">✕</button>`;
    $('#attach-preview').classList.remove('hidden');
    $('#attach-cancel').onclick = clearPendingImage;
    $('#chat-input').focus();
  } catch (e) { toast(e.message); }
}
function clearPendingImage() {
  pendingImage = null;
  $('#attach-preview').classList.add('hidden');
  $('#attach-preview').innerHTML = '';
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = activeSession();
  const text = $('#chat-input').value.trim();
  if (!s || (!text && !pendingImage)) return;
  const v = viewOf(s);
  if (v.type !== 'text') return;
  $('#chat-input').value = '';
  let att = null;
  if (pendingImage) {
    att = { id: rand(14), w: pendingImage.w, h: pendingImage.h };
    await attachments.put(att.id, pendingImage.data);
    clearPendingImage();
  }
  s.sendMsg(v.cid, text || (att ? IMG_PLACEHOLDER : ''), att);
  renderChat(true);
});
$('#btn-attach').addEventListener('click', () => $('#attach-file').click());
$('#attach-file').addEventListener('change', (e) => { if (e.target.files[0]) setPendingImage(e.target.files[0]); e.target.value = ''; });
// Ctrl+V com imagem copiada
$('#chat-input').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); setPendingImage(item.getAsFile()); }
});
// arrastar e soltar imagem no chat
$('#text-view').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#text-view').classList.add('dropping'); } });
$('#text-view').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('#text-view').contains(e.relatedTarget)) $('#text-view').classList.remove('dropping'); });
$('#text-view').addEventListener('drop', (e) => {
  e.preventDefault(); $('#text-view').classList.remove('dropping');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) setPendingImage(f); else toast('Por enquanto só dá para enviar imagens.');
});

window.addEventListener('beforeunload', () => { for (const s of sessions.values()) s.destroy(); });

// ---------------------------------------------------------------- contas
function renderLogin() {
  const last = store.get('salinha-last-account', null);
  const accs = loadAccounts().slice().sort((a, b) => (b.id === last) - (a.id === last));
  $('#login').innerHTML = `
    <div class="login-card">
      <img class="logo-img" src="../build/icon.png" alt="">
      <h1>Sampsoncord</h1>
      <p class="muted center">Voz, chat e compartilhamento de tela com a galera.</p>
      ${accs.length ? `
        <div class="section-title">CONTAS NESTE PC</div>
        <div class="acc-list">${accs.map((a) => {
          const n = serversOf(a.id).length;
          return `<div class="acc" data-action="login-acc" data-id="${a.id}">
            ${a.avatar && AVATAR_RE.test(a.avatar) ? `<span class="avatar" style="background-image:url('${a.avatar}')"></span>` : `<span class="avatar" style="background:${colorFor(a.id)}">${initials(a.name)}</span>`}
            <span class="acc-txt"><b>${esc(a.name)}</b><span class="muted small">${n} servidor${n === 1 ? '' : 'es'}</span></span>
            <button class="acc-del" data-action="del-acc" data-id="${a.id}" title="Remover deste PC">✕</button>
          </div>`;
        }).join('')}</div>
        <div class="or"><span>ou</span></div>` : ''}
      <form id="new-acc" class="login-form">
        <label class="field">${accs.length ? 'Criar outra conta' : 'Seu apelido'}
          <input id="in-name" maxlength="24" autocomplete="off" placeholder="ex: Gabriel" />
        </label>
        <button class="primary big" type="submit">${accs.length ? 'Criar conta' : 'Entrar'}</button>
      </form>
      <button class="ghost" data-action="import-acc">🔑 Tenho um código de conta (trazer de outro PC)</button>
      <div class="app-version muted small center">${window.APP_VERSION ? 'Sampsoncord v' + window.APP_VERSION : ''}${IS_WEB ? ' · versão web' : ''}</div>
      ${IS_WEB ? `<div class="web-note">🌐 Você está na <b>versão web</b>: funciona igual, só sem iniciar com o Windows e sem atalhos globais.
        <a href="${INSTALLER_URL}" target="_blank" rel="noopener">Baixar o app</a></div>` : ''}
    </div>`;
  $('#new-acc').onsubmit = (e) => {
    e.preventDefault();
    const name = cleanName($('#in-name').value, 24);
    if (!name) return $('#in-name').focus();
    const acc = { id: rand(16), name };
    saveAccount(acc);
    enterAccount(acc);
  };
  if (!accs.length) $('#in-name').focus();
}

function enterAccount(acc) {
  audioCtx(); // libera o áudio depois de um clique
  user = { ...acc };
  autoIdle = false;
  // na web, pede permissão de notificação (só funciona depois de um clique — no login automático fica pra depois)
  if (IS_WEB && settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => { });
  store.set('salinha-last-account', user.id);
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  for (const code of serverList()) if (!sessions.has(code)) sessions.set(code, new ServerSession(code));
  active = null;
  renderAll();
}

function logout() {
  store.del('salinha-last-account'); // na próxima vez abre na tela de contas
  if (voice.code) leaveVoice(true);
  for (const s of sessions.values()) s.destroy();
  sessions.clear();
  user = null;
  active = null;
  closeModal();
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  renderLogin();
}

// Código da conta: id, apelido e servidores (com canais) — para levar a conta para outro PC
function exportAccount() {
  const servers = serverList().map((code) => {
    const st = store.get('salinha-server-' + code, null);
    return st ? { code, name: st.name, nameTs: st.nameTs, channels: st.channels } : { code };
  });
  const profile = {};
  for (const k of PROFILE_FIELDS) if (user[k]) profile[k] = user[k];
  const json = JSON.stringify({ v: 1, id: user.id, name: user.name, profile, servers });
  return 'SALINHA1:' + btoa(unescape(encodeURIComponent(json)));
}
function importAccount(text) {
  const m = String(text).trim().match(/^SALINHA1:([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw new Error('Código de conta inválido.');
  let data;
  try { data = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/\s/g, ''))))); } catch { throw new Error('Código de conta inválido ou incompleto.'); }
  if (!data || typeof data.id !== 'string' || !/^[a-z0-9]{8,32}$/.test(data.id)) throw new Error('Código de conta inválido.');
  const acc = { id: data.id, name: cleanName(data.name, 24) || 'Sem nome', ...cleanProfile(data.profile) };
  saveAccount(acc);
  const list = serversOf(acc.id);
  for (const srv of Array.isArray(data.servers) ? data.servers : []) {
    const code = parseCode(srv && srv.code);
    if (!code) continue;
    const st = store.get('salinha-server-' + code, null) || { code, name: '', nameTs: 0, channels: {} };
    if (mergeServer(st, srv)) store.set('salinha-server-' + code, st);
    else if (!store.get('salinha-server-' + code, null)) store.set('salinha-server-' + code, st);
    if (!list.includes(code)) list.push(code);
  }
  store.set('salinha-servers-' + acc.id, list);
  return acc;
}

function openImportModal() {
  openModal(`
    <h2>Trazer conta de outro PC</h2>
    <p class="muted">No outro PC, abra o Sampsoncord, clique no seu nome (canto inferior esquerdo) → <b>Copiar código da conta</b>. Depois cole aqui.</p>
    <textarea id="imp-code" rows="5" placeholder="SALINHA1:…"></textarea>
    <p class="error" id="imp-err"></p>
    <div class="modal-actions"><button class="ghost" data-x>Cancelar</button><button class="primary" data-go>Entrar na conta</button></div>`,
  (card) => {
    card.querySelector('[data-x]').onclick = closeModal;
    card.querySelector('[data-go]').onclick = () => {
      try {
        const acc = importAccount(card.querySelector('#imp-code').value);
        closeModal();
        enterAccount(acc);
        toast(`Conta "${acc.name}" carregada!`);
      } catch (e) {
        card.querySelector('#imp-err').textContent = e.message;
      }
    };
    setTimeout(() => card.querySelector('#imp-code').focus(), 0);
  });
}

// ---------------------------------------------------------------- editar perfil + conta
function openAccountModal() {
  const draft = { name: user.name, avatar: user.avatar || '', status: user.status || 'online', custom: user.custom || '', bio: user.bio || '', color: user.color || '#5865f2' };
  openModal(`
    <div class="tabs"><button data-tab="profile" class="on">Perfil</button><button data-tab="account">Conta</button></div>
    <div data-pane="profile" class="profile-edit">
      <div class="pe-preview">
        <div class="pc-banner" id="pe-banner"></div>
        <div class="pe-avatar-row">
          <button class="pe-avatar" id="pe-avatar" title="Trocar foto"></button>
          <div class="pe-photo-btns">
            <button type="button" class="sm" id="pe-pick">📷 Trocar foto</button>
            <button type="button" class="sm ghost" id="pe-remove">Remover</button>
          </div>
        </div>
        <input type="file" id="pe-file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden">
      </div>
      <label class="field">Apelido<input id="pe-name" maxlength="24" value="${esc(draft.name)}"></label>
      <div class="pe-row">
        <label class="field">Status
          <select id="pe-status">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${k === draft.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        </label>
        <label class="field">Cor do perfil<input type="color" id="pe-color" value="${draft.color}"></label>
      </div>
      <label class="field">Status personalizado<input id="pe-custom" maxlength="80" placeholder="ex: jogando Minecraft 🎮" value="${esc(draft.custom)}"></label>
      <label class="field">Sobre mim<textarea id="pe-bio" rows="3" maxlength="300" placeholder="Conte algo sobre você">${esc(draft.bio)}</textarea></label>
      <p class="error" id="pe-err"></p>
      <div class="modal-actions"><button class="ghost" data-x>Cancelar</button><button class="primary" id="pe-save">Salvar perfil</button></div>
    </div>
    <div data-pane="account" class="hidden acc-pane">
      <p class="muted">${serverList().length} servidor(es) salvos neste PC.</p>
      <label class="field">Código da conta</label>
      <textarea readonly rows="3" class="code-box" id="acc-code"></textarea>
      <p class="muted small">Use esse código para entrar na sua conta em outro PC (com perfil e servidores).
        <b>Não passe para ninguém</b>: quem tiver o código entra como você. Esse não é o código de convite de servidor.</p>
      <div class="modal-actions spread">
        <button class="danger-btn" data-logout>🚪 Sair da conta (trocar de perfil)</button>
        <button data-copy>📋 Copiar código da conta</button>
      </div>
    </div>`,
  (card) => {
    const paint = () => {
      const av = card.querySelector('#pe-avatar');
      if (draft.avatar) { av.style.backgroundImage = `url('${draft.avatar}')`; av.textContent = ''; av.style.background = ''; av.style.backgroundImage = `url('${draft.avatar}')`; }
      else { av.style.backgroundImage = ''; av.style.background = colorFor(user.id); av.innerHTML = initials(draft.name || user.name); }
      card.querySelector('#pe-banner').style.background = draft.color;
      card.querySelector('#pe-remove').classList.toggle('hidden', !draft.avatar);
    };
    paint();
    $$('[data-tab]', card).forEach((b) => (b.onclick = () => {
      $$('[data-tab]', card).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', card).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === 'account') card.querySelector('#acc-code').value = exportAccount();
    }));
    const file = card.querySelector('#pe-file');
    card.querySelector('#pe-pick').onclick = () => file.click();
    card.querySelector('#pe-avatar').onclick = () => file.click();
    card.querySelector('#pe-remove').onclick = () => { draft.avatar = ''; paint(); };
    file.onchange = async () => {
      try { draft.avatar = await resizeImage(file.files[0]); card.querySelector('#pe-err').textContent = ''; paint(); } catch (e) { card.querySelector('#pe-err').textContent = e.message; }
      file.value = '';
    };
    card.querySelector('#pe-color').oninput = (e) => { draft.color = e.target.value; paint(); };
    card.querySelector('#pe-name').oninput = (e) => { draft.name = e.target.value; paint(); };
    card.querySelector('[data-x]').onclick = closeModal;
    card.querySelector('#pe-save').onclick = () => {
      const name = cleanName(card.querySelector('#pe-name').value, 24);
      if (!name) { card.querySelector('#pe-err').textContent = 'O apelido não pode ficar vazio.'; return; }
      const nameChanged = name !== user.name;
      user.name = name;
      user.status = card.querySelector('#pe-status').value;
      user.custom = cleanName(card.querySelector('#pe-custom').value, 80);
      user.bio = card.querySelector('#pe-bio').value.slice(0, 300);
      user.color = draft.color;
      user.avatar = draft.avatar;
      for (const k of PROFILE_FIELDS) if (!user[k]) delete user[k];
      saveAccount(user);
      if (nameChanged) for (const s of sessions.values()) s.sendState();
      broadcastProfile();
      closeModal();
      renderAll();
      toast('Perfil salvo!');
    };
    card.querySelector('[data-copy]').onclick = () => {
      copyText(card.querySelector('#acc-code').value, 'Código da conta copiado!');
    };
    card.querySelector('[data-logout]').onclick = logout;
  });
}

// ---------------------------------------------------------------- cartão de perfil (clicar em alguém)
function openProfileCard(uid) {
  const p = profileOf(uid);
  if (!p) return;
  const isMe = uid === user.id;
  const st = STATUS[p.status || 'online'] || STATUS.online;
  let where = '';
  for (const s of sessions.values()) {
    if (isMe && voice.code === s.code) { const c = s.channel(voice.cid); if (c) where = `${c.name} / ${s.name}`; }
    for (const m of s.members.values()) if (m.uid === uid && m.vc) { const c = s.channel(m.vc); if (c) where = `${c.name} / ${s.name}`; }
  }
  const vs = voiceSession();
  const volMember = !isMe && vs ? [...vs.members.values()].find((m) => m.uid === uid && inMyChannel(vs, m)) : null;
  let ver = isMe ? window.APP_VERSION : null;
  if (!isMe) for (const s of sessions.values()) for (const m of s.members.values()) if (m.uid === uid && m.named) ver = m.version || 'antiga';
  openModal(`
    <div class="profile-card">
      <div class="pc-banner" style="background:${p.color || colorFor(uid)}"></div>
      <div class="pc-avatar">${avatarHTML({ uid, name: p.name }, 'xxl', true)}</div>
      <div class="pc-body">
        <h2>${esc(p.name || 'Sem nome')}</h2>
        <div class="pc-status"><i class="sdot inline ${st.cls}"></i>${st.label}</div>
        ${p.custom ? `<div class="pc-custom">${esc(p.custom)}</div>` : ''}
        ${ver ? `<div class="muted small">${ver === 'antiga' ? '⚠ Versão antiga do Sampsoncord (anterior à 1.3)' : 'Sampsoncord v' + esc(ver)}</div>` : ''}
        ${where ? `<div class="pc-section"><div class="section-title">NA VOZ</div><div class="pc-where">${ICON.speaker}${esc(where)}</div></div>` : ''}
        ${p.bio ? `<div class="pc-section"><div class="section-title">SOBRE MIM</div><div class="pc-bio">${esc(p.bio)}</div></div>` : ''}
        ${volMember ? `<div class="pc-section pc-vols"><div class="section-title">VOLUME</div>
          <label class="vol-row big">🎙️ Voz<input type="range" class="vol" min="0" max="100" value="${Math.round(volMember.volume * 100)}" data-vol="${volMember.id}" data-kind="voice"></label>
          ${volMember.sharing ? `<label class="vol-row big">🖥️ Tela<input type="range" class="vol" min="0" max="100" value="${Math.round(volMember.screenVolume * 100)}" data-vol="${volMember.id}" data-kind="screen"></label>
          <div class="modal-actions"><button class="primary" data-action="watch" data-code="${voice.code}" data-id="${volMember.id}">▶ Assistir tela</button></div>` : ''}
        </div>` : ''}
        ${isMe ? '<div class="modal-actions"><button class="primary" data-edit>✏️ Editar perfil</button></div>' : ''}
      </div>
    </div>`, (card) => {
    card.classList.add('no-pad');
    const b = card.querySelector('[data-edit]');
    if (b) b.onclick = () => openAccountModal();
  });
}

// ---------------------------------------------------------------- menu rápido de status
function toggleStatusMenu() {
  const menu = $('#status-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  const cur = user.status || 'online';
  menu.innerHTML = Object.entries(STATUS).map(([k, s]) =>
    `<button data-action="set-status" data-status="${k}" class="${k === cur ? 'on' : ''}"><i class="sdot inline ${s.cls}"></i>${s.label}</button>`).join('') +
    `<div class="dd-sep"></div><button data-action="account">✏️ Editar perfil</button>`;
  menu.classList.remove('hidden');
}

// ---------------------------------------------------------------- configurações (voz, notificações)
async function openSettingsModal() {
  let testStream = null, stopTest = null;
  const cleanup = () => { if (stopTest) stopTest(); if (testStream) testStream.getTracks().forEach((t) => t.stop()); testStream = null; stopTest = null; };
  openModal(`
    <h2>Configurações</h2>
    <div class="section-title">APARÊNCIA</div>
    <div class="theme-pick">
      ${[['dark', '🌙 Escuro'], ['light', '☀️ Claro'], ['system', '🖥️ Igual ao Windows']].map(([k, l]) =>
        `<button type="button" class="theme-opt ${(settings.theme || 'dark') === k ? 'on' : ''}" data-theme="${k}">${l}</button>`).join('')}
    </div>
    <div class="section-title">SISTEMA</div>
    <label class="check"><input type="checkbox" id="set-autostart" ${window.desktop && window.desktop.getAutostart ? '' : 'disabled'}> Iniciar o Sampsoncord junto com o Windows (abre minimizado)${IS_WEB ? ' — só no app instalado' : ''}</label>
    <div class="section-title">VOZ</div>
    <label class="field">Microfone<select id="set-mic"><option value="">Padrão do Windows</option></select></label>
    <div class="mic-test"><span class="muted small">Teste do microfone (fale algo):</span><div class="meter"><i id="set-meter"></i></div></div>
    <label class="field">Saída de áudio (fone / caixa)<select id="set-out"><option value="">Padrão do Windows</option></select></label>
    <div class="section-title">NOTIFICAÇÕES</div>
    <label class="check"><input type="checkbox" id="set-notify" ${settings.notify ? 'checked' : ''}> Notificação do Windows quando chegar mensagem</label>
    <label class="check"><input type="checkbox" id="set-sounds" ${settings.sounds ? 'checked' : ''}> Sons de entrar/sair e de mensagem</label>
    <label class="check"><input type="checkbox" id="set-announce" ${settings.announce !== false ? 'checked' : ''}> Anunciar com voz quem entra e sai do canal ("Gabriel entrou")</label>
    <p class="muted small">No status "Não perturbe" você não recebe notificações nem som de mensagem.</p>
    <div class="section-title">ATALHOS (FUNCIONAM ATÉ COM O APP MINIMIZADO)</div>
    <div class="shortcuts"><span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> mutar / desmutar</span><span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> ensurdecer</span></div>
    <div class="modal-actions"><button class="primary" data-x>Pronto</button></div>`,
  async (card) => {
    // o teste do mic para sozinho quando o modal fecha (o medidor sai da tela)
    card.querySelector('[data-x]').onclick = () => { cleanup(); closeModal(); };
    const auto = card.querySelector('#set-autostart');
    if (window.desktop && window.desktop.getAutostart) {
      window.desktop.getAutostart().then((on) => (auto.checked = !!on)).catch(() => { });
      auto.onchange = async () => {
        try { auto.checked = await window.desktop.setAutostart(auto.checked); toast(auto.checked ? 'Vai iniciar junto com o Windows' : 'Não vai mais iniciar com o Windows'); } catch { }
      };
    }
    $$('.theme-opt', card).forEach((b) => (b.onclick = () => {
      settings.theme = b.dataset.theme; saveSettings(); applyTheme();
      $$('.theme-opt', card).forEach((x) => x.classList.toggle('on', x === b));
    }));
    const micSel = card.querySelector('#set-mic'), outSel = card.querySelector('#set-out');
    const startTest = async () => {
      cleanup();
      try {
        testStream = await openMic(micSel.value);
        const bar = card.querySelector('#set-meter');
        const ctx = audioCtx(), src = ctx.createMediaStreamSource(testStream), an = ctx.createAnalyser();
        an.fftSize = 512; src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const id = setInterval(() => {
          if (!document.body.contains(bar)) return cleanup();
          an.getByteTimeDomainData(buf);
          let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
          bar.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 400) + '%';
        }, 60);
        stopTest = () => { clearInterval(id); try { src.disconnect(); } catch { } };
      } catch {
        const box = card.querySelector('.mic-test');
        if (box) box.innerHTML = '<span class="error small">Não consegui abrir esse microfone. Veja se ele está conectado e liberado no Windows.</span>';
      }
    };
    await startTest(); // também libera os nomes dos dispositivos
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      for (const d of devs) {
        if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
        const opt = `<option value="${esc(d.deviceId)}">${esc(d.label || (d.kind === 'audioinput' ? 'Microfone' : 'Saída'))}</option>`;
        if (d.kind === 'audioinput') micSel.insertAdjacentHTML('beforeend', opt);
        if (d.kind === 'audiooutput') outSel.insertAdjacentHTML('beforeend', opt);
      }
    } catch { }
    micSel.value = [...micSel.options].some((o) => o.value === settings.micId) ? settings.micId : '';
    outSel.value = [...outSel.options].some((o) => o.value === settings.outId) ? settings.outId : '';
    if (micSel.value !== settings.micId) await startTest();
    micSel.onchange = async () => { settings.micId = micSel.value; saveSettings(); await startTest(); switchMic(); };
    outSel.onchange = () => { settings.outId = outSel.value; saveSettings(); applyOutputAll(); soundMsg(); };
    card.querySelector('#set-notify').onchange = (e) => {
      settings.notify = e.target.checked; saveSettings();
      if (settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    };
    card.querySelector('#set-sounds').onchange = (e) => { settings.sounds = e.target.checked; saveSettings(); };
    card.querySelector('#set-announce').onchange = (e) => {
      settings.announce = e.target.checked; saveSettings();
      if (e.target.checked) announceVoice(user.name, true); // exemplo
    };
  });
}

// ---------------------------------------------------------------- ausente automático + atalhos globais
setInterval(async () => {
  if (!user) return;
  const idle = await idleSeconds(); // app: PC parado · web: aba parada
  const shouldIdle = idle >= 600; // 10 minutos sem mexer no PC
  if (shouldIdle !== autoIdle) { autoIdle = shouldIdle; broadcastProfile(); ui.refresh(); }
}, 5000); // checa a cada 5s: mexeu o mouse, volta a "Disponível" quase na hora

if (window.desktop && window.desktop.onShortcut) {
  window.desktop.onShortcut((k) => {
    if (!user) return;
    if (k === 'mute') actions.mute();
    if (k === 'deaf') actions.deaf();
    toast(k === 'mute' ? (muted ? '🔇 Microfone mutado' : '🎙️ Microfone ligado') : (deaf ? '🔕 Ensurdecido' : '🔔 Ouvindo de novo'));
  });
}

// Abre direto no último perfil usado (até a pessoa sair da conta)
renderLogin();
{
  const lastId = store.get('salinha-last-account', null);
  const lastAcc = lastId && loadAccounts().find((a) => a.id === lastId);
  if (lastAcc) enterAccount(lastAcc);
}

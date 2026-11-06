'use strict';
/*
 * Cada servidor é uma "sessão": uma rede em malha (todo mundo conectado com todo mundo)
 * entre os membros que estão online. O servidor público do PeerJS só serve para os PCs
 * se acharem; dados, voz e tela vão direto de PC para PC.
 *
 * Não existe banco de dados central: cada membro guarda uma cópia do servidor (nome,
 * canais e mensagens) e as cópias se juntam sempre que dois membros se conectam.
 *
 * Como os membros se acham: um deles segura o ID "salinha2-<código>-lobby" (o porteiro).
 * Quem chega pergunta ao porteiro quem está online e conecta em todos. Se o porteiro sair,
 * outro membro assume.
 */

const sessions = new Map(); // código -> ServerSession
const PROTO = 3; // 1 = salas por nome (primeiro .exe), 2 = servidores com código, 3 = + versão/assistir

// Compara versões "1.2.10" x "1.3.0": negativo se a < b
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

function newServerState(code, name, ownerUid) {
  const now = Date.now(), t = rand(8), v = rand(8);
  return {
    code, name, nameTs: now,
    owner: ownerUid ? { uid: ownerUid, ts: now } : undefined,
    perms: emptyPerms(),
    channels: {
      [t]: { id: t, name: 'geral', type: 'text', ts: now },
      [v]: { id: v, name: 'Geral', type: 'voice', ts: now + 1 },
    },
  };
}

// Junta o estado remoto no local. Canais: união por id; apagado em qualquer lado = apagado.
function mergeServer(a, b) {
  if (!b || typeof b !== 'object') return false;
  let changed = false;
  if (typeof b.name === 'string' && b.name && (+b.nameTs || 0) > (a.nameTs || 0)) {
    a.name = cleanName(b.name, 40); a.nameTs = +b.nameTs; changed = true;
  }
  // Foto do servidor: vale a alteração mais recente ('' = removida)
  if (typeof b.icon === 'string' && (b.icon === '' || (b.icon.length <= 60000 && AVATAR_RE.test(b.icon))) && (+b.iconTs || 0) > (a.iconTs || 0)) {
    a.icon = b.icon; a.iconTs = +b.iconTs; changed = true;
  }
  if (mergePerms(a, b)) changed = true;
  for (const c of Object.values(b.channels || {})) {
    if (!c || typeof c.id !== 'string' || c.id.length > 16 || !['text', 'voice'].includes(c.type)) continue;
    const mine = a.channels[c.id];
    if (!mine) {
      a.channels[c.id] = { id: c.id, name: cleanName(c.name, 30) || 'canal', type: c.type, ts: +c.ts || 0, deleted: !!c.deleted, nameTs: +c.nameTs || 0 };
      changed = true;
    } else {
      if (c.deleted && !mine.deleted) { mine.deleted = true; changed = true; }
      // canal renomeado: vale o nome mais recente
      if ((+c.nameTs || 0) > (mine.nameTs || 0) && cleanName(c.name, 30)) { mine.name = cleanName(c.name, 30); mine.nameTs = +c.nameTs; changed = true; }
    }
  }
  return changed;
}

function cleanMsg(m) {
  if (!m || typeof m.id !== 'string' || m.id.length > 24) return null;
  // mensagem apagada ("lápide"): guarda só quem escreveu e quem apagou, pra ela nunca voltar
  if (m.deleted) {
    return { id: m.id, ts: Math.min(+m.ts || 0, Date.now() + 60000), author: cleanName(m.author, 24) || 'Anônimo',
      uid: String(m.uid || '').slice(0, 32), by: String(m.by || '').slice(0, 32), text: '', deleted: true };
  }
  if (typeof m.text !== 'string') return null;
  const text = m.text.slice(0, 2000);
  // anexo de imagem: só os dados de referência (a imagem em si vai separada, sob demanda)
  let att = null;
  if (m.att && typeof m.att.id === 'string' && /^[a-z0-9]{6,24}$/.test(m.att.id)) {
    att = { id: m.att.id, w: Math.min(4000, +m.att.w || 0), h: Math.min(4000, +m.att.h || 0) };
  }
  if (!text.trim() && !att) return null;
  const out = {
    id: m.id, text,
    ts: Math.min(+m.ts || 0, Date.now() + 60000),
    author: cleanName(m.author, 24) || 'Anônimo',
    uid: String(m.uid || '').slice(0, 32),
  };
  if (att) out.att = att;
  return out;
}

class ServerSession {
  constructor(code) {
    this.code = code;
    this.key = code.toLowerCase();
    this.state = store.get('salinha-server-' + code) || { code, name: '', nameTs: 0, channels: {} };
    this.members = new Map();
    this.unread = new Set();
    this.failed = new Set(); // pessoas que o porteiro listou mas com quem não deu pra conectar
    this.gone = new Set();   // IDs que o servidor disse que não existem mais
    this.me = null;
    this.lobby = null;
    this.online = false;
    this.started = false;
    this.closed = false;
    this.connect();
  }

  get name() { return this.state.name || 'Servidor ' + fmtCode(this.code); }
  lobbyId() { return `salinha2-${this.key}-lobby`; }
  save() { store.set('salinha-server-' + this.code, this.state); }
  channels(type) {
    return Object.values(this.state.channels).filter((c) => !c.deleted && c.type === type).sort((a, b) => a.ts - b.ts);
  }
  channel(cid) { const c = this.state.channels[cid]; return c && !c.deleted ? c : null; }
  // canais que eu (ou uid) posso ver, respeitando os cargos
  visibleChannels(type, uid = user.id) { return this.channels(type).filter((c) => canAccess(this.state, uid, c.id)); }
  isRestricted(cid) { return !!(this.state.perms && this.state.perms.access && this.state.perms.access[cid]); }
  historyFor(uid) { // histórico dos canais de texto que essa pessoa pode ver
    const h = {};
    for (const c of this.channels('text')) if (uid ? canAccess(this.state, uid, c.id) : !this.isRestricted(c.id)) h[c.id] = this.msgs(c.id).slice(-100);
    return h;
  }
  pushPerms(perms) {
    this.state.perms = cleanPerms({ ...perms, ts: Date.now(), by: user.id });
    this.pushServer();
  }
  msgKey(cid) { return `salinha-msgs-${this.code}-${cid}`; }
  msgs(cid) { return store.get(this.msgKey(cid), []); }
  addMsgs(cid, list) {
    if (!this.channel(cid) || !Array.isArray(list)) return 0;
    const cur = this.msgs(cid);
    const byId = new Map(cur.map((m, i) => [m.id, i]));
    let added = 0;
    for (const raw of list) {
      const m = cleanMsg(raw);
      if (!m) continue;
      if (byId.has(m.id)) {
        // chegou a lápide de uma mensagem que eu tenho: apaga se quem pediu é o autor ou um administrador
        const i = byId.get(m.id), old = cur[i];
        if (m.deleted && !old.deleted && (m.by === old.uid || can(this.state, m.by, 'admin'))) {
          cur[i] = { ...m, uid: old.uid, author: old.author, ts: old.ts };
          added++;
        }
        continue;
      }
      cur.push(m); byId.set(m.id, cur.length - 1); added++;
    }
    if (added) { cur.sort((a, b) => a.ts - b.ts); store.set(this.msgKey(cid), cur.slice(-500)); }
    return added;
  }

  // ------------------------------------------------------------ conexão
  connect() {
    if (this.closed) return;
    const p = this.me = new Peer(`salinha2-${this.key}-${rand(10)}`, PEER_OPTS);
    p.on('open', () => {
      this.online = true;
      ui.refresh();
      // Ao entrar, primeiro PERGUNTA quem está online (em vez de tentar virar porteiro direto).
      // Assim, se a vaga de porteiro estiver livre por um instante, quem já estava na sala tem prioridade.
      if (!this.started) { this.started = true; this.vacant = 0; this.askLobby(); this.startDiscovery(); }
    });
    p.on('connection', (c) => this.setupConn(c, false));
    p.on('call', (call) => onCall(this, call));
    p.on('disconnected', () => {
      this.online = false; ui.refresh();
      setTimeout(() => { if (!p.destroyed && p.disconnected) p.reconnect(); }, 3000);
    });
    p.on('close', () => {
      // Erro fatal: recria tudo em alguns segundos
      if (this.me !== p || this.closed) return;
      this.online = false; this.started = false;
      for (const id of [...this.members.keys()]) this.removeMember(id);
      if (this.lobby) { try { this.lobby.destroy(); } catch { } this.lobby = null; }
      ui.refresh();
      setTimeout(() => this.connect(), 5000);
    });
    p.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        const msg = String(err.message);
        if (msg.includes(this.lobbyId())) this.onLobbyVacant();
        else { const mm = msg.match(/salinha2-[a-z0-9]+-[a-z0-9]+/); if (mm) this.gone.add(mm[0]); }
        return;
      }
      console.warn(`[${this.code}] peer error`, err.type, err.message);
    });
  }

  claimLobby(initial) {
    if (this.lobby || this.claiming || this.closed || !this.me || this.me.destroyed) return;
    this.claiming = true;
    const lp = new Peer(this.lobbyId(), PEER_OPTS);
    const done = () => { this.claiming = false; };
    lp.on('open', () => { done(); this.lobby = lp; });
    lp.on('connection', (c) => {
      c.on('open', () => {
        c.send({ t: 'members', list: [this.me.id, ...this.members.keys()] });
        setTimeout(() => c.close(), 3000);
      });
    });
    lp.on('error', (err) => {
      done();
      if (err.type === 'unavailable-id') {
        // Alguém já é porteiro: pergunta quem está online
        if (initial) this.askLobby();
      } else if (initial && this.members.size === 0) {
        setTimeout(() => { if (!this.lobby && this.members.size === 0) this.claimLobby(true); }, 5000);
      }
    });
    lp.on('close', () => { done(); if (this.lobby === lp) this.lobby = null; });
    lp.on('disconnected', () => {
      setTimeout(() => { if (this.lobby === lp && !lp.destroyed && lp.disconnected) lp.reconnect(); }, 3000);
    });
  }

  // Pergunta ao porteiro quem está online. Se ele não responder (ex: era a minha própria
  // instância que acabou de fechar numa atualização, e o servidor ainda acha que ela existe),
  // tenta virar porteiro de novo / perguntar de novo, até dar certo.
  askLobby() {
    if (this.asking || this.closed || !this.me || !this.me.open) return;
    this.asking = true;
    let answered = false;
    const c = this.me.connect(this.lobbyId(), { reliable: true });
    this.askConn = c;
    c.on('data', (d) => {
      if (!d || d.t !== 'members' || !Array.isArray(d.list)) return;
      answered = true;
      this.vacant = 0;
      d.list.filter((id) => typeof id === 'string' && id !== this.me.id).forEach((id) => this.connectTo(id));
      c.close();
    });
    clearTimeout(this.askTimer);
    this.askTimer = setTimeout(() => {
      this.asking = false;
      if (answered || this.closed) return;
      try { c.close(); } catch { }
      if (!this.lobby) this.claimLobby(true);
    }, 8000);
  }

  // O servidor disse que ninguém é porteiro agora. Na primeira vez espera um pouco e pergunta
  // de novo (quem já estava na sala costuma assumir em 1-2s); se continuar vago, assume.
  onLobbyVacant() {
    clearTimeout(this.askTimer);
    this.asking = false;
    try { this.askConn && this.askConn.close(); } catch { }
    if (this.lobby || this.closed) return;
    this.vacant = (this.vacant || 0) + 1;
    if (this.vacant === 1 && this.members.size === 0) setTimeout(() => this.askLobby(), 3500);
    else { this.vacant = 0; this.claimLobby(true); }
  }

  // A cada 30s, quem não é porteiro pergunta de novo quem está online. Isso junta grupos que
  // ficaram separados (porteiro caiu, atualização, rede instável) sem ninguém precisar sair e entrar.
  startDiscovery() {
    if (this.discoveryTimer) return;
    this.discoveryTimer = setInterval(() => {
      if (!this.started || this.closed || this.lobby || !this.me || !this.me.open) return;
      this.askLobby();
    }, 30000);
  }

  connectTo(id, retry = true) {
    if (this.members.has(id) || id === this.me.id) return;
    const c = this.me.connect(id, { reliable: true });
    this.setupConn(c, true);
    // Se em 15s não abrir, a rede de um dos dois provavelmente está bloqueando conexão direta
    setTimeout(() => {
      const m = this.members.get(id);
      if (m && m.conn && m.conn.open) return;
      try { c.close(); } catch { }
      if (this.gone.has(id)) return; // a pessoa simplesmente saiu, não é problema de rede
      this.failed.add(id);
      ui.refresh();
      if (retry) setTimeout(() => { if (!this.closed && !this.members.has(id)) this.connectTo(id, false); }, 20000);
    }, 15000);
  }

  setupConn(c, outgoing) {
    c.on('open', () => {
      let m = this.members.get(c.peer);
      if (m && m.conn && m.conn.open && m.conn !== c) {
        // Os dois conectaram ao mesmo tempo: fica a conexão iniciada pelo menor ID
        const keepOutgoing = this.me.id < c.peer;
        if (outgoing !== keepOutgoing) { c.close(); return; }
        const old = m.conn; m.conn = c; old.close();
      }
      if (!m) m = this.addMember(c.peer);
      m.conn = c;
      c.send(this.helloMsg());
    });
    c.on('data', (d) => { try { this.onData(c.peer, d); } catch (e) { console.warn('data', e); } });
    c.on('close', () => { const m = this.members.get(c.peer); if (m && m.conn === c) this.removeMember(c.peer); });
    c.on('error', (e) => console.warn('conn error', e));
  }

  addMember(id) {
    const m = {
      id, uid: '', name: '', named: false, muted: false, deaf: false, vc: null, sharing: null, profile: {},
      conn: null, voice: null, screenIn: null, screenOut: null,
      audio: new Audio(), volume: 1, screenVolume: 1, stopMeter: null,
    };
    m.audio.autoplay = true;
    this.members.set(id, m);
    return m;
  }

  removeMember(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    dropMedia(m);
    try { m.conn && m.conn.close(); } catch { }
    if (voice.code === this.code && voice.cid && m.vc === voice.cid && m.named) announceVoice(m.name, false);
    // Se quem saiu era o porteiro, alguém precisa assumir
    if (!this.lobby) setTimeout(() => { if (!this.lobby && this.started) this.claimLobby(false); }, 300 + Math.random() * 2000);
    ui.refresh();
  }

  // ------------------------------------------------------------ protocolo
  presence() {
    const inVoice = voice.code === this.code;
    return {
      name: user.name, muted, deaf,
      vc: inVoice ? voice.cid : null,
      sharing: inVoice && screenStream ? shareInfo : null,
      act: settings.showActivity && myActivity ? myActivity : null, // o que estou jogando/usando
    };
  }
  helloMsg() {
    // no "oi" vai só o histórico dos canais abertos; os restritos vão depois que eu souber quem é a pessoa
    const history = this.historyFor(null);
    // v/proto: versão do app e do protocolo. Campos novos são sempre opcionais, então
    // versões antigas e novas continuam se entendendo (cada uma ignora o que não conhece).
    return { t: 'hello', v: window.APP_VERSION || '', proto: PROTO, uid: user.id, ...this.presence(), profile: myProfile(), server: this.state, history };
  }
  sendProfile() { this.broadcast({ t: 'profile', profile: myProfile() }); }
  applyProfile(m, p) {
    m.profile = cleanProfile(p);
    cacheProfile(m.uid, m.name, m.profile);
    ui.onProfileChanged();
  }
  broadcast(obj) {
    for (const m of this.members.values()) if (m.conn && m.conn.open) { try { m.conn.send(obj); } catch { } }
  }
  sendState() { this.broadcast({ t: 'state', ...this.presence() }); }

  applyPresence(m, d) {
    const prevVc = m.vc;
    const wasSharing = m.sharing;
    const prevName = m.name;
    m.name = cleanName(d.name, 24) || m.name || 'Anônimo';
    if (m.uid && prevName && prevName !== m.name) cacheProfile(m.uid, m.name, m.profile || {});
    m.muted = !!d.muted; m.deaf = !!d.deaf;
    m.activity = cleanActivity(d.act);
    m.vc = typeof d.vc === 'string' ? d.vc : null;
    m.sharing = typeof d.sharing === 'string' ? d.sharing.slice(0, 32) : null;
    if (voice.code === this.code && voice.cid) {
      if (m.vc === voice.cid && prevVc !== voice.cid) announceVoice(m.name, true);
      else if (prevVc === voice.cid && m.vc !== voice.cid) announceVoice(m.name, false);
    }
    if (!m.sharing && m.screenIn) { const c = m.screenIn; m.screenIn = null; c.close(); removeTile(m.id); }
    if (!m.sharing) m.unwatched = false; // próxima vez que compartilhar, volta a aparecer
    if (m.sharing && !wasSharing && m.named && m.vc && voice.code === this.code && voice.cid === m.vc) ui.onShareStarted(this, m);
  }

  onData(id, d) {
    const m = this.members.get(id);
    if (!m || !d || typeof d !== 'object') return;
    switch (d.t) {
      case 'hello': {
        m.uid = String(d.uid || '').slice(0, 32);
        m.version = typeof d.v === 'string' && /^\d+\.\d+\.\d+$/.test(d.v) ? d.v : '';
        m.proto = +d.proto || 2;
        this.failed.delete(id);
        m.named = true;
        m.volume = getVol(m.uid, 'voice');
        m.screenVolume = getVol(m.uid, 'screen');
        m.audio.volume = m.volume;
        this.applyPresence(m, d);
        this.applyProfile(m, d.profile);
        ui.onPeerVersion(this, m); // depois do nome, pra mensagem sair certa
        if (mergeServer(this.state, d.server)) { this.save(); ui.onServerChanged(this); }
        this.takeHistory(d.history);
        // agora que sei quem é: mando o histórico dos canais restritos que ele pode ver
        this.sendRestrictedHistory(m);
        watchTogether.onMemberHello(this, m);
        reconcile(this);
        ui.refresh();
        break;
      }
      case 'history':
        this.takeHistory(d.history);
        break;
      case 'att-req': // alguém pediu uma imagem do chat que eu tenho
        attachments.serve(m, d.id);
        break;
      case 'att':
        attachments.receive(d.id, d.data);
        break;
      case 'yt': // assistir YouTube junto no canal de voz
        watchTogether.onMessage(this, m, d);
        break;
      case 'state':
        this.applyPresence(m, d);
        reconcile(this);
        ui.refresh();
        break;
      case 'profile':
        this.applyProfile(m, d.profile);
        break;
      case 'server':
        if (mergeServer(this.state, d.server)) { this.save(); ui.onServerChanged(this); this.onPermsChanged(); }
        break;
      case 'msg':
        if (typeof d.cid !== 'string' || !canAccess(this.state, user.id, d.cid)) break;
        if (this.addMsgs(d.cid, [d.m])) ui.onMessage(this, d.cid, !(d.m && d.m.deleted)); // apagada: sem som/notificação
        break;
      // quem assiste avisa que parou / voltou a assistir minha tela
      case 'unwatch':
        m.noWatch = true;
        if (m.screenOut) { const c = m.screenOut; m.screenOut = null; c.close(); }
        break;
      case 'watch':
        m.noWatch = false;
        reconcile(this);
        break;
      case 'screen-stop':
        if (m.screenIn) { const c = m.screenIn; m.screenIn = null; c.close(); }
        removeTile(id);
        break;
    }
  }

  // Histórico dos canais restritos que essa pessoa pode ver (quando conecta ou quando ganha um cargo)
  sendRestrictedHistory(m) {
    if (!m.named || !m.conn || !m.conn.open) return;
    const extra = {};
    for (const c of this.channels('text')) if (this.isRestricted(c.id) && canAccess(this.state, m.uid, c.id)) extra[c.id] = this.msgs(c.id).slice(-100);
    if (Object.keys(extra).length) { try { m.conn.send({ t: 'history', history: extra }); } catch { } }
  }
  onPermsChanged() { for (const m of this.members.values()) this.sendRestrictedHistory(m); }

  takeHistory(history) {
    if (!history || typeof history !== 'object') return;
    for (const [cid, list] of Object.entries(history)) {
      if (!canAccess(this.state, user.id, cid)) continue;
      if (this.addMsgs(cid, list)) ui.onMessage(this, cid, false);
    }
  }

  // ------------------------------------------------------------ ações
  pushServer() { this.save(); this.broadcast({ t: 'server', server: this.state }); ui.onServerChanged(this); this.onPermsChanged(); }
  createChannel(type, name) {
    const id = rand(8);
    this.state.channels[id] = { id, name: cleanName(name, 30), type, ts: Date.now() };
    this.pushServer();
    return id;
  }
  deleteChannel(cid) {
    const c = this.state.channels[cid];
    if (!c) return;
    c.deleted = true;
    store.del(this.msgKey(cid));
    this.pushServer();
  }
  renameChannel(cid, name) {
    const c = this.channel(cid);
    if (!c) return;
    c.name = cleanName(name, 30);
    c.nameTs = Date.now();
    this.pushServer();
  }
  setIcon(dataUrl) {
    this.state.icon = dataUrl || '';
    this.state.iconTs = Date.now();
    this.pushServer();
  }
  rename(name) {
    this.state.name = cleanName(name, 40);
    this.state.nameTs = Date.now();
    this.pushServer();
  }
  // Apagar mensagem para todos (autor, ou dono/administrador)
  deleteMsg(cid, id) {
    const msg = this.msgs(cid).find((m) => m.id === id);
    if (!msg || msg.deleted) return;
    if (msg.uid !== user.id && !can(this.state, user.id, 'admin')) return;
    const tomb = { id, ts: msg.ts, author: msg.author, uid: msg.uid, by: user.id, deleted: true, text: '' };
    this.addMsgs(cid, [tomb]);
    for (const mm of this.members.values()) {
      if (!mm.conn || !mm.conn.open) continue;
      if (this.isRestricted(cid) && !(mm.named && canAccess(this.state, mm.uid, cid))) continue;
      try { mm.conn.send({ t: 'msg', cid, m: tomb }); } catch { }
    }
  }
  canDeleteMsg(msg) { return !msg.deleted && (msg.uid === user.id || can(this.state, user.id, 'admin')); }

  // att: { id, w, h } de uma imagem já guardada em attachments
  sendMsg(cid, text, att) {
    const m = { id: rand(12), text: String(text || '').slice(0, 2000), ts: Date.now(), author: user.name, uid: user.id };
    if (att) m.att = att;
    this.addMsgs(cid, [m]);
    // canal restrito: só manda pra quem tem acesso
    for (const mm of this.members.values()) {
      if (!mm.conn || !mm.conn.open) continue;
      if (this.isRestricted(cid) && !(mm.named && canAccess(this.state, mm.uid, cid))) continue;
      try { mm.conn.send({ t: 'msg', cid, m }); } catch { }
    }
  }
  onlineCount() { return 1 + [...this.members.values()].filter((m) => m.named).length; }

  destroy() {
    this.closed = true;
    this.started = false;
    clearInterval(this.discoveryTimer);
    for (const id of [...this.members.keys()]) this.removeMember(id);
    try { this.lobby && this.lobby.destroy(); } catch { }
    try { this.me && this.me.destroy(); } catch { }
  }
}

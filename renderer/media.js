'use strict';
// ---------------------------------------------------------------- voz e tela
// Só dá pra estar em um canal de voz por vez (em qualquer servidor).
const voice = { code: null, cid: null };
let localStream = null, screenStream = null, shareInfo = null;
let muted = false, deaf = false, mutedBeforeDeaf = false;
let stopLocalMeter = null;
const speaking = new Set();

const RESOLUTIONS = {
  '720': { w: 1280, h: 720, label: '720p' },
  '1080': { w: 1920, h: 1080, label: '1080p' },
  '1440': { w: 2560, h: 1440, label: '1440p' },
  '0': { w: 0, h: 0, label: 'Nativa' },
};
const FPS_OPTIONS = [15, 30, 60, 120];

function setSpeaking(id, on) {
  if (on) speaking.add(id); else speaking.delete(id);
  $$(`[data-speak="${id}"]`).forEach((el) => el.classList.toggle('speaking', on));
}
const voiceSession = () => (voice.code ? sessions.get(voice.code) : null);
const inMyChannel = (s, m) => voice.code === s.code && voice.cid && m.vc === voice.cid;

// Abre o microfone escolhido nas configurações (ou o padrão, se ele sumiu)
async function openMic(deviceId = settings.micId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } }); } catch { }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

// Manda o áudio para a saída escolhida (fone/caixa)
function applyOutput(el) {
  if (settings.outId && el && el.setSinkId) el.setSinkId(settings.outId).catch(() => { });
}
function applyOutputAll() {
  for (const s of sessions.values()) for (const m of s.members.values()) applyOutput(m.audio);
  $$('.tile video').forEach(applyOutput);
  if (actx && actx.setSinkId) actx.setSinkId(settings.outId || '').catch(() => { });
}

// Troca o microfone no meio da chamada, sem desconectar ninguém
async function switchMic() {
  if (!voice.code || !localStream) return;
  let fresh;
  try { fresh = await openMic(); } catch { return toast('Não consegui abrir esse microfone.'); }
  const track = fresh.getAudioTracks()[0];
  track.enabled = !muted;
  const s = voiceSession();
  for (const m of s.members.values()) {
    const pc = m.voice && m.voice.peerConnection;
    if (!pc) continue;
    for (const snd of pc.getSenders()) if (snd.track && snd.track.kind === 'audio') snd.replaceTrack(track).catch(() => { });
  }
  if (stopLocalMeter) stopLocalMeter();
  localStream.getTracks().forEach((t) => t.stop());
  localStream = fresh;
  stopLocalMeter = watchSpeaking(localStream, (sp) => setSpeaking('me', sp && !muted)); // mutado nunca fica verde
}

async function joinVoice(s, cid) {
  if (voice.code === s.code && voice.cid === cid) return;
  if (voice.code) leaveVoice(true);
  if (!localStream) {
    try {
      localStream = await openMic();
    } catch {
      localStream = audioCtx().createMediaStreamDestination().stream; // áudio mudo
      toast('Nenhum microfone encontrado: você só vai ouvir.');
    }
  }
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  voice.code = s.code;
  voice.cid = cid;
  stopLocalMeter = watchSpeaking(localStream, (sp) => setSpeaking('me', sp && !muted)); // mutado nunca fica verde
  soundJoin();
  s.sendState();
  reconcile(s);
  watchTogether.onJoined();
  ui.refresh();
}

function leaveVoice(quiet) {
  const s = voiceSession();
  if (!s) return;
  stopShare(true);
  watchTogether.stop();
  voice.code = null;
  voice.cid = null;
  if (stopLocalMeter) { stopLocalMeter(); stopLocalMeter = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  reconcile(s);
  s.sendState();
  if (!quiet) soundLeave();
  ui.refresh();
}

// Abre/fecha chamadas para bater com quem está no mesmo canal de voz.
// Regra para não duplicar: quem tem o menor ID liga.
function reconcile(s) {
  for (const m of s.members.values()) {
    const same = inMyChannel(s, m) && m.conn && m.conn.open;
    if (same) {
      if (!m.voice && s.me.id < m.id && localStream) {
        bindVoice(s, m, s.me.call(m.id, localStream, { metadata: { kind: 'voice', cid: voice.cid } }));
      }
      if (screenStream && !m.screenOut && !m.noWatch) sendScreenTo(s, m);
    } else {
      dropMedia(m);
    }
  }
  ui.refresh();
}

function dropMedia(m) {
  for (const k of ['voice', 'screenOut', 'screenIn']) {
    const c = m[k];
    m[k] = null;
    try { c && c.close(); } catch { }
  }
  if (m.stopMeter) { m.stopMeter(); m.stopMeter = null; }
  m.audio.srcObject = null;
  setSpeaking(m.id, false);
  removeTile(m.id);
}

function bindVoice(s, m, call) {
  m.voice = call;
  call.on('stream', (stream) => {
    if (m.voice !== call) return;
    m.audio.srcObject = stream;
    m.audio.muted = deaf;
    m.audio.volume = m.volume; // volume da voz (separado do som da tela)
    applyOutput(m.audio);
    m.audio.play().catch(() => { });
    if (m.stopMeter) m.stopMeter();
    m.stopMeter = watchSpeaking(stream, (sp) => setSpeaking(m.id, sp));
  });
  call.on('close', () => {
    if (m.voice !== call) return;
    m.voice = null;
    m.audio.srcObject = null;
    if (m.stopMeter) { m.stopMeter(); m.stopMeter = null; }
    // Caiu mas continuamos no mesmo canal? Tenta de novo.
    setTimeout(() => reconcile(s), 2000);
  });
  call.on('error', (e) => console.warn('call error', e));
}

function onCall(s, call) {
  const meta = call.metadata || {};
  const m = s.members.get(call.peer);
  if (!m || voice.code !== s.code || meta.cid !== voice.cid) { call.close(); return; }
  if (meta.kind === 'screen') {
    if (m.unwatched) { call.close(); return; } // parei de assistir essa pessoa
    if (m.screenIn) { const old = m.screenIn; m.screenIn = null; old.close(); }
    m.screenIn = call;
    call.answer();
    call.on('stream', (stream) => { if (m.screenIn === call) addTile(m.id, stream, false); });
    call.on('close', () => { if (m.screenIn === call) { m.screenIn = null; removeTile(m.id); } });
    return;
  }
  if (m.voice) { const old = m.voice; m.voice = null; old.close(); }
  call.answer(localStream);
  bindVoice(s, m, call);
}

function setMuted(v) {
  muted = v;
  if (v) setSpeaking('me', false);
  if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !v));
  for (const s of sessions.values()) s.sendState();
  ui.refresh();
}
function setDeaf(v) {
  deaf = v;
  for (const s of sessions.values()) for (const m of s.members.values()) m.audio.muted = v;
  $$('.tile video').forEach((vid) => { if (!vid.dataset.local) vid.muted = v; });
  watchTogether.setDeaf(v);
  if (v) { mutedBeforeDeaf = muted; setMuted(true); } else setMuted(mutedBeforeDeaf);
}
// kind: 'voice' (voz da pessoa) ou 'screen' (som da tela que ela compartilha)
function setMemberVolume(m, kind, vol) {
  vol = Math.max(0, Math.min(1, vol));
  if (kind === 'screen') {
    m.screenVolume = vol;
    const v = $(`.tile[data-id="${m.id}"] video`);
    if (v) v.volume = vol;
  } else {
    m.volume = vol;
    m.audio.volume = vol;
  }
  saveVol(m.uid, kind, vol);
  // mantém todos os sliders dessa pessoa sincronizados
  $$(`input[data-vol="${m.id}"][data-kind="${kind}"]`).forEach((i) => { if (document.activeElement !== i) i.value = Math.round(vol * 100); });
  $$(`.tile[data-id="${m.id}"] [data-tile="mute"]`).forEach((b) => (b.innerHTML = kind === 'screen' && vol === 0 ? ICON.volOff : ICON.speaker));
}

// ---------------------------------------------------------------- telas no palco
let pendingFocus = null; // tela que o usuário pediu pra assistir e ainda está chegando

function tileLabel(id) {
  if (id === 'me') return `Sua tela · ${shareInfo || ''}${shareEncoderInfo ? ' · ' + shareEncoderInfo : ''}`;
  const s = voiceSession();
  const m = s && s.members.get(id);
  return m ? `${m.name}${m.sharing ? ' · ' + m.sharing : ''}` : 'Tela';
}
function focusTile(id) {
  const tile = $(`.tile[data-id="${id}"]`);
  if (!tile) return;
  $$('.tile.focused').forEach((t) => t.classList.remove('focused'));
  tile.classList.add('focused');
  $('#tiles').classList.add('has-focus');
  updateTileButtons();
}
function unfocusTiles() {
  $$('.tile.focused').forEach((t) => t.classList.remove('focused'));
  $('#tiles').classList.remove('has-focus');
  updateTileButtons();
}
function updateTileButtons() {
  ui.refresh();
  $$('.tile').forEach((t) => {
    const b = t.querySelector('[data-tile="focus"]');
    const f = t.classList.contains('focused');
    b.innerHTML = f ? ICON.shrink : ICON.expand;
    b.title = f ? 'Voltar para todas as telas' : 'Ampliar esta tela';
  });
}
// Parar de assistir: fecha o vídeo (economiza internet dos dois lados) e avisa quem compartilha
function stopWatching(id) {
  const s = voiceSession(), m = s && s.members.get(id);
  if (!m) return;
  m.unwatched = true;
  if (m.screenIn) { const c = m.screenIn; m.screenIn = null; c.close(); }
  removeTile(id);
  try { m.conn && m.conn.open && m.conn.send({ t: 'unwatch' }); } catch { }
  toast(`Você parou de assistir a tela de ${m.name}`);
}
// Voltar a assistir alguém que eu tinha parado
function resumeWatching(s, m) {
  if (!m.unwatched) return;
  m.unwatched = false;
  try { m.conn && m.conn.open && m.conn.send({ t: 'watch' }); } catch { }
}
function toggleFullscreen(tile) {
  if (document.fullscreenElement) document.exitFullscreen(); else tile.requestFullscreen().catch(() => { });
}

function addTile(id, stream, isLocal) {
  let tile = $(`.tile[data-id="${id}"]`);
  if (!tile) {
    const s = voiceSession(), m = !isLocal && s && s.members.get(id);
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = id;
    tile.innerHTML = `<video autoplay playsinline></video>
      <div class="tile-top"><span class="live-pill">AO VIVO</span><span class="lbl"></span></div>
      <div class="tile-bar">
        ${isLocal ? '<span class="tb-hint">Prévia da sua tela</span>' : `
        <div class="tb-vol" title="Volume do som da tela">
          <button class="tb-btn" data-tile="mute" title="Mutar/desmutar o som da tela">${m && m.screenVolume === 0 ? ICON.volOff : ICON.speaker}</button>
          <input type="range" min="0" max="100" value="${Math.round((m ? m.screenVolume : 1) * 100)}" data-vol="${id}" data-kind="screen">
        </div>`}
        <span class="tb-space"></span>
        ${isLocal ? '' : '<button class="tb-btn tb-text" data-tile="stop" title="Fecha essa tela (você pode voltar a assistir pelo ▶ AO VIVO)">✕ Parar de assistir</button>'}
        <button class="tb-btn" data-tile="focus"></button>
        <button class="tb-btn" data-tile="full" title="Tela cheia (duplo clique)">${ICON.fullscreen}</button>
      </div>`;
    tile.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tile]');
      if (e.target.closest('input')) return;
      if (b) {
        e.stopPropagation();
        if (b.dataset.tile === 'full') return toggleFullscreen(tile);
        if (b.dataset.tile === 'stop') return stopWatching(id);
        if (b.dataset.tile === 'mute') {
          const ss = voiceSession(), mm = ss && ss.members.get(id);
          if (!mm) return;
          if (mm.screenVolume > 0) { mm.prevScreenVolume = mm.screenVolume; setMemberVolume(mm, 'screen', 0); }
          else setMemberVolume(mm, 'screen', mm.prevScreenVolume || 1);
          const r = tile.querySelector('input[type=range]'); if (r) r.value = Math.round(mm.screenVolume * 100);
          return;
        }
        if (b.dataset.tile === 'focus') return tile.classList.contains('focused') ? unfocusTiles() : focusTile(id);
      }
      if (e.target.closest('.tile-bar')) return;
      // clique na imagem: amplia / volta
      tile.classList.contains('focused') ? unfocusTiles() : focusTile(id);
    });
    tile.addEventListener('dblclick', (e) => { if (!e.target.closest('.tile-bar')) toggleFullscreen(tile); });
    $('#tiles').appendChild(tile);
  }
  tile.querySelector('.lbl').textContent = tileLabel(id);
  const v = tile.querySelector('video');
  v.muted = isLocal || deaf;
  v.dataset.local = isLocal ? '1' : '';
  if (!isLocal) {
    const s = voiceSession(), m = s && s.members.get(id);
    if (m) v.volume = m.screenVolume;
    applyOutput(v);
  }
  v.srcObject = stream;
  v.play().catch(() => { });
  updateTileButtons();
  // se o usuário clicou em "Assistir" antes da tela chegar, ou é a única tela: já amplia
  if (pendingFocus === id) { pendingFocus = null; focusTile(id); }
  ui.refresh();
}
function removeTile(id) {
  const tile = $(`.tile[data-id="${id}"]`);
  if (!tile) return;
  if (document.fullscreenElement === tile) document.exitFullscreen().catch(() => { });
  tile.remove();
  if (!$('.tile.focused')) $('#tiles').classList.remove('has-focus');
  updateTileButtons();
  ui.refresh();
}

// ---------------------------------------------------------------- compartilhar tela
// Bitrate máximo da transmissão: "auto" calcula pela resolução/FPS; o resto é fixo (Mbps). Teto: 10 Mbps.
const BITRATES = [['auto', 'Automático'], ['2.5', '2,5 Mbps'], ['4', '4 Mbps'], ['6', '6 Mbps'], ['8', '8 Mbps'], ['10', '10 Mbps']];
const MAX_BITRATE = 10e6;
let shareBitrate = null; // bps escolhido, ou null = automático

function bitrateFor(w, h, fps) {
  if (shareBitrate) return shareBitrate;
  // acima de 60 FPS cada quadro novo muda pouco, então o bitrate não precisa crescer linearmente
  const eff = fps <= 60 ? fps : 60 + (fps - 60) * 0.5;
  return Math.round(Math.min(MAX_BITRATE, Math.max(1.5e6, w * h * eff * 0.08)));
}
const fmtMbps = (bps) => (bps / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' Mbps';

// Codificador da tela. Por padrão o WebRTC comprime em VP8 pelo PROCESSADOR (pesado, uma vez
// por pessoa assistindo). Preferindo H.264, quase toda placa de vídeo (NVIDIA/AMD/Intel) comprime
// no chip dedicado: bem menos CPU e mesma qualidade. Se o outro lado não aceitar, cai pro VP8 sozinho.
let shareEncoderPref = 'gpu'; // 'gpu' (H.264 primeiro) | 'cpu' (VP8 primeiro)
let shareEncoderInfo = '';    // o que está sendo usado de fato (mostrado na sua tela)
function preferCodec(pc) {
  try {
    if (!RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video').codecs;
    const first = shareEncoderPref === 'cpu' ? 'video/VP8' : 'video/H264';
    const ordered = [...caps.filter((c) => c.mimeType === first), ...caps.filter((c) => c.mimeType !== first)];
    for (const tr of pc.getTransceivers()) {
      if (tr.sender && tr.sender.track && tr.sender.track.kind === 'video' && tr.setCodecPreferences) tr.setCodecPreferences(ordered);
    }
  } catch (e) { console.warn('codec', e); }
}
// O PeerJS cria a proposta (SDP) no mesmo instante da chamada, então a preferência vai direto nela:
// reordena os formatos da linha de vídeo colocando o preferido (e o "rtx" dele) primeiro.
function sdpPreferCodec(sdp) {
  const want = shareEncoderPref === 'cpu' ? 'VP8' : 'H264';
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  const parts = lines[mi].split(' ');
  const pts = parts.slice(3);
  const codecOf = {}, fmtp = {}, rtxFor = {};
  for (const l of lines) {
    let m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//); if (m) codecOf[m[1]] = m[2];
    m = l.match(/^a=fmtp:(\d+) (.*)$/); if (m) { fmtp[m[1]] = m[2]; const apt = m[2].match(/apt=(\d+)/); if (apt) rtxFor[apt[1]] = m[1]; }
  }
  let preferred = pts.filter((p) => (codecOf[p] || '').toUpperCase() === want);
  if (!preferred.length) return sdp;
  // H.264 "packetization-mode=1" é o que os codificadores de placa de vídeo usam melhor
  preferred.sort((a, b) => (/packetization-mode=1/.test(fmtp[b] || '') ? 1 : 0) - (/packetization-mode=1/.test(fmtp[a] || '') ? 1 : 0));
  const first = [];
  for (const p of preferred) { first.push(p); if (rtxFor[p]) first.push(rtxFor[p]); }
  lines[mi] = [...parts.slice(0, 3), ...first, ...pts.filter((p) => !first.includes(p))].join(' ');
  return lines.join('\r\n');
}

// Lê nas estatísticas qual codificador ficou ativo (placa de vídeo ou processador)
async function readEncoder(pc) {
  try {
    const st = await pc.getStats();
    let out = null, codecs = {};
    st.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
    st.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const codec = (codecs[r.codecId] || '').replace('video/', '');
        const known = r.powerEfficientEncoder !== undefined || !!r.encoderImplementation; // o navegador às vezes esconde
        const gpu = r.powerEfficientEncoder === true || /Accelerator|NVENC|AMF|QuickSync|MediaFoundation/i.test(r.encoderImplementation || '');
        out = known ? `${gpu ? '⚡ placa de vídeo' : 'processador'}${codec ? ' (' + codec + ')' : ''}` : codec;
      }
    });
    if (out && out !== shareEncoderInfo) { shareEncoderInfo = out; const t = $('.tile[data-id="me"] .lbl'); if (t) t.textContent = tileLabel('me'); }
  } catch { }
}

function sendScreenTo(s, m) {
  const call = s.me.call(m.id, screenStream, { metadata: { kind: 'screen', cid: voice.cid }, sdpTransform: sdpPreferCodec });
  m.screenOut = call;
  call.on('close', () => { if (m.screenOut === call) m.screenOut = null; });
  const pc = call.peerConnection;
  if (!pc) return;
  preferCodec(pc); // reforço para renegociações (a proposta inicial já vai ajustada pelo sdpTransform)
  const tune = () => {
    if (pc.connectionState !== 'connected') return;
    setTimeout(() => readEncoder(pc), 4000);
    const vt = screenStream && screenStream.getVideoTracks()[0];
    if (!vt) return;
    const st = vt.getSettings();
    const fps = st.frameRate || 30;
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = bitrateFor(st.width || 1920, st.height || 1080, fps);
      p.encodings[0].maxFramerate = fps;
      p.degradationPreference = fps >= 60 ? 'maintain-framerate' : 'maintain-resolution';
      sender.setParameters(p).catch((e) => console.warn('setParameters', e));
    }
  };
  pc.addEventListener('connectionstatechange', tune);
}

async function openSharePicker() {
  if (!voice.code) return toast('Entre num canal de voz para compartilhar a tela.');
  const prefs = Object.assign({ res: '1080', fps: 30, audio: false, bitrate: 'auto', encoder: 'gpu' }, store.get('salinha-share', {}));
  openModal(`
    <h2>Compartilhar tela</h2>
    <div class="picker-grid"><div class="muted">Carregando telas…</div></div>
    <div class="share-opts">
      <label class="field">Resolução
        <select id="opt-res">${Object.entries(RESOLUTIONS).map(([k, r]) => `<option value="${k}" ${k === prefs.res ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
      </label>
      <label class="field">Taxa de quadros
        <select id="opt-fps">${FPS_OPTIONS.map((f) => `<option value="${f}" ${f === prefs.fps ? 'selected' : ''}>${f} FPS</option>`).join('')}</select>
      </label>
      <label class="field">Bitrate (qualidade)
        <select id="opt-bitrate">${BITRATES.map(([k, l]) => `<option value="${k}" ${k === prefs.bitrate ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="field">Codificador
        <select id="opt-encoder"><option value="gpu" ${prefs.encoder !== 'cpu' ? 'selected' : ''}>⚡ Placa de vídeo (H.264) — recomendado</option><option value="cpu" ${prefs.encoder === 'cpu' ? 'selected' : ''}>Processador (VP8) — se der problema</option></select>
      </label>
      <label class="check"><input type="checkbox" id="opt-audio" ${prefs.audio ? 'checked' : ''}/> Som do PC</label>
    </div>
    <p class="muted small">Codificador "Placa de vídeo" usa o chip de vídeo da sua placa (NVIDIA/AMD/Intel) e quase não pesa no processador. Se a imagem ficar estranha, troque para "Processador".<br>
      Bitrate é quanta internet a transmissão pode usar: mais alto = imagem mais nítida, mas precisa de mais upload
      (multiplique pelo número de amigos assistindo). "Automático" escolhe pela resolução e FPS, até 10 Mbps.<br>
      Dica: 60–120 FPS é melhor para jogos; 15–30 FPS com resolução alta é melhor para texto e código.
      120 FPS só chega a 120 se o seu monitor for de 120 Hz ou mais e o PC e a internet aguentarem; se não, o vídeo usa o máximo que conseguir. Qualidade alta exige mais internet de quem compartilha (cada amigo recebe uma cópia). "Som do PC" manda todo o áudio do computador, inclusive a voz dos amigos de volta.</p>
    <div class="modal-actions"><button class="ghost" data-x>Cancelar</button><button class="primary" data-go disabled>Compartilhar</button></div>
  `, async (card) => {
    let chosen = null;
    const go = card.querySelector('[data-go]');
    card.querySelector('[data-x]').onclick = closeModal;
    go.onclick = () => {
      const res = card.querySelector('#opt-res').value;
      const fps = +card.querySelector('#opt-fps').value;
      const audio = card.querySelector('#opt-audio').checked;
      const bitrate = card.querySelector('#opt-bitrate').value;
      const encoder = card.querySelector('#opt-encoder').value;
      shareEncoderPref = encoder;
      store.set('salinha-share', { res, fps, audio, bitrate, encoder });
      closeModal();
      startShare(chosen, res, fps, audio, bitrate);
    };
    const grid = card.querySelector('.picker-grid');
    if (!window.desktop) { // rodando fora do app (teste no navegador)
      grid.innerHTML = '<div class="muted">O navegador vai mostrar o seletor dele.</div>';
      chosen = 'browser'; go.disabled = false;
      return;
    }
    try {
      const sources = await window.desktop.getSources();
      grid.innerHTML = '';
      for (const src of sources) {
        const el = document.createElement('div');
        el.className = 'source';
        el.innerHTML = `<img src="${src.thumb}" alt=""><div>${esc(src.name)}</div>`;
        el.onclick = () => {
          $$('.source', grid).forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          chosen = src.id;
          go.disabled = false;
        };
        el.ondblclick = () => { chosen = src.id; go.click(); };
        grid.appendChild(el);
      }
    } catch (e) {
      grid.innerHTML = `<div class="error">Não deu para listar as telas: ${esc(e.message)}</div>`;
    }
  });
}

async function startShare(sourceId, resKey, fps, audio, bitrate = 'auto') {
  const s = voiceSession();
  if (!s || !sourceId) return;
  const mbps = parseFloat(bitrate);
  shareBitrate = bitrate !== 'auto' && mbps > 0 ? Math.min(MAX_BITRATE, mbps * 1e6) : null;
  const r = RESOLUTIONS[resKey] || RESOLUTIONS['1080'];
  const video = { frameRate: { ideal: fps, max: fps } };
  if (r.w) { video.width = { max: r.w }; video.height = { max: r.h }; }
  try {
    if (window.desktop) await window.desktop.selectSource(sourceId, audio);
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (e) {
    screenStream = null;
    if (e.name !== 'NotAllowedError') toast('Não foi possível compartilhar: ' + e.message);
    return;
  }
  const vt = screenStream.getVideoTracks()[0];
  if (vt) {
    vt.contentHint = fps >= 60 ? 'motion' : 'detail';
    vt.onended = () => stopShare();
    try { await vt.applyConstraints(video); } catch { }
    const st = vt.getSettings();
    const realFps = Math.min(fps, Math.round(st.frameRate || fps));
    const br = bitrateFor(st.width || 1920, st.height || 1080, realFps);
    shareInfo = `${r.w ? r.label : (st.height ? st.height + 'p' : 'Nativa')}${realFps} · ${fmtMbps(br)}`;
  }
  if (voiceSession() !== s) { stopShare(true); return; } // saiu do canal enquanto escolhia
  addTile('me', screenStream, true);
  s.sendState();
  reconcile(s);
}

function stopShare(quiet) {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  shareInfo = null;
  shareEncoderInfo = '';
  const s = voiceSession();
  if (s) {
    for (const m of s.members.values()) {
      m.noWatch = false;
      if (m.screenOut) { const c = m.screenOut; m.screenOut = null; c.close(); }
    }
    s.broadcast({ t: 'screen-stop' });
    if (!quiet) s.sendState();
  }
  removeTile('me');
}

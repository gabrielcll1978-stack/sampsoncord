'use strict';
/*
 * Assistir YouTube junto no canal de voz.
 * Qualquer pessoa do canal coloca um link; o vídeo abre pra todos e qualquer um pode pausar,
 * dar play ou pular (os controles do próprio YouTube). Cada ação vira uma mensagem "yt" para
 * quem está no mesmo canal. A posição vai junto em segundos do vídeo (não depende do relógio do PC).
 */
const watchTogether = (() => {
  let state = null;        // { videoId, playing, pos }
  let player = null;
  let apiReady = null;
  let suppressUntil = 0;   // ignora eventos causados por comandos vindos de outra pessoa
  let tick = null;         // última posição vista (pra detectar quando alguém pulou o vídeo)
  let vol = store.get('salinha-ytvol', 60);

  function loadApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (apiReady) return apiReady;
    apiReady = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiReady = null; reject(new Error('Não consegui carregar o YouTube (sem internet?).')); };
      document.head.appendChild(s);
    });
    return apiReady;
  }

  const peers = () => {
    const s = voiceSession();
    return s ? [...s.members.values()].filter((m) => inMyChannel(s, m) && m.conn && m.conn.open) : [];
  };
  function send(obj, only) {
    for (const m of only ? [only] : peers()) { try { m.conn.send({ t: 'yt', cid: voice.cid, ...obj }); } catch { } }
  }
  const curPos = () => { try { return player && player.getCurrentTime ? player.getCurrentTime() || 0 : (state ? state.pos : 0); } catch { return 0; } };
  const quiet = (ms = 2000) => { suppressUntil = Date.now() + ms; };

  // ------------------------------------------------------------ tela do vídeo no palco
  function ensureTile() {
    let tile = $('.tile[data-id="yt"]');
    if (tile) return tile;
    tile = document.createElement('div');
    tile.className = 'tile yt-tile';
    tile.dataset.id = 'yt';
    tile.innerHTML = `<div class="yt-box"><div id="yt-player"></div></div>
      <div class="tile-top"><span class="yt-pill">▶ YouTube</span><span class="lbl">Assistindo juntos</span></div>
      <div class="tile-bar">
        <div class="tb-vol" title="Seu volume do vídeo (só pra você)">
          <button class="tb-btn" data-yt="mute">${vol === 0 ? ICON.volOff : ICON.speaker}</button>
          <input type="range" min="0" max="100" value="${vol}" data-ytvol>
        </div>
        <span class="tb-space"></span>
        <button class="tb-btn tb-text" data-yt="change" title="Colocar outro vídeo">🔗 Trocar vídeo</button>
        <button class="tb-btn tb-text danger-hover" data-yt="stop" title="Fecha o vídeo para todo mundo do canal">✕ Parar para todos</button>
        <button class="tb-btn" data-tile="focus"></button>
        <button class="tb-btn" data-tile="full" title="Tela cheia">${ICON.fullscreen}</button>
      </div>`;
    tile.addEventListener('click', (e) => {
      const b = e.target.closest('[data-yt],[data-tile]');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.tile === 'full') return toggleFullscreen(tile);
      if (b.dataset.tile === 'focus') return tile.classList.contains('focused') ? unfocusTiles() : focusTile('yt');
      if (b.dataset.yt === 'stop') { send({ act: 'stop' }); stop(); toast('Você parou o vídeo para todos'); }
      if (b.dataset.yt === 'change') askLink();
      if (b.dataset.yt === 'mute') setVol(vol > 0 ? 0 : (store.get('salinha-ytvol-prev', 60) || 60), true);
    });
    tile.querySelector('[data-ytvol]').addEventListener('input', (e) => setVol(+e.target.value));
    $('#tiles').prepend(tile);
    focusTile('yt');
    ui.refresh();
    return tile;
  }
  function setVol(v, fromButton) {
    if (vol > 0 && v === 0) store.set('salinha-ytvol-prev', vol);
    vol = v; store.set('salinha-ytvol', v);
    try { player && player.setVolume(v); } catch { }
    const t = $('.tile[data-id="yt"]');
    if (t) { t.querySelector('[data-yt="mute"]').innerHTML = v === 0 ? ICON.volOff : ICON.speaker; if (fromButton) t.querySelector('[data-ytvol]').value = v; }
  }

  // ------------------------------------------------------------ aplicar estado (vindo de mim ou de outra pessoa)
  async function apply(st) {
    if (!st || !/^[\w-]{11}$/.test(st.videoId) || !voice.code) return;
    state = { videoId: st.videoId, playing: !!st.playing, pos: Math.max(0, +st.pos || 0) };
    ensureTile();
    try { await loadApi(); } catch (e) { toast(e.message); return; }
    if (!state) return; // parou enquanto carregava
    quiet();
    if (!player) {
      player = new YT.Player('yt-player', {
        videoId: state.videoId,
        playerVars: { autoplay: state.playing ? 1 : 0, start: Math.floor(state.pos), rel: 0, playsinline: 1, origin: location.origin },
        events: {
          onReady: () => {
            quiet();
            player.setVolume(vol);
            if (deaf) player.mute();
            if (state) { player.seekTo(state.pos, true); state.playing ? player.playVideo() : player.pauseVideo(); }
          },
          onStateChange: onLocalState,
          onError: (e) => {
            const msgs = { 2: 'link inválido', 5: 'erro no player', 100: 'vídeo não encontrado ou privado', 101: 'o dono do vídeo não deixa ele ser tocado fora do YouTube', 150: 'o dono do vídeo não deixa ele ser tocado fora do YouTube', 153: 'o YouTube recusou o player' };
            toast('YouTube: ' + (msgs[e.data] || 'erro ' + e.data));
          },
        },
      });
      player.__vid = state.videoId;
      return;
    }
    if (player.__vid !== state.videoId) {
      player.__vid = state.videoId;
      state.playing ? player.loadVideoById(state.videoId, state.pos) : player.cueVideoById(state.videoId, state.pos);
      return;
    }
    if (Math.abs(curPos() - state.pos) > 1.5) player.seekTo(state.pos, true);
    state.playing ? player.playVideo() : player.pauseVideo();
  }

  // Eu mexi no vídeo (play/pause pelos controles do YouTube): avisa todo mundo
  function onLocalState(e) {
    if (!state) return;
    tick = { pos: curPos(), t: Date.now() };
    if (Date.now() < suppressUntil) return;
    if (e.data === 1) { state.playing = true; state.pos = curPos(); send({ act: 'play', videoId: state.videoId, pos: state.pos }); }
    else if (e.data === 2) { state.playing = false; state.pos = curPos(); send({ act: 'pause', videoId: state.videoId, pos: state.pos }); }
    else if (e.data === 0) { state.playing = false; state.pos = 0; }
  }

  // Detecta quando eu pulei para outro ponto do vídeo (a barra do YouTube nem sempre gera evento)
  setInterval(() => {
    if (!state || !player || !player.getCurrentTime) return;
    const now = Date.now(), pos = curPos();
    if (tick && now >= suppressUntil) {
      const expected = tick.pos + (state.playing ? (now - tick.t) / 1000 : 0);
      if (Math.abs(pos - expected) > 2) {
        state.pos = pos;
        send({ act: state.playing ? 'play' : 'pause', videoId: state.videoId, pos });
      }
    }
    tick = { pos, t: now };
  }, 1000);

  function stop() {
    state = null;
    try { player && player.destroy(); } catch { }
    player = null;
    tick = null;
    removeTile('yt');
  }

  // ------------------------------------------------------------ ações
  function start(videoId) {
    if (!voice.code) return toast('Entre num canal de voz para assistir junto.');
    apply({ videoId, playing: true, pos: 0 });
    send({ act: 'load', videoId, pos: 0 });
    const s = voiceSession();
    if (s) { active = s.code; setView(s, { type: 'voice', cid: voice.cid }); renderAll(); }
  }
  async function askLink() {
    if (!voice.code) return toast('Entre num canal de voz para assistir junto.');
    const link = await askText({ title: 'Assistir YouTube junto', label: 'Link do vídeo do YouTube', placeholder: 'https://www.youtube.com/watch?v=...', ok: 'Assistir', max: 300 });
    if (!link) return;
    const id = ytIdOf(link) || (/^[\w-]{11}$/.test(link.trim()) ? link.trim() : null);
    if (!id) return toast('Não reconheci esse link do YouTube.');
    start(id);
  }

  // ------------------------------------------------------------ mensagens da rede
  function onMessage(s, m, d) {
    if (voice.code !== s.code || d.cid !== voice.cid || !inMyChannel(s, m)) return;
    const vid = typeof d.videoId === 'string' && /^[\w-]{11}$/.test(d.videoId) ? d.videoId : null;
    const pos = Math.max(0, +d.pos || 0);
    switch (d.act) {
      case 'load': if (vid) { apply({ videoId: vid, playing: true, pos }); toast(`▶ ${m.name} colocou um vídeo do YouTube`); } break;
      case 'play': if (vid) apply({ videoId: vid, playing: true, pos: pos + 0.3 }); break;
      case 'pause': if (vid) apply({ videoId: vid, playing: false, pos }); break;
      case 'stop': if (state) { stop(); toast(`${m.name} parou o vídeo`); } break;
      case 'sync-req': if (state) send({ act: 'sync', state: { videoId: state.videoId, playing: state.playing, pos: curPos() } }, m); break;
      case 'sync': if (!state && d.state) apply(d.state); break;
    }
  }
  // Entrei num canal: pergunta se já tem vídeo rolando
  function onJoined() { setTimeout(() => send({ act: 'sync-req' }), 1500); }
  // Alguém (re)conectou e está no meu canal: mando o vídeo atual
  function onMemberHello(s, m) {
    if (state && voice.code === s.code && inMyChannel(s, m)) send({ act: 'sync', state: { videoId: state.videoId, playing: state.playing, pos: curPos() } }, m);
  }
  function setDeaf(v) { try { player && (v ? player.mute() : player.unMute()); } catch { } }

  return { start, askLink, stop, onMessage, onJoined, onMemberHello, setDeaf, get active() { return !!state; } };
})();

// botão "Assistir junto" das prévias de link do YouTube no chat
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action="yt-together"]');
  if (b) { e.stopPropagation(); watchTogether.start(b.dataset.yt); }
}, true);

'use strict';
// ---------------------------------------------------------------- atualização automática
// O processo principal (main.js) procura versão nova ao abrir e a cada 10 min, e baixa sozinho.
// Quando termina de baixar:
//  - ao abrir o app (fora de chamada): reinicia na hora;
//  - com o app já aberto: contagem de 15s e reinicia sozinho (dá pra adiar);
//  - numa chamada ou compartilhando tela: espera a pessoa sair e aí faz a contagem.
const updater = (() => {
  const bar = $('#update-bar');
  let state = null; // null | 'downloading' | 'countdown' | 'waiting-call' | 'postponed' | 'installing'
  let version = '';
  let timer = null;

  function show(html) { bar.innerHTML = html; bar.classList.remove('hidden'); }
  function hide() { bar.classList.add('hidden'); }
  const busy = () => !!voice.code || !!screenStream;

  function install() {
    clearInterval(timer);
    state = 'installing';
    show(`<span>🔄 Reiniciando para atualizar para a versão <b>${esc(version)}</b>…</span>`);
    try { if (voice.code) leaveVoice(true); } catch { }
    setTimeout(() => window.desktop.installUpdate(), 800);
  }
  function countdown() {
    if (busy()) { waitForCall(); return; }
    state = 'countdown';
    let n = 15;
    const paint = () => show(`<span>✅ Versão <b>${esc(version)}</b> baixada. Reiniciando para atualizar em <b>${n}s</b>…</span>
      <button class="primary sm" data-u="install">Atualizar agora</button>
      <button class="ghost sm" data-u="postpone">Adiar</button>`);
    paint();
    clearInterval(timer);
    timer = setInterval(() => {
      if (busy()) { clearInterval(timer); waitForCall(); return; } // entrou numa chamada no meio da contagem
      n -= 1;
      if (n <= 0) install(); else paint();
    }, 1000);
  }
  function waitForCall() {
    state = 'waiting-call';
    show(`<span>✅ Versão <b>${esc(version)}</b> pronta. Vou atualizar quando você sair da chamada.</span>
      <button class="ghost sm" data-u="install">Atualizar agora</button>`);
  }
  // saiu da chamada? começa a contagem
  setInterval(() => { if (state === 'waiting-call' && !busy()) countdown(); }, 3000);

  function handle(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'available' && state === null) {
      state = 'downloading';
      version = d.version || '';
      show(`<span>⬇️ Baixando a versão <b>${esc(version)}</b> do Sampsoncord…</span><div class="ubar"><i style="width:0"></i></div>`);
    } else if (d.type === 'progress' && state === 'downloading') {
      const p = Math.max(0, Math.min(100, +d.percent || 0));
      show(`<span>⬇️ Baixando atualização… ${p}%</span><div class="ubar"><i style="width:${p}%"></i></div>`);
    } else if (d.type === 'downloaded' && state !== 'installing' && state !== 'countdown' && state !== 'waiting-call') {
      version = d.version || version;
      if (d.auto && !busy()) install();   // acabou de abrir o app
      else countdown();                   // app já aberto (ou numa chamada: espera)
    } else if (d.type === 'error' && state === 'downloading') {
      state = null;
      show(`<span>Não deu para baixar a atualização agora. O app vai tentar de novo daqui a pouco.</span>
        <button class="ghost sm" data-u="close">Fechar</button>`);
    }
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (!b) return;
    const a = b.dataset.u;
    if (a === 'install') install();
    else if (a === 'postpone') {
      clearInterval(timer);
      state = 'postponed';
      show(`<span>✅ Versão <b>${esc(version)}</b> pronta. Ela instala sozinha quando você fechar o app.</span>
        <button class="primary sm" data-u="install">Reiniciar e atualizar</button>
        <button class="ghost sm" data-u="close">Fechar aviso</button>`);
    } else if (a === 'close') hide();
  });

  if (window.desktop && window.desktop.onUpdate) window.desktop.onUpdate(handle);
  if (window.desktop && window.desktop.version) {
    window.desktop.version().then((v) => {
      window.APP_VERSION = v;
      $$('.app-version').forEach((el) => (el.textContent = 'Sampsoncord v' + v));
    });
  }
  return { handle }; // exposto para testes
})();

'use strict';
// ---------------------------------------------------------------- aviso de atualização
// O processo principal (main.js) procura versões novas; aqui só mostramos a barra e os botões.
const updater = (() => {
  const bar = $('#update-bar');
  let state = null; // null | 'available' | 'downloading' | 'downloaded'

  function show(html) { bar.innerHTML = html; bar.classList.remove('hidden'); }
  function hide() { bar.classList.add('hidden'); }

  // A partir da 1.4 o download é automático. Se a versão nova foi achada ao ABRIR o app e a
  // pessoa não está numa chamada, instala e reinicia sozinho. Senão, só pergunta.
  function handle(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'available' && state === null) {
      state = 'downloading';
      show(`<span>⬇️ Baixando a versão <b>${esc(d.version)}</b> do Sampsoncord…</span><div class="ubar"><i style="width:0"></i></div>`);
    } else if (d.type === 'progress' && state === 'downloading') {
      const p = Math.max(0, Math.min(100, +d.percent || 0));
      show(`<span>⬇️ Baixando atualização… ${p}%</span><div class="ubar"><i style="width:${p}%"></i></div>`);
    } else if (d.type === 'downloaded' && d.auto && !voice.code && !screenStream) {
      state = 'installing';
      show(`<span>✅ Versão <b>${esc(d.version)}</b> baixada. Reiniciando para atualizar…</span>`);
      setTimeout(() => window.desktop.installUpdate(), 2000);
    } else if (d.type === 'downloaded') {
      state = 'downloaded';
      show(`<span>✅ Versão <b>${esc(d.version)}</b> baixada!</span>
        <button class="primary sm" data-u="install">Reiniciar e atualizar</button>
        <button class="ghost sm" data-u="later">Atualizar quando eu fechar</button>`);
    } else if (d.type === 'error' && state === 'downloading') {
      state = null;
      show(`<span>Não deu para baixar a atualização agora. O app vai tentar de novo mais tarde.</span>
        <button class="ghost sm" data-u="later">Fechar</button>`);
    }
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (!b) return;
    const a = b.dataset.u;
    if (a === 'later') {
      hide();
      if (state === 'available') state = null; // avisa de novo na próxima checagem
    } else if (a === 'download') {
      state = 'downloading';
      show('<span>Baixando atualização… 0%</span><div class="ubar"><i style="width:0"></i></div>');
      window.desktop.downloadUpdate().catch(() => handle({ type: 'error' }));
    } else if (a === 'install') {
      try { if (voice.code) leaveVoice(true); } catch { }
      window.desktop.installUpdate();
    }
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

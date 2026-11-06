// Layout de celular: servidores/canais e membros viram gavetas laterais.
// Só tem efeito visual em telas estreitas (ver @media no style.css).
(() => {
  const mq = matchMedia('(max-width: 800px)');
  const body = document.body;
  const close = () => body.classList.remove('nav-open', 'members-open');

  // celular/navegador sem compartilhamento de tela → esconde os botões de compartilhar
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !window.desktop) body.classList.add('no-share');

  document.getElementById('mob-nav').addEventListener('click', () => {
    body.classList.remove('members-open');
    body.classList.toggle('nav-open');
  });
  document.getElementById('mob-members').addEventListener('click', () => {
    body.classList.remove('nav-open');
    body.classList.toggle('members-open');
  });
  document.getElementById('mob-backdrop').addEventListener('click', close);
  mq.addEventListener('change', (e) => { if (!e.matches) close(); });

  // escolheu um canal / início / voz → fecha a gaveta e mostra o conteúdo
  document.addEventListener('click', (e) => {
    if (!mq.matches) return;
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'channel' && !e.target.closest('.del-ch')) setTimeout(close, 0);
    else if (['home', 'goto-voice', 'create-server', 'join-server', 'add-server', 'settings', 'account', 'server-settings'].includes(act)) setTimeout(close, 0);
    else if (act === 'profile' && body.classList.contains('members-open')) setTimeout(close, 0);
  });

  // segurar o dedo no nome da pessoa = botão direito (menu de volumes)
  let timer = null, startX = 0, startY = 0, fired = false;
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[data-speak]');
    fired = false;
    if (!el || e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: startX, clientY: startY }));
    }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (timer && t && Math.hypot(t.clientX - startX, t.clientY - startY) > 10) { clearTimeout(timer); timer = null; }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    clearTimeout(timer); timer = null;
    if (fired) { e.preventDefault(); fired = false; } // não abre o perfil nem fecha o menu ao soltar
  });
  // Android também dispara o contextmenu nativo no toque longo — evita abrir duas vezes
  document.addEventListener('contextmenu', (e) => { if (e.isTrusted && fired) e.stopImmediatePropagation(); }, true);
})();

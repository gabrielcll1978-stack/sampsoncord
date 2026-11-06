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
})();

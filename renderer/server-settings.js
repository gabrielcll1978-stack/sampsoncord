'use strict';
// ---------------------------------------------------------------- Configurações do servidor
// Abas: Geral (nome, foto, dono) · Cargos · Membros · Canais (quem acessa cada canal)

function openServerSettings(s) {
  if (!s) return;
  const st = s.state;
  const me = user.id;
  const isOwner = srvOwner(st) === me;
  const canServer = can(st, me, 'manageServer');
  const canAdmin = can(st, me, 'admin');
  const canCh = can(st, me, 'manageChannels');
  const draft = JSON.parse(JSON.stringify(st.perms || emptyPerms()));
  let icon = st.icon || '';

  // pessoas conhecidas: online agora + quem já tem cargo + eu
  const people = new Map();
  people.set(me, user.name + ' (você)');
  for (const m of s.members.values()) if (m.named && m.uid) people.set(m.uid, m.name);
  for (const uid of Object.keys(draft.members || {})) if (!people.has(uid)) people.set(uid, (profileCache[uid] && profileCache[uid].name) || 'Alguém (offline)');
  const ownerName = srvOwner(st) ? (people.get(srvOwner(st)) || (profileCache[srvOwner(st)] && profileCache[srvOwner(st)].name) || 'alguém') : null;

  openModal(`
    <h2>Configurações do servidor</h2>
    <div class="tabs four">
      <button data-tab="geral" class="on">Geral</button><button data-tab="cargos">Cargos</button>
      <button data-tab="membros">Membros</button><button data-tab="canais">Canais</button>
    </div>

    <div data-pane="geral" class="ss-pane">
      <div class="ss-icon-row">
        <span class="srv-ico big" id="ss-icon"></span>
        <div class="ss-icon-btns">
          ${canServer ? `<button type="button" class="sm" id="ss-pick">🖼️ Trocar foto</button><button type="button" class="sm ghost" id="ss-rm">Remover</button>` : '<span class="muted small">Só quem gerencia o servidor pode trocar a foto.</span>'}
          <input type="file" id="ss-file" accept="image/*" class="hidden">
        </div>
      </div>
      <label class="field">Nome do servidor<input id="ss-name" maxlength="40" value="${esc(s.name)}" ${canServer ? '' : 'disabled'}></label>
      <div class="ss-owner">${ownerName ? `👑 Dono: <b>${esc(ownerName)}</b>` : 'Este servidor ainda não tem dono (foi criado antes dos cargos existirem).'}</div>
      ${!srvOwner(st) ? `<button type="button" class="sm" id="ss-claim">👑 Tornar-me dono deste servidor</button>
        <p class="muted small">O dono pode criar cargos e definir quem acessa cada canal. Enquanto não houver dono, ninguém pode mexer em canais e cargos — quem criou o servidor deve clicar aqui.</p>` : ''}
    </div>

    <div data-pane="cargos" class="ss-pane hidden">
      ${canAdmin ? '' : '<p class="muted small">Só o dono e administradores podem mexer nos cargos.</p>'}
      <div id="ss-roles"></div>
      ${canAdmin ? '<button type="button" class="sm" id="ss-add-role">＋ Novo cargo</button>' : ''}
    </div>

    <div data-pane="membros" class="ss-pane hidden">
      <p class="muted small">Marque os cargos de cada pessoa. Aparecem aqui quem está online agora e quem já tem cargo.</p>
      <div id="ss-members"></div>
    </div>

    <div data-pane="canais" class="ss-pane hidden">
      <p class="muted small">Por padrão todo mundo vê todos os canais. Marque cargos para deixar o canal só para eles (dono e administradores sempre veem tudo).</p>
      <div id="ss-channels"></div>
    </div>

    <p class="muted small ss-note">Obs: sem servidor central, quem garante as regras é o app de cada um. Funciona entre amigos, mas não impede alguém que modifique o próprio app.</p>
    <div class="modal-actions"><button class="ghost" data-x>Cancelar</button><button class="primary" id="ss-save">Salvar</button></div>
  `, (card) => {
    card.classList.add('wide');
    $$('[data-tab]', card).forEach((b) => (b.onclick = () => {
      $$('[data-tab]', card).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', card).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    }));
    card.querySelector('[data-x]').onclick = closeModal;

    // ---- geral
    const paintIcon = () => {
      const el = card.querySelector('#ss-icon');
      el.setAttribute('style', icon ? `background:center/cover url('${icon}')` : `background:${colorFor(s.code)}`);
      el.innerHTML = icon ? '' : initials(card.querySelector('#ss-name').value || s.name, 2);
    };
    paintIcon();
    card.querySelector('#ss-name').oninput = paintIcon;
    if (canServer) {
      const file = card.querySelector('#ss-file');
      card.querySelector('#ss-pick').onclick = () => file.click();
      card.querySelector('#ss-rm').onclick = () => { icon = ''; paintIcon(); };
      file.onchange = async () => { try { icon = await resizeImage(file.files[0]); paintIcon(); } catch (e) { toast(e.message); } file.value = ''; };
    }
    const claim = card.querySelector('#ss-claim');
    if (claim) claim.onclick = () => {
      if (!confirm('Tornar-se dono deste servidor? Isso vale para todos os membros.')) return;
      st.owner = { uid: me, ts: Date.now() };
      s.pushServer();
      closeModal();
      toast('👑 Agora você é o dono do servidor');
      openServerSettings(s);
    };

    // ---- cargos
    const rolesBox = card.querySelector('#ss-roles');
    const paintRoles = () => {
      const roles = Object.values(draft.roles);
      rolesBox.innerHTML = roles.length ? roles.map((r) => `
        <div class="role-card" data-rid="${r.id}">
          <div class="role-head">
            <input type="color" data-k="color" value="${r.color || '#99aab5'}" ${canAdmin ? '' : 'disabled'}>
            <input data-k="name" maxlength="30" value="${esc(r.name)}" ${canAdmin ? '' : 'disabled'}>
            ${canAdmin ? '<button type="button" class="ghost sm" data-del title="Apagar cargo">🗑️</button>' : ''}
          </div>
          <div class="role-perms">${Object.entries(PERMS).map(([k, label]) =>
            `<label class="check"><input type="checkbox" data-k="${k}" ${r[k] ? 'checked' : ''} ${canAdmin ? '' : 'disabled'}> ${label}</label>`).join('')}
            <span class="muted small">Sem nenhuma marcada: o cargo serve só para dar acesso a canais e colorir o nome.</span>
          </div>
        </div>`).join('') : '<p class="muted">Nenhum cargo ainda.</p>';
      $$('.role-card', rolesBox).forEach((el) => {
        const r = draft.roles[el.dataset.rid];
        $$('[data-k]', el).forEach((inp) => (inp.oninput = inp.onchange = () => {
          if (inp.type === 'checkbox') r[inp.dataset.k] = inp.checked;
          else if (inp.dataset.k === 'color') r.color = inp.value;
          else r.name = cleanName(inp.value, 30) || 'Cargo';
          paintMembers(); paintChannels();
        }));
        const del = el.querySelector('[data-del]');
        if (del) del.onclick = () => {
          delete draft.roles[r.id];
          for (const uid of Object.keys(draft.members)) draft.members[uid] = draft.members[uid].filter((x) => x !== r.id);
          for (const cid of Object.keys(draft.access)) draft.access[cid] = draft.access[cid].filter((x) => x !== r.id);
          paintRoles(); paintMembers(); paintChannels();
        };
      });
    };
    const addRole = card.querySelector('#ss-add-role');
    if (addRole) addRole.onclick = () => {
      const id = rand(8);
      draft.roles[id] = { id, name: 'Novo cargo', color: '#5865f2', admin: false, manageChannels: false, manageServer: false };
      paintRoles(); paintMembers(); paintChannels();
    };

    // ---- membros
    const membersBox = card.querySelector('#ss-members');
    const paintMembers = () => {
      const roles = Object.values(draft.roles);
      if (!roles.length) { membersBox.innerHTML = '<p class="muted">Crie um cargo primeiro (aba Cargos).</p>'; return; }
      membersBox.innerHTML = [...people.entries()].map(([uid, name]) => {
        const mine = draft.members[uid] || [];
        const owner = uid === srvOwner(st);
        return `<div class="mem-row" data-uid="${esc(uid)}">
          ${avatarHTML({ uid, name }, 'xs')}<span class="mem-name">${esc(name)}${owner ? ' 👑' : ''}</span>
          <span class="mem-roles">${roles.map((r) => `<label class="role-chip" style="--rc:${r.color || '#99aab5'}">
            <input type="checkbox" data-rid="${r.id}" ${mine.includes(r.id) ? 'checked' : ''} ${canAdmin ? '' : 'disabled'}>${esc(r.name)}</label>`).join('')}</span>
        </div>`;
      }).join('');
      $$('.mem-row input', membersBox).forEach((inp) => (inp.onchange = () => {
        const uid = inp.closest('.mem-row').dataset.uid;
        const set = new Set(draft.members[uid] || []);
        inp.checked ? set.add(inp.dataset.rid) : set.delete(inp.dataset.rid);
        draft.members[uid] = [...set];
      }));
    };

    // ---- canais
    const chBox = card.querySelector('#ss-channels');
    const paintChannels = () => {
      const roles = Object.values(draft.roles);
      const all = [...s.channels('text'), ...s.channels('voice')];
      chBox.innerHTML = all.map((c) => {
        const acc = draft.access[c.id] || [];
        return `<div class="ch-acc" data-cid="${c.id}">
          <div class="ch-acc-name">${c.type === 'text' ? '#' : '🔊'} ${esc(c.name)} <span class="muted small">${acc.length ? '🔒 só para os cargos marcados' : 'todos podem acessar'}</span></div>
          <div class="mem-roles">${roles.length ? roles.map((r) => `<label class="role-chip" style="--rc:${r.color || '#99aab5'}">
            <input type="checkbox" data-rid="${r.id}" ${acc.includes(r.id) ? 'checked' : ''} ${canCh ? '' : 'disabled'}>${esc(r.name)}</label>`).join('') : '<span class="muted small">Crie cargos para restringir canais.</span>'}</div>
        </div>`;
      }).join('');
      $$('.ch-acc input', chBox).forEach((inp) => (inp.onchange = () => {
        const cid = inp.closest('.ch-acc').dataset.cid;
        const set = new Set(draft.access[cid] || []);
        inp.checked ? set.add(inp.dataset.rid) : set.delete(inp.dataset.rid);
        draft.access[cid] = [...set];
        paintChannels();
      }));
    };
    paintRoles(); paintMembers(); paintChannels();

    // ---- salvar
    card.querySelector('#ss-save').onclick = () => {
      const name = cleanName(card.querySelector('#ss-name').value, 40);
      if (canServer && name && name !== s.name) s.rename(name);
      if (canServer && icon !== (st.icon || '')) s.setIcon(icon);
      const before = JSON.stringify(cleanPerms(st.perms || emptyPerms()));
      const after = cleanPerms(draft);
      if ((canAdmin || canCh) && JSON.stringify({ ...after, ts: 0, by: '' }) !== JSON.stringify({ ...JSON.parse(before), ts: 0, by: '' })) {
        if (!canAdmin) { after.roles = (st.perms || emptyPerms()).roles; after.members = (st.perms || emptyPerms()).members; }
        s.pushPerms(after);
      }
      closeModal();
      renderAll();
      toast('Configurações salvas');
    };
  });
}

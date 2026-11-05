'use strict';
/*
 * Cargos e permissões de servidor.
 *
 * Fica dentro do estado do servidor (sincronizado entre todos):
 *   owner: { uid, ts }                      dono do servidor
 *   perms: { ts, by,                        última alteração e quem fez
 *            roles:   { id: { id, name, color, admin, manageChannels, manageServer } },
 *            members: { uid: [roleId, ...] },
 *            access:  { channelId: [roleId, ...] } }   canal restrito a esses cargos
 *
 * Importante: não existe servidor central, então quem garante as regras é o próprio app de cada um.
 * Funciona bem entre amigos, mas não impede alguém que modifique o próprio app de propósito.
 */

const PERMS = {
  admin: 'Administrador (pode tudo)',
  manageChannels: 'Gerenciar canais (criar, apagar, definir acesso)',
  manageServer: 'Gerenciar servidor (nome e foto)',
};

const srvOwner = (st) => (st.owner && st.owner.uid) || null;
const roleIdsOf = (st, uid) => (st.perms && st.perms.members && st.perms.members[uid]) || [];
const rolesOf = (st, uid) => roleIdsOf(st, uid).map((id) => st.perms.roles[id]).filter(Boolean);

// uid tem a permissão? Só o dono (criador) e quem ele der cargo com permissão.
// Servidor antigo sem dono: ninguém mexe em canais/cargos até o criador clicar em "Tornar-me dono".
function can(st, uid, perm) {
  if (!st.owner) return false;
  if (uid && uid === st.owner.uid) return true;
  return rolesOf(st, uid).some((r) => r.admin || r[perm]);
}

// uid pode ver/entrar nesse canal?
function canAccess(st, uid, cid) {
  const acc = st.perms && st.perms.access && st.perms.access[cid];
  if (!acc || !acc.length) return true;
  if (can(st, uid, 'admin')) return true;
  const mine = roleIdsOf(st, uid);
  return acc.some((r) => mine.includes(r));
}

// Cor do cargo mais "alto" (primeiro da lista) que tem cor
function roleColor(st, uid) {
  if (!st || !st.perms) return null;
  const order = Object.keys(st.perms.roles || {});
  const mine = roleIdsOf(st, uid).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const id of mine) { const r = st.perms.roles[id]; if (r && r.color) return r.color; }
  return null;
}

function cleanPerms(p) {
  const out = { ts: +p.ts || 0, by: String(p.by || '').slice(0, 32), roles: {}, members: {}, access: {} };
  for (const r of Object.values(p.roles || {}).slice(0, 25)) {
    if (!r || typeof r.id !== 'string' || r.id.length > 16) continue;
    out.roles[r.id] = {
      id: r.id, name: cleanName(r.name, 30) || 'Cargo',
      color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '',
      admin: !!r.admin, manageChannels: !!r.manageChannels, manageServer: !!r.manageServer,
    };
  }
  for (const [uid, ids] of Object.entries(p.members || {}).slice(0, 500)) {
    if (typeof uid !== 'string' || uid.length > 32 || !Array.isArray(ids)) continue;
    const ok = ids.filter((id) => out.roles[id]).slice(0, 10);
    if (ok.length) out.members[uid] = ok;
  }
  for (const [cid, ids] of Object.entries(p.access || {}).slice(0, 200)) {
    if (typeof cid !== 'string' || cid.length > 16 || !Array.isArray(ids)) continue;
    const ok = ids.filter((id) => out.roles[id]);
    if (ok.length) out.access[cid] = ok;
  }
  return out;
}

// Junta dono e permissões vindos de outro membro. Dono: vale o pedido mais antigo (todos
// convergem para o mesmo). Permissões: vale a alteração mais recente feita por quem pode.
function mergePerms(a, b) {
  let changed = false;
  if (b.owner && typeof b.owner.uid === 'string' && b.owner.uid) {
    const bo = { uid: b.owner.uid.slice(0, 32), ts: Math.max(1.6e12, +b.owner.ts || 0) };
    const better = !a.owner || bo.ts < a.owner.ts || (bo.ts === a.owner.ts && bo.uid < a.owner.uid);
    if (better && !(a.owner && a.owner.uid === bo.uid && a.owner.ts === bo.ts)) { a.owner = bo; changed = true; }
  }
  if (b.perms && typeof b.perms === 'object' && (+b.perms.ts || 0) > ((a.perms && a.perms.ts) || 0)) {
    const by = String(b.perms.by || '');
    const np = cleanPerms(b.perms), cur = a.perms || emptyPerms();
    // quem só gerencia canais pode mudar o acesso dos canais, mas não cargos/membros
    const onlyAccess = JSON.stringify(np.roles) === JSON.stringify(cur.roles) && JSON.stringify(np.members) === JSON.stringify(cur.members);
    if (can(a, by, 'admin') || (onlyAccess && can(a, by, 'manageChannels'))) { a.perms = np; changed = true; }
  }
  return changed;
}

const emptyPerms = () => ({ ts: 0, by: '', roles: {}, members: {}, access: {} });

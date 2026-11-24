// Profiles and friends: my profile editor, the Friends tab, and the public profile page.
import { store } from './store.js';
import { profileFromUser } from './cloud.js';
import { $, esc, toast, avatar, resizeImage } from './ui.js';

const state = {
  api: null,
  uid: null,
  me: null, // my profile
  friendIds: [],
  friends: new Map(), // uid -> profile (null while loading or hidden)
  incoming: [],
  outgoing: [],
  directory: null, // public profiles, loaded on demand
  directoryAt: 0,
  fof: null, // public friends of my friends: [{...profile, uid, via: [friendUid]}]
  fofAt: 0,
  query: '',
};
const friendSubs = new Map();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());
let createdProfile = false;
let statsTimer = null;

const face = (p) => ({ name: p?.name || p?.fromName || 'ผู้ใช้', photo: p?.thumb || p?.fromThumb || '' });
const bigFace = (p) => ({ name: p?.name || 'ผู้ใช้', photo: p?.photo || p?.thumb || '' });
const errMsg = (e) => (e?.code === 'permission-denied' ? 'ไม่มีสิทธิ์ทำรายการนี้' : e?.code === 'unavailable' ? 'ออฟไลน์อยู่ ลองใหม่เมื่อมีอินเทอร์เน็ต' : e?.message || 'เกิดข้อผิดพลาด');

export const social = {
  onNewProfile: null, // called once after a first-time profile is created

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  get active() { return Boolean(state.api && state.uid); },
  get me() { return state.me; },
  get uid() { return state.uid; },
  get incomingCount() { return state.incoming.length; },
  get fofReady() { return state.fof !== null; },
  /** Friends with loaded profiles, sorted by name. */
  get friends() {
    return state.friendIds.map((id) => ({ uid: id, ...(state.friends.get(id) || { name: '…' }) }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  },
  isFriend: (uid) => state.friendIds.includes(uid),
  friendProfile: (uid) => state.friends.get(uid) || null,

  /** Status of another user relative to me. */
  relation(uid) {
    if (uid === state.uid) return 'me';
    if (state.friendIds.includes(uid)) return 'friend';
    if (state.incoming.some((r) => r.from === uid)) return 'incoming';
    if (state.outgoing.some((r) => r.to === uid)) return 'outgoing';
    return 'none';
  },

  /* ----- lifecycle ----- */
  start(api, user) {
    state.api = api;
    state.uid = user.uid;
    state.user = user;
    createdProfile = false;
    return {
      onProfile: (p, fromCache) => {
        if (!p) {
          // First sign-in: create a profile from the Google account (only when the server says none exists).
          if (!fromCache && !createdProfile) {
            createdProfile = true;
            const fresh = { ...profileFromUser(user), createdAt: new Date().toISOString() };
            api.saveProfile(user.uid, fresh).then(() => social.onNewProfile?.()).catch((e) => toast(errMsg(e)));
          }
          state.me = { ...profileFromUser(user), uid: user.uid };
        } else {
          state.me = p;
        }
        api.setMe(state.me);
        emit();
      },
      onFriendIds: (ids) => { state.friendIds = ids; state.fof = null; syncFriendSubs(); emit(); },
      onIncoming: (list) => { state.incoming = list; emit(); },
      onOutgoing: (list) => { state.outgoing = list; emit(); },
    };
  },
  stop() {
    friendSubs.forEach((u) => u());
    friendSubs.clear();
    Object.assign(state, { api: null, uid: null, me: null, friendIds: [], incoming: [], outgoing: [], directory: null, directoryAt: 0, fof: null, fofAt: 0 });
    state.friends = new Map();
    emit();
  },

  /* ----- actions ----- */
  async saveProfile(patch) {
    const next = { ...state.me, ...patch };
    await state.api.saveProfile(state.uid, next);
    social.loadDirectory(true);
    // Keep my name/photo current in plans I'm part of.
    state.api.syncMemberSnapshot(state.uid, store.plans, next).catch(() => {});
  },
  /** Called when places/plans change; saves the counts shown on my public profile. */
  updateStats(stats) {
    if (!state.me || !state.api) return;
    const cur = state.me.stats || {};
    if (cur.places === stats.places && cur.visited === stats.visited && cur.plans === stats.plans) return;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => state.api?.saveProfile(state.uid, { ...state.me, stats }).catch(() => {}), 2000);
  },
  syncPlans() {
    if (state.api && state.me) state.api.syncMemberSnapshot(state.uid, store.plans, state.me).catch(() => {});
  },
  async request(uid) {
    try { await state.api.sendRequest(state.uid, uid); toast('ส่งคำขอเป็นเพื่อนแล้ว'); } catch (e) { toast(errMsg(e)); }
  },
  async cancel(uid) {
    try { await state.api.cancelRequest(state.uid, uid); toast('ยกเลิกคำขอแล้ว'); } catch (e) { toast(errMsg(e)); }
  },
  async accept(uid) {
    const req = state.incoming.find((r) => r.from === uid);
    try {
      await state.api.acceptRequest(state.uid, uid, state.outgoing.some((r) => r.to === uid));
      toast(`เป็นเพื่อนกับ ${req?.fromName || 'ผู้ใช้'} แล้ว 🎉`);
    } catch (e) { toast(errMsg(e)); }
  },
  async decline(uid) {
    try { await state.api.cancelRequest(uid, state.uid); toast('ปฏิเสธคำขอแล้ว'); } catch (e) { toast(errMsg(e)); }
  },
  async unfriend(uid) {
    try { await state.api.unfriend(state.uid, uid); toast('เลิกเป็นเพื่อนแล้ว'); } catch (e) { toast(errMsg(e)); }
  },
  /** Public profiles of my friends' friends (not me, not already my friends). */
  async loadFriendsOfFriends(force = false) {
    if (!state.api || fofLoading) return;
    if (!force && state.fof && Date.now() - state.fofAt < 60000) return;
    fofLoading = true;
    try {
      const via = new Map();
      await Promise.all(state.friendIds.map(async (fid) => {
        (await state.api.friendIdsOf(fid).catch(() => [])).forEach((id) => {
          if (id === state.uid || state.friendIds.includes(id)) return;
          if (!via.has(id)) via.set(id, []);
          via.get(id).push(fid);
        });
      }));
      const found = await Promise.all([...via.keys()].slice(0, 100).map((id) => publicProfile(id)));
      state.fof = found.filter(Boolean)
        .map((p) => ({ ...p, via: via.get(p.uid) }))
        .sort((a, b) => b.via.length - a.via.length || (a.name || '').localeCompare(b.name || '', 'th'));
      state.fofAt = Date.now();
    } finally {
      fofLoading = false;
    }
    emit();
  },
  /** Public friends of one of my friends (for their profile page). */
  async publicFriendsOf(uid) {
    const ids = (await state.api.friendIdsOf(uid).catch(() => [])).filter((id) => id !== state.uid);
    const list = await Promise.all(ids.slice(0, 100).map((id) => publicProfile(id)));
    return list.filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  },
  async loadDirectory(force = false) {
    if (!state.api) return;
    if (!force && state.directory && Date.now() - state.directoryAt < 60000) return;
    try {
      state.directory = await state.api.publicProfiles();
      state.directoryAt = Date.now();
    } catch (e) {
      state.directory = [];
      toast(errMsg(e));
    }
    emit();
  },
};

let fofLoading = false;
/** A user's profile if it is public (null for private or hidden ones). */
async function publicProfile(uid) {
  const known = (state.directory || []).find((p) => p.uid === uid);
  if (known) return known;
  const p = await state.api.getProfile(uid);
  return p && p.isPublic ? p : null;
}

function syncFriendSubs() {
  const want = new Set(state.friendIds);
  friendSubs.forEach((unsub, id) => { if (!want.has(id)) { unsub(); friendSubs.delete(id); state.friends.delete(id); } });
  want.forEach((id) => {
    if (friendSubs.has(id)) return;
    friendSubs.set(id, state.api.watchProfile(id, (p) => { state.friends.set(id, p); emit(); }));
  });
}

/* =================== UI =================== */

const confirmBox = (msg) => window.confirm(msg);

/** Buttons for the relation with another user. */
function actionButtons(uid, compact = false) {
  const rel = social.relation(uid);
  const c = compact ? 'chip' : 'btn';
  switch (rel) {
    case 'me': return `<span class="role owner">คุณ</span>`;
    case 'friend': return compact ? '<span class="role">เพื่อน</span>' : `<button class="${c} danger" data-act="unfriend" data-uid="${uid}">เลิกเป็นเพื่อน</button>`;
    case 'incoming': return `<button class="${c} primary" data-act="accept" data-uid="${uid}">ยอมรับ</button><button class="${c}" data-act="decline" data-uid="${uid}">ปฏิเสธ</button>`;
    case 'outgoing': return `<button class="${c}" data-act="cancel" data-uid="${uid}">ยกเลิกคำขอ</button>`;
    default: return `<button class="${c} primary" data-act="request" data-uid="${uid}">+ เพิ่มเพื่อน</button>`;
  }
}

async function runAction(act, uid, name = '') {
  if (act === 'request') return social.request(uid);
  if (act === 'cancel') return social.cancel(uid);
  if (act === 'accept') return social.accept(uid);
  if (act === 'decline') return social.decline(uid);
  if (act === 'unfriend' && confirmBox(`เลิกเป็นเพื่อนกับ ${name || 'คนนี้'}?`)) return social.unfriend(uid);
}

function personRow(p, sub = '') {
  return `<li class="person" data-open="${esc(p.uid)}">
    ${avatar(face(p))}
    <div class="who"><b>${esc(p.name || 'ผู้ใช้')}</b><small>${sub}</small></div>
    <div class="acts">${actionButtons(p.uid, true)}</div>
  </li>`;
}

const statsLine = (p) => {
  const s = p?.stats;
  if (!s) return '';
  return `ปักหมุด ${s.places ?? 0} ที่ · ไปแล้ว ${s.visited ?? 0} ที่ · ${s.plans ?? 0} แผน`;
};

/* ----- Friends tab ----- */
export function renderFriendsView() {
  const root = $('#friends-body');
  if (!root) return;
  if (!social.active) {
    root.innerHTML = `<div class="empty"><b>👥</b>เข้าสู่ระบบด้วย Google เพื่อสร้างโปรไฟล์ ค้นหานักเดินทาง และเพิ่มเพื่อนสำหรับชวนไปเที่ยวด้วยกัน
      <div style="margin-top:14px"><button class="btn primary" data-signin>เข้าสู่ระบบ</button></div></div>`;
    return;
  }
  const me = state.me || {};
  const q = state.query.trim().toLowerCase();
  const match = (p) => !q || (p.name || '').toLowerCase().includes(q) || (p.fromName || '').toLowerCase().includes(q);

  const incoming = state.incoming.filter(match);
  const friends = social.friends.filter(match);
  const outgoing = state.outgoing.filter((r) => match(state.friends.get(r.to) || findDir(r.to) || {}));
  const fof = (state.fof || []).filter(match);
  const fofIds = new Set(fof.map((p) => p.uid));
  const viaText = (p) => {
    const names = p.via.map((id) => state.friends.get(id)?.name).filter(Boolean);
    return names.length ? `เพื่อนของ ${esc(names.slice(0, 2).join(', '))}${names.length > 2 ? ` และอีก ${names.length - 2} คน` : ''}` : 'เพื่อนของเพื่อน';
  };
  const dir = (state.directory || [])
    .filter((p) => p.uid !== state.uid && !state.friendIds.includes(p.uid) && !fofIds.has(p.uid) && match(p))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));

  root.innerHTML = `
    <div class="me-card" data-edit-profile role="button" tabindex="0">
      ${avatar(bigFace(me), 'lg')}
      <div class="who"><b>${esc(me.name || '')}</b>
        <small>${me.isPublic ? '🌐 โปรไฟล์สาธารณะ: ทุกคนค้นหาเจอ' : '🔒 โปรไฟล์ส่วนตัว: เห็นเฉพาะเพื่อน'}</small></div>
      <span class="chip">แก้ไข</span>
    </div>
    <input id="friends-search" class="search" type="search" placeholder="ค้นหาชื่อนักเดินทาง…" value="${esc(state.query)}">

    ${incoming.length ? `<h3 class="sec">คำขอเป็นเพื่อน <span class="count hot">${incoming.length}</span></h3>
      <ul class="people">${incoming.map((r) => personRow({ uid: r.from, name: r.fromName, thumb: r.fromThumb }, 'อยากเป็นเพื่อนกับคุณ')).join('')}</ul>` : ''}

    <h3 class="sec">เพื่อนของฉัน <span class="count">${state.friendIds.length}</span></h3>
    ${friends.length ? `<ul class="people">${friends.map((p) => personRow(p, statsLine(p) || (p.isPublic ? 'สาธารณะ' : 'ส่วนตัว'))).join('')}</ul>`
      : `<p class="muted pad-s">${q ? 'ไม่พบเพื่อนชื่อนี้' : 'ยังไม่มีเพื่อน ค้นหานักเดินทางด้านล่าง แล้วกด “+ เพิ่มเพื่อน”'}</p>`}

    ${outgoing.length ? `<h3 class="sec">คำขอที่ส่งไป <span class="count">${outgoing.length}</span></h3>
      <ul class="people">${outgoing.map((r) => { const p = findDir(r.to) || {}; return personRow({ uid: r.to, name: p.name || 'ผู้ใช้', thumb: p.thumb }, 'รอการตอบรับ'); }).join('')}</ul>` : ''}

    ${state.friendIds.length ? `<h3 class="sec">เพื่อนของเพื่อน ${state.fof ? `<span class="count">${fof.length}</span>` : ''}</h3>
      ${state.fof === null ? '<p class="muted pad-s">กำลังโหลด…</p>'
        : fof.length ? `<ul class="people">${fof.map((p) => personRow(p, viaText(p))).join('')}</ul>`
        : `<p class="muted pad-s">${q ? 'ไม่พบชื่อนี้ในเพื่อนของเพื่อน' : 'ยังไม่มีเพื่อนของเพื่อนที่เป็นโปรไฟล์สาธารณะ'}</p>`}` : ''}

    <div class="row-between"><h3 class="sec">นักเดินทางสาธารณะ</h3><button class="chip" data-refresh>รีเฟรช</button></div>
    ${state.directory === null ? '<p class="muted pad-s">กำลังโหลด…</p>'
      : dir.length ? `<ul class="people">${dir.map((p) => personRow(p, statsLine(p) || esc((p.bio || '').slice(0, 60)))).join('')}</ul>`
      : `<p class="muted pad-s">${q ? 'ไม่พบชื่อนี้ในโปรไฟล์สาธารณะ' : 'ยังไม่มีโปรไฟล์สาธารณะอื่น'}</p>`}
    ${me.isPublic ? '' : '<p class="notice">โปรไฟล์ของคุณเป็นส่วนตัว คนอื่นจะค้นหาคุณไม่เจอและส่งคำขอมาไม่ได้ เปลี่ยนเป็นสาธารณะได้ที่ “แก้ไข” ด้านบน</p>'}
  `;
  const input = $('#friends-search');
  input.oninput = () => {
    state.query = input.value;
    const pos = input.selectionStart;
    renderFriendsView();
    const again = $('#friends-search');
    again.focus();
    again.setSelectionRange(pos, pos);
  };
}
const findDir = (uid) => (state.directory || []).find((p) => p.uid === uid) || state.friends.get(uid);

export function bindFriendsView({ openAccount, openSignIn }) {
  $('#friends-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-signin]')) return openSignIn();
    if (e.target.closest('[data-edit-profile]')) return openAccount();
    if (e.target.closest('[data-refresh]')) {
      state.directory = null;
      state.fof = null;
      renderFriendsView();
      return social.loadDirectory(true).then(() => social.loadFriendsOfFriends(true));
    }
    const btn = e.target.closest('[data-act]');
    if (btn) {
      e.stopPropagation();
      const row = btn.closest('[data-open]');
      return runAction(btn.dataset.act, btn.dataset.uid, row?.querySelector('b')?.textContent);
    }
    const row = e.target.closest('[data-open]');
    if (row) openUser(row.dataset.open);
  });
}

/* ----- Public profile page ----- */
let viewing = null;
let userFriends; // undefined = not shown / loading, [] = none
export async function openUser(uid, fallback = null) {
  const dlg = $('#dlg-user');
  viewing = uid;
  let p = uid === state.uid ? state.me : state.friends.get(uid) || findDir(uid) || null;
  if (!p) {
    const req = state.incoming.find((r) => r.from === uid);
    p = fallback || (req ? { name: req.fromName, thumb: req.fromThumb, hidden: true } : null);
  }
  userFriends = undefined;
  renderUser(uid, p);
  if (!dlg.open) dlg.showModal();
  // Fetch the latest version (also tells us if the profile is hidden from us).
  const fresh = state.api ? await state.api.getProfile(uid) : null;
  if (viewing === uid && dlg.open) renderUser(uid, fresh || (p ? { ...p, hidden: true } : null));
  // A friend's page lists their public friends.
  if (state.api && social.isFriend(uid)) {
    const list = await social.publicFriendsOf(uid);
    if (viewing === uid && dlg.open) { userFriends = list; renderUser(uid, fresh || p); }
  }
}

function renderUser(uid, p) {
  const body = $('#user-body');
  if (!p) {
    body.innerHTML = '<p class="muted">ไม่พบโปรไฟล์นี้ หรือเจ้าของตั้งเป็นส่วนตัว</p>';
    return;
  }
  const rel = social.relation(uid);
  const sharedPlans = store.plans.filter((pl) => (pl.memberIds || []).includes(uid) && uid !== state.uid);
  const s = p.stats || {};
  body.innerHTML = `
    <div class="user-hero">
      ${avatar(bigFace(p), 'xl')}
      <h2>${esc(p.name || 'ผู้ใช้')}</h2>
      <span class="role ${p.isPublic ? 'owner' : ''}">${p.hidden ? '🔒 ส่วนตัว' : p.isPublic ? '🌐 สาธารณะ' : '🔒 ส่วนตัว'}</span>
      ${rel === 'friend' ? '<span class="role">เพื่อนของคุณ</span>' : ''}
    </div>
    ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
    ${p.hidden ? '<p class="muted center">โปรไฟล์นี้เป็นส่วนตัว จะเห็นรายละเอียดเมื่อเป็นเพื่อนกันแล้ว</p>' : `
    <div class="stats">
      <div><b>${s.places ?? 0}</b><small>ปักหมุด</small></div>
      <div><b>${s.visited ?? 0}</b><small>ไปแล้ว</small></div>
      <div><b>${s.plans ?? 0}</b><small>แผนเที่ยว</small></div>
    </div>`}
    ${sharedPlans.length ? `<p class="muted small center">เที่ยวด้วยกันใน ${sharedPlans.map((pl) => `“${esc(pl.title)}”`).join(', ')}</p>` : ''}
    <div class="user-actions">${rel === 'me' ? '<button class="btn primary" data-edit-profile>แก้ไขโปรไฟล์</button>' : actionButtons(uid)}</div>
    ${rel === 'none' && p.hidden ? '<p class="muted small center">ส่งคำขอได้เฉพาะโปรไฟล์สาธารณะ</p>' : ''}
    ${rel === 'friend' ? `<h3 class="sec">เพื่อนของ ${esc(p.name || '')}${userFriends ? ` <span class="count">${userFriends.length}</span>` : ''}</h3>
      ${userFriends === undefined ? '<p class="muted pad-s">กำลังโหลด…</p>'
        : userFriends.length ? `<ul class="people">${userFriends.map((f) => personRow(f, social.isFriend(f.uid) ? 'เพื่อนของคุณด้วย' : (f.bio || '').slice(0, 50) && esc(f.bio.slice(0, 50)))).join('')}</ul>`
        : '<p class="muted pad-s">ยังไม่มีเพื่อนที่เป็นโปรไฟล์สาธารณะ</p>'}` : ''}
  `;
}

export function bindUserDialog({ openAccount }) {
  const dlg = $('#dlg-user');
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-edit-profile]')) { dlg.close(); return openAccount(); }
    const btn = e.target.closest('[data-act]');
    if (btn) {
      const row = btn.closest('[data-open]');
      return runAction(btn.dataset.act, btn.dataset.uid, row ? row.querySelector('b')?.textContent : $('#user-body h2')?.textContent);
    }
    const row = e.target.closest('[data-open]'); // a friend of this friend
    if (row) openUser(row.dataset.open);
  });
  social.subscribe(() => {
    if (dlg.open && viewing) {
      const p = viewing === state.uid ? state.me : state.friends.get(viewing) || findDir(viewing);
      if (p) renderUser(viewing, p);
      else renderUser(viewing, { name: $('#user-body h2')?.textContent, hidden: true });
    }
  });
}

/* ----- My profile editor (inside the account dialog) ----- */
let draftPhoto = null; // { photo, thumb } chosen but not yet saved
let draftFields = null; // typed values kept while the form re-renders

export function renderProfileEditor(root, { onSignOut }) {
  const me = { ...(state.me || {}), ...(draftFields || {}) };
  const shown = draftPhoto || { photo: me.photo, thumb: me.thumb };
  root.innerHTML = `
    <form id="form-profile" class="profile-form" autocomplete="off">
      <div class="photo-pick">
        ${avatar({ name: me.name, photo: shown.photo || shown.thumb }, 'xl')}
        <div class="photo-btns">
          <label class="chip file-chip">📷 เปลี่ยนรูป<input type="file" id="profile-photo" accept="image/*" hidden></label>
          ${shown.photo || shown.thumb ? '<button type="button" class="chip" id="btn-photo-remove">ลบรูป</button>' : ''}
          ${state.user?.photoURL && shown.photo !== state.user.photoURL ? '<button type="button" class="chip" id="btn-photo-google">ใช้รูปจาก Google</button>' : ''}
        </div>
      </div>
      <label for="profile-name">ชื่อที่แสดง *</label>
      <input id="profile-name" name="name" required maxlength="60" value="${esc(me.name || '')}">
      <label for="profile-bio">แนะนำตัว</label>
      <textarea id="profile-bio" name="bio" rows="2" maxlength="300" placeholder="ชอบเที่ยวภูเขา ทะเล คาเฟ่…">${esc(me.bio || '')}</textarea>
      <label class="switch-row" for="profile-public">
        <input type="checkbox" id="profile-public" name="isPublic" ${me.isPublic ? 'checked' : ''}>
        <span><b>โปรไฟล์สาธารณะ</b><small>ผู้ใช้อื่นที่ไม่ใช่เพื่อนจะเห็นชื่อ รูป แนะนำตัว และจำนวนที่เที่ยว และส่งคำขอเป็นเพื่อนได้ (สถานที่และแผนยังเป็นส่วนตัว)</small></span>
      </label>
      <p class="muted small">อีเมล ${esc(state.user?.email || '')} ไม่แสดงให้ผู้อื่นเห็น</p>
      <div class="sheet-actions">
        <button type="button" class="btn danger" id="btn-signout">ออกจากระบบ</button>
        <span class="spacer"></span>
        <button type="submit" class="btn primary">บันทึกโปรไฟล์</button>
      </div>
    </form>`;
  const f = $('#form-profile');
  const rerender = () => {
    draftFields = { name: f.name.value, bio: f.bio.value, isPublic: f.isPublic.checked };
    renderProfileEditor(root, { onSignOut });
  };
  $('#profile-photo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      draftPhoto = { photo: await resizeImage(file, 320, 0.8), thumb: await resizeImage(file, 72, 0.75) };
      rerender();
    } catch (err) { toast(err.message); }
  };
  $('#btn-photo-remove')?.addEventListener('click', () => { draftPhoto = { photo: '', thumb: '' }; rerender(); });
  $('#btn-photo-google')?.addEventListener('click', () => {
    draftPhoto = { photo: state.user.photoURL, thumb: state.user.photoURL };
    rerender();
  });
  $('#btn-signout').onclick = onSignOut;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await social.saveProfile({ name, bio: f.bio.value.trim(), isPublic: f.isPublic.checked, ...(draftPhoto || {}) });
      draftPhoto = null;
      draftFields = null;
      toast('บันทึกโปรไฟล์แล้ว');
      $('#dlg-account').close();
    } catch (err) {
      toast(errMsg(err));
    } finally {
      btn.disabled = false;
    }
  };
}
export const resetProfileDraft = () => { draftPhoto = null; draftFields = null; };

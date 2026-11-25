// Firebase: Google sign-in, Firestore sync of places and shared plans, profiles and friends.
//
// Firestore layout
//   users/{uid}/places/{placeId}        private places of one user
//   profiles/{uid}                      name, photo, thumb, bio, isPublic, stats
//   profiles/{uid}/friends/{friendUid}  friendship (both sides get a doc)
//   friendRequests/{from}_{to}          pending friend request
//   plans/{planId}                      ownerId, memberIds[], members{uid: {name, thumb}}, lastAdded,
//                                       title, start, end, color, note, placeIds[], stops[]
// Who may read or write what is enforced by firestore.rules.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const cloudConfigured = Boolean(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const PLAN_CONTENT = ['title', 'start', 'end', 'color', 'note', 'placeIds', 'stops', 'finishedAt', 'outcome'];

/** Profile defaults taken from the Google account. */
export function profileFromUser(user) {
  const name = (user.displayName || (user.email ? user.email.split('@')[0] : 'นักเดินทาง')).slice(0, 60);
  return { name, nameLower: name.toLowerCase(), photo: user.photoURL || '', thumb: user.photoURL || '', bio: '', isPublic: false };
}

/** What a plan shows for one member. */
export const memberSnapshot = (profile) => ({ name: profile?.name || 'สมาชิก', thumb: profile?.thumb || '' });

/* Username accounts: Firebase Email/Password with an internal address (no real email needed). */
const USERNAME_DOMAIN = 'users.wanderpin.app';
export const USERNAME_RE = /^[a-z0-9._]{3,20}$/;
export const normalizeUsername = (u) => (u || '').trim().toLowerCase();
export const isUsernameAccount = (user) => Boolean(user?.email?.endsWith(`@${USERNAME_DOMAIN}`));
export const usernameOf = (user) => (isUsernameAccount(user) ? user.email.split('@')[0] : '');

export const AUTH_ERRORS = {
  'auth/invalid-credential': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  'auth/invalid-login-credentials': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
  'auth/user-not-found': 'ไม่พบชื่อผู้ใช้นี้ ถ้ายังไม่มีบัญชีให้กด “สมัครใหม่”',
  'auth/email-already-in-use': 'ชื่อผู้ใช้นี้มีคนใช้แล้ว ลองชื่ออื่น',
  'auth/weak-password': 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร',
  'auth/too-many-requests': 'ลองหลายครั้งเกินไป รอสักครู่แล้วลองใหม่',
  'auth/requires-recent-login': 'กรุณาออกจากระบบแล้วเข้าใหม่ก่อนเปลี่ยนรหัสผ่าน',
  'auth/popup-closed-by-user': 'ปิดหน้าต่างเข้าสู่ระบบก่อนเสร็จ',
  'auth/cancelled-popup-request': 'ยกเลิกการเข้าสู่ระบบ',
  'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาต เพิ่มโดเมนใน Firebase → Authentication → Settings → Authorized domains',
  'auth/operation-not-allowed': 'ยังไม่ได้เปิดใช้วิธีเข้าสู่ระบบนี้ใน Firebase console (Authentication → Sign-in method)',
  'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้',
};

export async function initCloud() {
  if (!cloudConfigured) return null;
  const [appMod, authMod, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  auth.languageCode = 'th';
  let db;
  try {
    db = fs.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
  }

  // Local testing with the Firebase emulator suite (set useEmulators: true in firebase-config.js).
  if (firebaseConfig.useEmulators) {
    authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    globalThis.__wanderpinTest = { auth, authMod };
  }

  const {
    doc, collection, setDoc, getDoc, getDocs, updateDoc, deleteDoc, onSnapshot, query, where, limit,
    writeBatch, arrayUnion, arrayRemove, deleteField,
  } = fs;
  const now = () => new Date().toISOString();
  const placeRef = (uid, id) => doc(db, 'users', uid, 'places', id);
  const planRef = (id) => doc(db, 'plans', id);
  const profileRef = (uid) => doc(db, 'profiles', uid);
  const cardRef = (uid) => doc(db, 'cards', uid);
  const friendRef = (uid, fid) => doc(db, 'profiles', uid, 'friends', fid);
  const requestRef = (from, to) => doc(db, 'friendRequests', `${from}_${to}`);
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined / functions
  const list = (s) => s.docs.map((d) => ({ ...d.data(), id: d.id }));

  let me = null; // { uid, ...profile } of the signed-in user, kept current by the app

  const redirectError = authMod.getRedirectResult(auth).then(() => null).catch((e) => e);

  return {
    redirectError,
    onAuth: (cb) => authMod.onAuthStateChanged(auth, cb),
    get user() { return auth.currentUser; },
    setMe(profile) { me = profile; },

    async signIn() {
      const provider = new authMod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        return await authMod.signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          return authMod.signInWithRedirect(auth, provider);
        }
        throw e;
      }
    },
    signOut: () => authMod.signOut(auth),

    /* ----- username + password ----- */
    signInWithUsername(username, password) {
      return authMod.signInWithEmailAndPassword(auth, `${normalizeUsername(username)}@${USERNAME_DOMAIN}`, password);
    },
    async signUpWithUsername(username, password) {
      const u = normalizeUsername(username);
      const cred = await authMod.createUserWithEmailAndPassword(auth, `${u}@${USERNAME_DOMAIN}`, password);
      await authMod.updateProfile(cred.user, { displayName: u }).catch(() => {});
      return cred;
    },
    async changePassword(current, next) {
      const user = auth.currentUser;
      await authMod.reauthenticateWithCredential(user, authMod.EmailAuthProvider.credential(user.email, current));
      await authMod.updatePassword(user, next);
    },

    /* ----- live data ----- */
    watch(uid, h) {
      const subs = [
        onSnapshot(collection(db, 'users', uid, 'places'), (s) => h.onPlaces(list(s)), h.onError),
        onSnapshot(query(collection(db, 'plans'), where('memberIds', 'array-contains', uid)), { includeMetadataChanges: true }, (s) => h.onPlans(list(s), s.metadata.fromCache), h.onError),
        onSnapshot(profileRef(uid), { includeMetadataChanges: true }, (s) => h.onProfile(s.exists() ? { ...s.data(), uid } : null, s.metadata.fromCache), h.onError),
        onSnapshot(collection(db, 'profiles', uid, 'friends'), (s) => h.onFriendIds(s.docs.map((d) => d.id)), h.onError),
        onSnapshot(query(collection(db, 'friendRequests'), where('to', '==', uid)), (s) => h.onIncoming(list(s)), h.onError),
        onSnapshot(query(collection(db, 'friendRequests'), where('from', '==', uid)), (s) => h.onOutgoing(list(s)), h.onError),
        onSnapshot(query(collection(db, 'calls'), where('to', '==', uid)), (s) => h.onCalls?.(list(s)), h.onError),
      ];
      return () => subs.forEach((u) => u());
    },
    /** Live profile of one user (friends, or anyone public). Calls back with null if hidden. */
    watchProfile(uid, cb) {
      return onSnapshot(profileRef(uid), (s) => cb(s.exists() ? { ...s.data(), uid } : null), () => cb(null));
    },
    async getProfile(uid) {
      try { const s = await getDoc(profileRef(uid)); return s.exists() ? { ...s.data(), uid } : null; } catch { return null; }
    },
    /** Friend IDs of one of my friends (allowed by the rules only for friends). */
    async friendIdsOf(uid) {
      const s = await getDocs(collection(db, 'profiles', uid, 'friends'));
      return s.docs.map((d) => d.id);
    },
    async publicProfiles() {
      const s = await getDocs(query(collection(db, 'profiles'), where('isPublic', '==', true), limit(300)));
      return s.docs.map((d) => ({ ...d.data(), uid: d.id }));
    },

    /* ----- profile ----- */
    saveProfile(uid, profile) {
      const data = { ...profile, nameLower: profile.name.toLowerCase(), updatedAt: now() };
      ['uid', 'hidden', 'cardOnly'].forEach((k) => delete data[k]);
      const b = writeBatch(db);
      b.set(profileRef(uid), clean(data), { merge: true });
      b.set(cardRef(uid), { name: profile.name, thumb: profile.thumb || '', updatedAt: now() });
      return b.commit();
    },
    /** Name + small photo, readable by every signed-in user (see firestore.rules). */
    saveCard: (uid, profile) => setDoc(cardRef(uid), { name: profile.name, thumb: profile.thumb || '', updatedAt: now() }),
    async getCard(uid) {
      try { const s = await getDoc(cardRef(uid)); return s.exists() ? { ...s.data(), uid } : null; } catch { return null; }
    },
    /** Refresh my name/photo in every plan I'm in. */
    async syncMemberSnapshot(uid, plans, profile) {
      const snap = memberSnapshot(profile);
      await Promise.all(plans
        .filter((pl) => JSON.stringify(pl.members?.[uid] || {}) !== JSON.stringify(snap))
        .map((pl) => updateDoc(planRef(pl.id), { [`members.${uid}`]: snap })));
    },

    /* ----- friends ----- */
    /* ----- calls ----- */
    ringFriend(uid, to, room) {
      return setDoc(doc(db, 'calls', `${uid}_${to}`), { from: uid, to, fromName: me?.name || 'เพื่อน', fromThumb: me?.thumb || '', room, at: now() });
    },
    endCall: (id) => deleteDoc(doc(db, 'calls', id)),
    startPlanCall(planId, uid) {
      return updateDoc(planRef(planId), { call: { by: uid, name: me?.name || 'เพื่อน', thumb: me?.thumb || '', at: now() }, updatedAt: now() });
    },

    sendRequest(uid, to) {
      return setDoc(requestRef(uid, to), { from: uid, to, fromName: me?.name || 'ผู้ใช้', fromThumb: me?.thumb || '', createdAt: now() });
    },
    cancelRequest: (from, to) => deleteDoc(requestRef(from, to)),
    async acceptRequest(uid, from, alsoSentByMe) {
      const b = writeBatch(db);
      const since = now();
      b.set(friendRef(uid, from), { since });
      b.set(friendRef(from, uid), { since });
      b.delete(requestRef(from, uid));
      if (alsoSentByMe) b.delete(requestRef(uid, from));
      await b.commit();
    },
    async unfriend(uid, fid) {
      const b = writeBatch(db);
      b.delete(friendRef(uid, fid));
      b.delete(friendRef(fid, uid));
      await b.commit();
    },

    /* ----- places & plans ----- */
    savePlace: (uid, place) => setDoc(placeRef(uid, place.id), clean(place)),
    deletePlace: (uid, id) => deleteDoc(placeRef(uid, id)),

    createPlan(user, plan) {
      return setDoc(planRef(plan.id), clean({
        ...plan,
        ownerId: user.uid,
        memberIds: [user.uid],
        members: { [user.uid]: memberSnapshot(me) },
      }));
    },
    updatePlanContent(plan) {
      const data = { updatedAt: now() };
      PLAN_CONTENT.forEach((k) => { if (k in plan) data[k] = plan[k] ?? null; });
      return updateDoc(planRef(plan.id), clean(data));
    },
    deletePlan: (id) => deleteDoc(planRef(id)),
    addMember: (planId, uid, profile) =>
      updateDoc(planRef(planId), { memberIds: arrayUnion(uid), lastAdded: uid, [`members.${uid}`]: memberSnapshot(profile), updatedAt: now() }),
    removeMember: (planId, uid) => updateDoc(planRef(planId), { memberIds: arrayRemove(uid), [`members.${uid}`]: deleteField(), updatedAt: now() }),
    leavePlan: (planId, uid) => updateDoc(planRef(planId), { memberIds: arrayRemove(uid), [`members.${uid}`]: deleteField() }),

    /** Upload guest (local) data the first time someone signs in on this device. */
    async uploadLocal(user, { places, plans }) {
      const ops = [
        ...places.map((p) => (b) => b.set(placeRef(user.uid, p.id), clean(p))),
        ...plans.map((pl) => (b) => b.set(planRef(pl.id), clean({
          ...pl, ownerId: user.uid, memberIds: [user.uid], members: { [user.uid]: memberSnapshot(me) },
        }))),
      ];
      for (let i = 0; i < ops.length; i += 400) {
        const b = writeBatch(db);
        ops.slice(i, i + 400).forEach((op) => op(b));
        await b.commit();
      }
    },
  };
}

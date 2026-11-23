// Firebase sign-in (Google / Facebook) and Firestore sync for places and shared plans.
//
// Firestore layout
//   users/{uid}/places/{placeId}   private places of one user
//   plans/{planId}                 a trip plan shared by its members
//     ownerId, memberIds[], members{uid: {name, email, photo}}, pendingEmails[]
//     title, start, end, color, note, placeIds[], stops[] (snapshot of places, so companions can see them)
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const cloudConfigured = Boolean(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const PLAN_CONTENT = ['title', 'start', 'end', 'color', 'note', 'placeIds', 'stops'];

export const lowerEmail = (e) => (e || '').trim().toLowerCase();

export function profileOf(user) {
  return {
    name: user.displayName || (user.email ? user.email.split('@')[0] : 'ผู้ใช้'),
    email: lowerEmail(user.email),
    photo: user.photoURL || '',
  };
}

export const AUTH_ERRORS = {
  'auth/popup-closed-by-user': 'ปิดหน้าต่างเข้าสู่ระบบก่อนเสร็จ',
  'auth/cancelled-popup-request': 'ยกเลิกการเข้าสู่ระบบ',
  'auth/account-exists-with-different-credential': 'อีเมลนี้เคยเข้าระบบด้วยวิธีอื่น ลองเข้าด้วย Google หรือ Facebook อีกแบบ',
  'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาต เพิ่มโดเมนใน Firebase → Authentication → Settings → Authorized domains',
  'auth/operation-not-allowed': 'ยังไม่ได้เปิดใช้วิธีเข้าสู่ระบบนี้ใน Firebase console',
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

  const { doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, arrayUnion, arrayRemove, deleteField } = fs;
  const now = () => new Date().toISOString();
  const placeRef = (uid, id) => doc(db, 'users', uid, 'places', id);
  const planRef = (id) => doc(db, 'plans', id);
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined / functions

  // Surface errors from a redirect sign-in (used when popups are unavailable).
  const redirectError = authMod.getRedirectResult(auth).then(() => null).catch((e) => e);

  return {
    redirectError,
    onAuth: (cb) => authMod.onAuthStateChanged(auth, cb),
    get user() { return auth.currentUser; },

    async signIn(kind) {
      const provider = kind === 'facebook' ? new authMod.FacebookAuthProvider() : new authMod.GoogleAuthProvider();
      provider.addScope('email');
      if (kind === 'google') provider.setCustomParameters({ prompt: 'select_account' });
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

    /** Live data for the signed-in user. Also auto-joins plans this user was invited to by email. */
    watch(user, { onPlaces, onPlans, onError, onJoined }) {
      const me = profileOf(user);
      const unsubs = [];
      unsubs.push(onSnapshot(collection(db, 'users', user.uid, 'places'),
        (s) => onPlaces(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError));
      unsubs.push(onSnapshot(query(collection(db, 'plans'), where('memberIds', 'array-contains', user.uid)),
        (s) => onPlans(s.docs.map((d) => ({ ...d.data(), id: d.id }))), onError));
      if (me.email) {
        unsubs.push(onSnapshot(query(collection(db, 'plans'), where('pendingEmails', 'array-contains', me.email)),
          (s) => s.docs.forEach((d) => {
            updateDoc(d.ref, {
              memberIds: arrayUnion(user.uid),
              [`members.${user.uid}`]: me,
              pendingEmails: arrayRemove(me.email),
            }).then(() => onJoined?.(d.data().title)).catch((e) => console.warn('join failed', e));
          }), onError));
      }
      return () => unsubs.forEach((u) => u());
    },

    savePlace: (uid, place) => setDoc(placeRef(uid, place.id), clean(place)),
    deletePlace: (uid, id) => deleteDoc(placeRef(uid, id)),

    createPlan(user, plan) {
      return setDoc(planRef(plan.id), clean({
        ...plan,
        ownerId: user.uid,
        memberIds: [user.uid],
        members: { [user.uid]: profileOf(user) },
        pendingEmails: [],
      }));
    },
    updatePlanContent(plan) {
      const data = { updatedAt: now() };
      PLAN_CONTENT.forEach((k) => { if (k in plan) data[k] = plan[k] ?? null; });
      return updateDoc(planRef(plan.id), clean(data));
    },
    deletePlan: (id) => deleteDoc(planRef(id)),

    invite: (planId, email) => updateDoc(planRef(planId), { pendingEmails: arrayUnion(lowerEmail(email)), updatedAt: now() }),
    cancelInvite: (planId, email) => updateDoc(planRef(planId), { pendingEmails: arrayRemove(lowerEmail(email)), updatedAt: now() }),
    removeMember: (planId, uid) => updateDoc(planRef(planId), { memberIds: arrayRemove(uid), [`members.${uid}`]: deleteField(), updatedAt: now() }),
    leavePlan: (planId, uid) => updateDoc(planRef(planId), { memberIds: arrayRemove(uid), [`members.${uid}`]: deleteField() }),

    /** Upload guest (local) data the first time someone signs in on this device. */
    async uploadLocal(user, { places, plans }) {
      const ops = [
        ...places.map((p) => (b) => b.set(placeRef(user.uid, p.id), clean(p))),
        ...plans.map((pl) => (b) => b.set(planRef(pl.id), clean({
          ...pl, ownerId: user.uid, memberIds: [user.uid], members: { [user.uid]: profileOf(user) }, pendingEmails: [],
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

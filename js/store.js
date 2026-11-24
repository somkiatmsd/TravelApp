// Data store. Guest mode keeps data in localStorage; after sign-in it mirrors Firestore
// (updates are applied locally first, then written to the cloud; snapshots reconcile).
const KEY = 'wanderpin:v1';

const empty = () => ({ places: [], plans: [] });

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    return {
      places: Array.isArray(data.places) ? data.places : [],
      plans: Array.isArray(data.plans) ? data.plans : [],
    };
  } catch {
    return empty();
  }
}

let state = loadLocal();
let cloud = null; // { api, user }
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(state));
const report = (p) => p?.catch?.((e) => store.onError?.(e));

function persist() {
  if (!cloud) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.error('Save failed', e); }
  }
  notify();
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const upsert = (list, item) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

export const store = {
  onError: null,
  get places() { return state.places; },
  get plans() { return state.plans; },
  get user() { return cloud?.user || null; },
  get isCloud() { return Boolean(cloud); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  getPlace(id) { return state.places.find((p) => p.id === id); },
  getPlan(id) { return state.plans.find((p) => p.id === id); },
  isOwner(plan) { return !cloud || plan.ownerId === cloud.user.uid; },

  /* mode switching */
  useCloud(api, user) {
    cloud = { api, user };
    state = empty();
    notify();
  },
  useLocal() {
    cloud = null;
    state = loadLocal();
    notify();
  },
  setPlaces(places) { if (cloud) { state = { ...state, places }; notify(); } },
  setPlans(plans) { if (cloud) { state = { ...state, plans }; notify(); } },

  /* places */
  savePlace(place) {
    const now = new Date().toISOString();
    const existing = place.id && this.getPlace(place.id);
    const item = existing ? { ...existing, ...place, updatedAt: now } : { ...place, id: uid(), createdAt: now, updatedAt: now };
    state = { ...state, places: upsert(state.places, item) };
    if (cloud) report(cloud.api.savePlace(cloud.user.uid, item));
    persist();
    return item;
  },

  deletePlace(id) {
    state = { ...state, places: state.places.filter((p) => p.id !== id) };
    const touched = [];
    state.plans = state.plans.map((pl) => {
      if (!pl.placeIds.includes(id)) return pl;
      const next = { ...pl, placeIds: pl.placeIds.filter((x) => x !== id), stops: (pl.stops || []).filter((s) => s.id !== id) };
      touched.push(next);
      return next;
    });
    if (cloud) {
      report(cloud.api.deletePlace(cloud.user.uid, id));
      touched.forEach((pl) => report(cloud.api.updatePlanContent(pl)));
    }
    persist();
  },

  /* plans */
  savePlan(plan) {
    const now = new Date().toISOString();
    const existing = plan.id && this.getPlan(plan.id);
    if (existing) {
      const item = { ...existing, ...plan, updatedAt: now };
      state = { ...state, plans: upsert(state.plans, item) };
      if (cloud) report(cloud.api.updatePlanContent(item));
      persist();
      return item;
    }
    let item = { ...plan, id: uid(), createdAt: now, updatedAt: now };
    if (cloud) {
      const { user } = cloud;
      item = { ...item, ownerId: user.uid, memberIds: [user.uid], members: {} };
      report(cloud.api.createPlan(user, item));
    }
    state = { ...state, plans: [...state.plans, item] };
    persist();
    return item;
  },

  deletePlan(id) {
    const pl = this.getPlan(id);
    state = { ...state, plans: state.plans.filter((p) => p.id !== id) };
    if (cloud && pl) {
      report(this.isOwner(pl) ? cloud.api.deletePlan(id) : cloud.api.leavePlan(id, cloud.user.uid));
    }
    persist();
  },

  /* companions (cloud only) */
  addMember(planId, friendUid, profile) { return cloud.api.addMember(planId, friendUid, profile); },
  removeMember(planId, memberUid) { return cloud.api.removeMember(planId, memberUid); },

  /* backup */
  exportJSON() {
    const plans = state.plans.map(({ memberIds, members, pendingEmails, ownerId, lastAdded, ...rest }) => rest);
    return JSON.stringify({ app: 'wanderpin', version: 1, exportedAt: new Date().toISOString(), places: state.places, plans }, null, 2);
  },

  importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.places)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
    const places = data.places.filter((p) => p && p.id && p.name);
    const plans = (data.plans || []).filter((p) => p && p.id && p.title).map((p) => ({ placeIds: [], ...p }));
    if (cloud) {
      places.forEach((p) => { state = { ...state, places: upsert(state.places, p) }; report(cloud.api.savePlace(cloud.user.uid, p)); });
      plans.forEach((p) => {
        const existing = this.getPlan(p.id);
        if (existing) { if (this.isOwner(existing)) report(cloud.api.updatePlanContent(p)); }
        else report(cloud.api.createPlan(cloud.user, p));
      });
      notify();
    } else {
      let ps = state.places, pls = state.plans;
      places.forEach((p) => { ps = upsert(ps, p); });
      plans.forEach((p) => { pls = upsert(pls, p); });
      state = { places: ps, plans: pls };
      persist();
    }
    return { places: places.length, plans: plans.length };
  },

  clear() {
    if (cloud) {
      state.places.forEach((p) => report(cloud.api.deletePlace(cloud.user.uid, p.id)));
      state.plans.forEach((pl) => report(this.isOwner(pl) ? cloud.api.deletePlan(pl.id) : cloud.api.leavePlan(pl.id, cloud.user.uid)));
      state = empty();
      notify();
    } else {
      state = empty();
      persist();
    }
  },
};

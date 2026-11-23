// Local data store (localStorage) with change subscriptions.
const KEY = 'wanderpin:v1';

const empty = () => ({ places: [], plans: [] });

function load() {
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

let state = load();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Save failed', e);
  }
  listeners.forEach((fn) => fn(state));
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const store = {
  get places() { return state.places; },
  get plans() { return state.plans; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  getPlace(id) { return state.places.find((p) => p.id === id); },
  getPlan(id) { return state.plans.find((p) => p.id === id); },

  savePlace(place) {
    const now = new Date().toISOString();
    if (place.id && this.getPlace(place.id)) {
      state.places = state.places.map((p) => (p.id === place.id ? { ...p, ...place, updatedAt: now } : p));
    } else {
      place = { ...place, id: uid(), createdAt: now, updatedAt: now };
      state.places = [...state.places, place];
    }
    persist();
    return place;
  },

  deletePlace(id) {
    state.places = state.places.filter((p) => p.id !== id);
    state.plans = state.plans.map((pl) => ({ ...pl, placeIds: pl.placeIds.filter((x) => x !== id) }));
    persist();
  },

  savePlan(plan) {
    const now = new Date().toISOString();
    if (plan.id && this.getPlan(plan.id)) {
      state.plans = state.plans.map((p) => (p.id === plan.id ? { ...p, ...plan, updatedAt: now } : p));
    } else {
      plan = { ...plan, id: uid(), createdAt: now, updatedAt: now };
      state.plans = [...state.plans, plan];
    }
    persist();
    return plan;
  },

  deletePlan(id) {
    state.plans = state.plans.filter((p) => p.id !== id);
    persist();
  },

  exportJSON() {
    return JSON.stringify({ app: 'wanderpin', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
  },

  importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.places)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
    const byId = new Map(state.places.map((p) => [p.id, p]));
    data.places.forEach((p) => p && p.id && p.name && byId.set(p.id, p));
    const plansById = new Map(state.plans.map((p) => [p.id, p]));
    (data.plans || []).forEach((p) => p && p.id && p.title && plansById.set(p.id, { placeIds: [], ...p }));
    state = { places: [...byId.values()], plans: [...plansById.values()] };
    persist();
    return { places: data.places.length, plans: (data.plans || []).length };
  },

  clear() {
    state = empty();
    persist();
  },
};

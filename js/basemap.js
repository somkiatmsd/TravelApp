// Base map: Google map imagery (Map Tiles API) when the API key allows it,
// otherwise — or when offline — OpenStreetMap (whose tiles the service worker keeps for offline use).
import { googleMapsApiKey } from './maps-config.js';

const TILE_API = 'https://tile.googleapis.com';
const GOOGLE_LOGO = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5.png';
const SESSION_KEY = 'wanderpin:gtiles:';

async function getSession(type) {
  // Sessions last about two weeks; reuse one from this device while it is valid.
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY + type) || 'null');
    if (saved && saved.expiry * 1000 > Date.now() + 3600e3) return saved.session;
  } catch {}
  const body = { mapType: type, language: 'th-TH', region: 'TH', scale: 'scaleFactor2x', highDpi: true };
  if (type === 'satellite') body.layerTypes = ['layerRoadmap']; // satellite with road & place labels
  const r = await fetch(`${TILE_API}/v1/createSession?key=${encodeURIComponent(googleMapsApiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Map Tiles API ${r.status}`);
  const j = await r.json();
  try { localStorage.setItem(SESSION_KEY + type, JSON.stringify({ session: j.session, expiry: +j.expiry })); } catch {}
  return j.session;
}

/** Adds the base map to a Leaflet map. Returns { provider } ('google' | 'osm'). */
export function setupBasemap(map) {
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
  osm.addTo(map);
  const state = { provider: 'osm', type: 'roadmap', layers: {}, copyright: '' };
  if (!googleMapsApiKey) return state;

  let current = null;
  let creditTimer = null;
  const credit = () => `<img src="${GOOGLE_LOGO}" alt="Google" class="g-logo"> ${state.copyright || 'Map data ©Google'}`;

  async function refreshCredit() {
    if (state.provider !== 'google') return;
    const b = map.getBounds();
    const s = state.layers[state.type]?.session;
    if (!s) return;
    const q = new URLSearchParams({ session: s, key: googleMapsApiKey, zoom: map.getZoom(),
      north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
    try {
      const r = await fetch(`${TILE_API}/tile/v1/viewport?${q}`);
      if (r.ok) {
        const j = await r.json();
        const old = credit();
        state.copyright = j.copyright || '';
        map.attributionControl.removeAttribution(old).addAttribution(credit());
      }
    } catch {}
  }

  async function useGoogle(type) {
    let entry = state.layers[type];
    if (!entry) {
      const session = await getSession(type);
      const layer = L.tileLayer(`${TILE_API}/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${encodeURIComponent(googleMapsApiKey)}`, {
        maxZoom: 21, tileSize: 256, attribution: '',
      });
      entry = state.layers[type] = { layer, session };
    }
    if (current && current !== entry.layer) map.removeLayer(current);
    if (!map.hasLayer(entry.layer)) entry.layer.addTo(map);
    current = entry.layer;
    if (map.hasLayer(osm)) map.removeLayer(osm);
    if (state.provider !== 'google') map.attributionControl.addAttribution(credit());
    state.provider = 'google';
    state.type = type;
    document.body.dataset.basemap = type;
    refreshCredit();
  }

  function useOsm() {
    if (current) map.removeLayer(current);
    current = null;
    if (!map.hasLayer(osm)) osm.addTo(map);
    if (state.provider === 'google') map.attributionControl.removeAttribution(credit());
    state.provider = 'osm';
    document.body.dataset.basemap = 'osm';
  }

  // Map / satellite switch (shown only when Google imagery works).
  const Switch = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'basemap-switch');
      btn.type = 'button';
      btn.title = 'สลับแผนที่ / ดาวเทียม';
      const label = () => { btn.innerHTML = state.type === 'satellite' ? '🗺️<span>แผนที่</span>' : '🛰️<span>ดาวเทียม</span>'; };
      label();
      L.DomEvent.disableClickPropagation(btn);
      btn.onclick = () => {
        useGoogle(state.type === 'satellite' ? 'roadmap' : 'satellite').then(label).catch(() => {});
      };
      return btn;
    },
  });
  const sw = new Switch();

  const start = () => useGoogle(state.type).then(() => { if (!sw._map) sw.addTo(map); }).catch((e) => console.info('Google map tiles unavailable, using OpenStreetMap:', e.message));
  if (navigator.onLine) start();
  window.addEventListener('offline', () => { if (state.provider === 'google') { useOsm(); sw.remove(); } });
  window.addEventListener('online', start);
  map.on('moveend', () => { clearTimeout(creditTimer); creditTimer = setTimeout(refreshCredit, 700); });
  return state;
}

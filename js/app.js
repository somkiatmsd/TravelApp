import { store, loadLocal } from './store.js';
import { initCloud, cloudConfigured, AUTH_ERRORS, USERNAME_RE, normalizeUsername } from './cloud.js';
import { $, $$, esc, toast, avatar } from './ui.js';
import { searchPlaces, googleSearchEnabled, directionsUrl, googleMapsUrl } from './search.js';
import { setupBasemap } from './basemap.js';
import { roomUrl, planRoom, showBanner, hideBanner, hasBanner, minutesSince, agoText, RING_MINUTES, LIVE_MINUTES } from './calls.js';
import { social, renderFriendsView, bindFriendsView, bindUserDialog, openUser, renderProfileEditor, resetProfileDraft } from './social.js';

/* ---------- helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: '2-digit' }) =>
  s ? parseYmd(s).toLocaleDateString('th-TH', opts) : '';
const fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a, { day: 'numeric', month: 'short' })} – ${fmtDate(b)}`);

const CAT_ICON = {
  'ธรรมชาติ': '🌿', 'ทะเล': '🏖️', 'ภูเขา': '⛰️', 'คาเฟ่': '☕', 'ร้านอาหาร': '🍜',
  'วัด/ศาสนสถาน': '🛕', 'พิพิธภัณฑ์': '🏛️', 'ช้อปปิ้ง': '🛍️', 'ที่พัก': '🏨', 'อื่นๆ': '📍',
};
const icon = (cat) => CAT_ICON[cat] || '📍';
const PLAN_COLORS = ['#0d9488', '#6366f1', '#e11d48', '#f59e0b', '#0ea5e9', '#a855f7', '#84cc16', '#64748b'];

/** Places of a plan, in order. Own places are live; a companion's places come from the plan's snapshot. */
const planPlaces = (pl) =>
  pl.placeIds.map((id) => store.getPlace(id) || (pl.stops || []).find((s) => s.id === id)).filter(Boolean);
const stopOf = (p) => ({ id: p.id, name: p.name, category: p.category, status: p.status, visitedAt: p.visitedAt ?? null, lat: p.lat ?? null, lng: p.lng ?? null, gmapsId: p.gmapsId || null });


/* ---------- routing / tabs ---------- */
let current = 'map';
function go(view) {
  if (!['map', 'list', 'calendar', 'plans', 'friends'].includes(view)) view = 'map';
  if (current === 'plans' && view !== 'plans' && freshPlans.size) { freshPlans.clear(); renderPlans(); }
  current = view;
  document.body.dataset.view = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.go === view));
  if (view === 'map') setTimeout(() => map.invalidateSize(), 0);
  if (view === 'calendar') renderCalendar();
  if (view === 'friends') { renderFriendsView(); social.loadDirectory().then(() => social.loadFriendsOfFriends()); }
  if (view === 'plans' && store.isCloud) markPlansSeen();
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.go)));

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false }).setView([13.7563, 100.5018], 6);
L.control.zoom({ position: 'topright' }).addTo(map);
setupBasemap(map); // Google map imagery when available, OpenStreetMap otherwise / offline

const markersLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerById = new Map();
let tempMarker = null;
let picking = false;

const pinIcon = (cls, label = '') =>
  L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${esc(label)}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

// Keep pin popups clear of the search box (top) and the legend / buttons (bottom).
const POPUP_OPTS = { maxWidth: 300, minWidth: 240, autoPanPaddingTopLeft: [12, 96], autoPanPaddingBottomRight: [12, 70] };

function placePopup(p) {
  const div = document.createElement('div');
  div.className = 'popup';
  const own = Boolean(store.getPlace(p.id));
  div.innerHTML = `
    <h4>${icon(p.category)} ${esc(p.name)}</h4>
    <p>${esc(p.category)} · ${p.status === 'visited' ? `ไปแล้ว${p.visitedAt ? ' ' + fmtDate(p.visitedAt) : ''}` : 'ยังไม่ได้ไป'}${own ? '' : ' · ของเพื่อนร่วมทาง'}</p>
    <div class="row">
      ${own ? `<button class="chip" data-a="edit">แก้ไข</button>
      <button class="chip primary" data-a="toggle">${p.status === 'visited' ? 'ยังไม่ได้ไป' : '✓ ไปแล้ว'}</button>` : ''}
      <a class="chip" href="${directionsUrl(p)}" target="_blank" rel="noopener">นำทาง</a>
      <a class="chip" href="${googleMapsUrl(p)}" target="_blank" rel="noopener">Google Maps</a>
    </div>
    ${popupPlans(p)}`;
  div.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'edit') { map.closePopup(); openPlaceForm(p.id); }
    if (a === 'toggle') { toggleVisited(p.id); }
    // Hide (not remove) the button: a removed click target would look like a tap on the map and close the popup.
    if (a === 'show-add') { div.querySelector('.add-to-plan').hidden = false; e.target.closest('button').hidden = true; }
    if (a === 'add-to-plan') {
      const pl = store.getPlan(e.target.closest('[data-plan]').dataset.plan);
      addPlaceToPlan(pl, p);
      map.closePopup();
      toast(`เพิ่ม “${p.name}” เข้าแผน “${pl.title}” แล้ว`);
    }
    if (a === 'new-plan') { map.closePopup(); openPlanForm(null, { placeIds: [p.id], stops: own ? [] : [stopOf(p)] }); }
    if (a === 'open-plan') { map.closePopup(); focusPlan(e.target.closest('[data-plan]').dataset.plan); }
  });
  return div;
}

/** Plans that include this place, plus "create a plan from here". */
function popupPlans(p) {
  const plans = store.plans
    .filter((pl) => (pl.placeIds || []).includes(p.id))
    .sort((a, b) => (isClosed(a) - isClosed(b)) || a.start.localeCompare(b.start));
  return `<div class="popup-plans">
    <div class="popup-plans-head">แผนที่มีที่นี่ ${plans.length ? `<span class="count">${plans.length}</span>` : ''}</div>
    ${plans.length ? `<ul>${plans.map((pl) => `<li><button class="popup-plan" data-a="open-plan" data-plan="${esc(pl.id)}">
        <i style="background:${esc(pl.color || '#0d9488')}"></i>
        <span class="pp-title">${esc(pl.title)}</span>
        <small>${isCancelled(pl) ? '❌ ทริปล่ม' : isClosed(pl) ? '🏁 จบแล้ว' : fmtRange(pl.start, pl.end)}</small>
      </button></li>`).join('')}</ul>` : '<p>ยังไม่อยู่ในแผนไหน</p>'}
    <div class="row">
      ${addable(p).length ? '<button class="chip" data-a="show-add">+ เพิ่มเข้าแผน</button>' : ''}
      <button class="chip primary" data-a="new-plan">+ สร้างแผนใหม่</button>
    </div>
    ${addable(p).length ? `<ul class="add-to-plan" hidden>${addable(p).map((pl) => `<li><button class="popup-plan" data-a="add-to-plan" data-plan="${esc(pl.id)}">
        <i style="background:${esc(pl.color || '#0d9488')}"></i>
        <span class="pp-title">${esc(pl.title)}</span>
        <small>+ เพิ่ม</small>
      </button></li>`).join('')}</ul>` : ''}
  </div>`;
}

/** Open plans this place could be added to. */
const addable = (p) => store.plans
  .filter((pl) => !isClosed(pl) && !(pl.placeIds || []).includes(p.id))
  .sort((a, b) => a.start.localeCompare(b.start));

/** Append a place to a plan (keeps the plan's snapshot of places in step). */
function addPlaceToPlan(pl, place) {
  if ((pl.placeIds || []).includes(place.id)) return;
  const placeIds = [...(pl.placeIds || []), place.id];
  const stops = [...(pl.stops || []).filter((s) => s.id !== place.id), stopOf(place)];
  store.savePlan({ id: pl.id, placeIds, stops });
}

/** Go to the Plans tab and bring one plan into view. */
function focusPlan(id) {
  expandedPlans.add(id);
  go('plans');
  renderPlans();
  requestAnimationFrame(() => {
    const card = document.querySelector(`#plan-list li[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1600);
  });
}

function renderMarkers() {
  markersLayer.clearLayers();
  markerById.clear();
  store.places.forEach((p) => {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p.status === 'visited' ? 'visited' : 'want'), title: p.name })
      .bindPopup(() => placePopup(store.getPlace(p.id)), POPUP_OPTS)
      .addTo(markersLayer);
    markerById.set(p.id, m);
  });
}

function fitAll() {
  const pts = store.places.filter((p) => typeof p.lat === 'number').map((p) => [p.lat, p.lng]);
  if (pts.length === 1) map.setView(pts[0], 12);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [50, 50], maxZoom: 13 });
}

function focusPlace(id) {
  const p = store.getPlace(id);
  if (!p || typeof p.lat !== 'number') { toast('สถานที่นี้ยังไม่มีพิกัด'); return; }
  go('map');
  routeLayer.clearLayers();
  setTimeout(() => {
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14));
    markerById.get(id)?.openPopup();
  }, 50);
}

function clearTemp() { if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; } }

map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  if (picking) {
    picking = false;
    document.body.classList.remove('picking');
    $('.map-hint').textContent = 'แตะบนแผนที่เพื่อปักหมุด';
    setCoords(lat, lng);
    formPlace.dataset.gmapsId = '';
    clearTemp();
    tempMarker = L.marker([lat, lng], { icon: pinIcon('temp') }).addTo(map);
    $('#dlg-place').showModal();
    return;
  }
  clearTemp();
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `<h4>ปักหมุดที่นี่?</h4><p>${lat.toFixed(5)}, ${lng.toFixed(5)}</p>
    <div class="row"><button class="chip primary" data-a="add">+ เพิ่มสถานที่</button></div>`;
  div.querySelector('[data-a=add]').addEventListener('click', async () => {
    map.closePopup();
    openPlaceForm(null, { lat, lng });
    const name = await reverseGeocode(lat, lng);
    const input = $('#form-place [name=name]');
    if (name && !input.value) input.value = name;
  });
  tempMarker = L.marker([lat, lng], { icon: pinIcon('temp') }).addTo(map).bindPopup(div).openPopup();
  tempMarker.on('popupclose', () => setTimeout(() => { if (!$('#dlg-place').open) clearTemp(); }, 0));
});

$('#btn-locate').addEventListener('click', () => {
  getPosition().then(({ lat, lng }) => {
    map.setView([lat, lng], 14);
    L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(routeLayer);
  }).catch(() => toast('ไม่สามารถระบุตำแหน่งได้'));
});

function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no geo'));
    navigator.geolocation.getCurrentPosition(
      (pos) => res({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      rej, { enableHighAccuracy: true, timeout: 10000 });
  });
}

/* search: Google Places when configured, otherwise OpenStreetMap (see search.js) */
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=th&lat=${lat}&lon=${lng}`);
    if (!r.ok) return '';
    const j = await r.json();
    return j.name || (j.display_name || '').split(',')[0] || '';
  } catch { return ''; }
}

const results = $('#search-results');
if (googleSearchEnabled) $('#search-input').placeholder = 'ค้นหาสถานที่ ร้าน คาเฟ่ ด้วย Google…';
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  $('#search-input').blur();
  results.hidden = false;
  results.innerHTML = '<li>กำลังค้นหา…</li>';
  try {
    const c = map.getCenter();
    const { source, items } = await searchPlaces(q, { lat: c.lat, lng: c.lng });
    const credit = `<li class="credit">${source === 'google' ? 'ผลการค้นหาโดย Google' : 'ผลการค้นหาจาก OpenStreetMap'}</li>`;
    if (!items.length) { results.innerHTML = '<li>ไม่พบสถานที่ ลองพิมพ์ชื่อให้ละเอียดขึ้น เช่น ใส่ชื่อจังหวัด</li>' + credit; return; }
    results.innerHTML = items.map((it, i) =>
      `<li tabindex="0" data-i="${i}">${it.category ? icon(it.category) + ' ' : ''}${esc(it.name)}<small>${esc(it.address)}</small></li>`).join('') + credit;
    results.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      const it = items[+li.dataset.i];
      results.hidden = true;
      map.setView([it.lat, it.lng], 16);
      clearTemp();
      const div = document.createElement('div');
      div.className = 'popup';
      div.innerHTML = `<h4>${it.category ? icon(it.category) + ' ' : ''}${esc(it.name)}</h4><p>${esc(it.address)}</p>
        <div class="row"><button class="chip primary">+ เพิ่มสถานที่</button>
        <a class="chip" href="${googleMapsUrl(it)}" target="_blank" rel="noopener">Google Maps</a></div>`;
      div.querySelector('button').addEventListener('click', () => {
        map.closePopup();
        openPlaceForm(null, it);
      });
      tempMarker = L.marker([it.lat, it.lng], { icon: pinIcon('temp') }).addTo(map).bindPopup(div).openPopup();
    };
  } catch {
    results.innerHTML = '<li>ค้นหาไม่สำเร็จ (ต้องเชื่อมต่ออินเทอร์เน็ต)</li>';
  }
});
$('#search-input').addEventListener('input', (e) => { if (!e.target.value) results.hidden = true; });

/* plan route on map */
function showPlanOnMap(planId) {
  const plan = store.getPlan(planId);
  if (!plan) return;
  const places = planPlaces(plan).filter((p) => typeof p.lat === 'number');
  if (!places.length) { toast('แผนนี้ยังไม่มีสถานที่ที่มีพิกัด'); return; }
  go('map');
  routeLayer.clearLayers();
  const pts = places.map((p) => [p.lat, p.lng]);
  L.polyline(pts, { color: plan.color || '#0d9488', weight: 4, opacity: .85, dashArray: '8 8' }).addTo(routeLayer);
  places.forEach((p, i) => {
    L.marker([p.lat, p.lng], { icon: pinIcon(p.status === 'visited' ? 'visited' : 'want', i + 1), zIndexOffset: 1000 })
      .bindPopup(() => placePopup(store.getPlace(p.id) || p), POPUP_OPTS).addTo(routeLayer);
  });
  const ctl = L.control({ position: 'topleft' });
  ctl.onAdd = () => {
    const d = L.DomUtil.create('div');
    d.innerHTML = `<button class="chip primary" style="margin-top:56px">✕ ${esc(plan.title)}</button>`;
    L.DomEvent.disableClickPropagation(d);
    d.querySelector('button').onclick = () => { routeLayer.clearLayers(); map.removeControl(ctl); };
    return d;
  };
  if (showPlanOnMap.ctl) map.removeControl(showPlanOnMap.ctl);
  showPlanOnMap.ctl = ctl.addTo(map);
  setTimeout(() => (pts.length > 1 ? map.fitBounds(pts, { padding: [60, 60] }) : map.setView(pts[0], 13)), 50);
}

/* ---------- place form ---------- */
const dlgPlace = $('#dlg-place');
const formPlace = $('#form-place');

function setCoords(lat, lng) {
  formPlace.lat.value = lat ?? '';
  formPlace.lng.value = lng ?? '';
  $('#coords-text').textContent = lat != null && lat !== '' ? `📍 ${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}` : 'ยังไม่มีพิกัด (ไม่แสดงบนแผนที่)';
}
function setPriority(v) {
  formPlace.priority.value = v;
  $$('#stars button').forEach((b) => b.classList.toggle('on', +b.dataset.v <= v));
}
$('#stars').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPriority(+b.dataset.v); });
function syncStatus() {
  const visited = formPlace.status.value === 'visited';
  $('.visited-only').hidden = !visited;
  if (visited && !formPlace.visitedAt.value) formPlace.visitedAt.value = todayStr();
}
formPlace.status.addEventListener('change', syncStatus);

function openPlaceForm(id, preset = {}) {
  const p = id ? store.getPlace(id) : null;
  formPlace.reset();
  formPlace.dataset.id = p?.id || '';
  $('#place-form-title').textContent = p ? 'แก้ไขสถานที่' : 'เพิ่มสถานที่';
  $('#btn-delete-place').hidden = !p;
  formPlace.name.value = p?.name || preset.name || '';
  formPlace.category.value = p?.category || preset.category || 'ธรรมชาติ';
  // Google place ID (from search) lets "Google Maps" open the exact place; cleared if the pin is moved.
  formPlace.dataset.gmapsId = p ? p.gmapsId || '' : preset.gmapsId || '';
  formPlace.status.value = p?.status || 'want';
  formPlace.visitedAt.value = p?.visitedAt || '';
  formPlace.note.value = p?.note || '';
  setPriority(p?.priority || 2);
  setCoords(p?.lat ?? preset.lat, p?.lng ?? preset.lng);
  syncStatus();
  dlgPlace.showModal();
}

$('#btn-pick-on-map').addEventListener('click', () => {
  dlgPlace.close();
  go('map');
  picking = true;
  document.body.classList.add('picking');
  $('.map-hint').textContent = 'แตะตำแหน่งบนแผนที่เพื่อเลือกพิกัด';
});
$('#btn-use-gps').addEventListener('click', () => {
  $('#coords-text').textContent = 'กำลังหาตำแหน่ง…';
  getPosition().then(({ lat, lng }) => { setCoords(lat, lng); formPlace.dataset.gmapsId = ''; })
    .catch(() => { setCoords(formPlace.lat.value, formPlace.lng.value); toast('ไม่สามารถระบุตำแหน่งได้'); });
});

formPlace.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = formPlace;
  const name = f.name.value.trim();
  if (!name) return;
  const lat = f.lat.value === '' ? null : +f.lat.value;
  const lng = f.lng.value === '' ? null : +f.lng.value;
  const saved = store.savePlace({
    id: f.dataset.id || undefined,
    name,
    category: f.category.value,
    status: f.status.value,
    visitedAt: f.status.value === 'visited' ? f.visitedAt.value || todayStr() : null,
    priority: +f.priority.value || 2,
    note: f.note.value.trim(),
    lat, lng,
    gmapsId: f.dataset.gmapsId || null,
  });
  dlgPlace.close();
  clearTemp();
  toast(f.dataset.id ? 'บันทึกแล้ว' : `ปักหมุด “${saved.name}” แล้ว`);
});

$('#btn-delete-place').addEventListener('click', () => {
  const id = formPlace.dataset.id;
  const p = store.getPlace(id);
  if (p && confirm(`ลบ “${p.name}”?`)) {
    store.deletePlace(id);
    dlgPlace.close();
    toast('ลบแล้ว');
  }
});
dlgPlace.addEventListener('close', () => { if (!picking) clearTemp(); });

function toggleVisited(id) {
  const p = store.getPlace(id);
  if (!p) return;
  const visited = p.status !== 'visited';
  store.savePlace({ ...p, status: visited ? 'visited' : 'want', visitedAt: visited ? todayStr() : null });
  toast(visited ? `🎉 ไป “${p.name}” แล้ว!` : 'ย้ายกลับไปยังไม่ได้ไป');
  map.closePopup();
}

/* ---------- list ---------- */
let listFilter = 'want';
$$('.seg').forEach((b) => b.addEventListener('click', () => {
  listFilter = b.dataset.filter;
  $$('.seg').forEach((x) => x.classList.toggle('active', x === b));
  renderList();
}));
$('#list-search').addEventListener('input', renderList);
$('#list-sort').addEventListener('change', renderList);

function renderList() {
  const q = $('#list-search').value.trim().toLowerCase();
  const sort = $('#list-sort').value;
  $('#count-want').textContent = store.places.filter((p) => p.status !== 'visited').length;
  $('#count-visited').textContent = store.places.filter((p) => p.status === 'visited').length;

  let items = store.places.filter((p) => (listFilter === 'visited' ? p.status === 'visited' : p.status !== 'visited'));
  if (q) items = items.filter((p) => `${p.name} ${p.category} ${p.note}`.toLowerCase().includes(q));
  const planned = plannedDates();
  items.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'th');
    if (sort === 'date') {
      const da = (listFilter === 'visited' ? a.visitedAt : planned.get(a.id)) || '9999';
      const db = (listFilter === 'visited' ? b.visitedAt : planned.get(b.id)) || '9999';
      return listFilter === 'visited' ? db.localeCompare(da) : da.localeCompare(db);
    }
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  const ul = $('#place-list');
  if (!items.length) {
    ul.innerHTML = `<li class="empty"><b>${listFilter === 'visited' ? '🧳' : '🗺️'}</b>${
      q ? 'ไม่พบรายการที่ค้นหา' : listFilter === 'visited' ? 'ยังไม่มีที่ที่ไปแล้ว' : 'ยังไม่มีสถานที่ — แตะบนแผนที่หรือกด + เพื่อปักหมุด'}</li>`;
    return;
  }
  ul.innerHTML = items.map((p) => {
    const plan = planned.get(p.id);
    const meta = [
      p.category,
      '★'.repeat(p.priority || 2),
      p.status === 'visited' && p.visitedAt ? `ไปเมื่อ ${fmtDate(p.visitedAt)}` : '',
      p.status !== 'visited' && plan ? `📅 ${fmtDate(plan)}` : '',
      typeof p.lat !== 'number' ? 'ไม่มีพิกัด' : '',
    ].filter(Boolean).join(' · ');
    return `<li class="card ${p.status === 'visited' ? 'visited' : ''}" data-id="${p.id}">
      <div class="badge">${icon(p.category)}</div>
      <div><div class="title">${esc(p.name)}</div><div class="meta">${esc(meta)}</div>
        ${p.note ? `<div class="meta">${esc(p.note.slice(0, 90))}${p.note.length > 90 ? '…' : ''}</div>` : ''}</div>
      <div class="actions">
        <button class="icon-btn" data-a="map" aria-label="ดูบนแผนที่" title="ดูบนแผนที่">🗺️</button>
        <button class="icon-btn" data-a="edit" aria-label="แก้ไข" title="แก้ไข">✏️</button>
        <button class="check" data-a="toggle" aria-label="สลับสถานะไปแล้ว" title="ไปแล้ว">✓</button>
      </div></li>`;
  }).join('');
}
$('#place-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'map') focusPlace(li.dataset.id);
  else if (a === 'toggle') toggleVisited(li.dataset.id);
  else openPlaceForm(li.dataset.id);
});

/** placeId -> earliest upcoming (or latest) plan start date */
function plannedDates() {
  const m = new Map();
  const today = todayStr();
  [...store.plans].sort((a, b) => a.start.localeCompare(b.start)).forEach((pl) => {
    pl.placeIds.forEach((id) => {
      const cur = m.get(id);
      if (!cur || (cur < today && pl.end >= today)) m.set(id, pl.start);
    });
  });
  return m;
}

/* ---------- calendar ---------- */
const calState = { y: new Date().getFullYear(), m: new Date().getMonth(), sel: todayStr() };
const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
$('#cal-dow').innerHTML = DOW.map((d) => `<div>${d}</div>`).join('');
$('#cal-prev').onclick = () => { calState.m--; if (calState.m < 0) { calState.m = 11; calState.y--; } renderCalendar(); };
$('#cal-next').onclick = () => { calState.m++; if (calState.m > 11) { calState.m = 0; calState.y++; } renderCalendar(); };
$('#cal-today').onclick = () => { const d = new Date(); Object.assign(calState, { y: d.getFullYear(), m: d.getMonth(), sel: todayStr() }); renderCalendar(); };

function eventsOn(day) {
  const plans = store.plans.filter((pl) => pl.start <= day && day <= pl.end);
  const visits = store.places.filter((p) => p.status === 'visited' && p.visitedAt === day);
  return { plans, visits };
}

function renderCalendar() {
  const { y, m } = calState;
  $('#cal-title').textContent = new Date(y, m, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const today = todayStr();
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m) break;
    const s = ymd(d);
    const { plans, visits } = eventsOn(s);
    const evs = [
      ...plans.map((pl) => `<div class="ev ${isCancelled(pl) ? 'cancelled' : ''}" style="background:${esc(pl.color || '#0d9488')}">${isCancelled(pl) ? '❌ ' : ''}${esc(pl.title)}</div>`),
      ...visits.map((p) => `<div class="ev visit">✓ ${esc(p.name)}</div>`),
    ];
    const shown = evs.slice(0, 2).join('') + (evs.length > 2 ? `<div class="more">+${evs.length - 2}</div>` : '');
    html += `<button class="cal-cell ${d.getMonth() !== m ? 'out' : ''} ${s === today ? 'today' : ''} ${s === calState.sel ? 'selected' : ''}" data-d="${s}">
      <span class="d">${d.getDate()}</span>${shown}</button>`;
  }
  $('#cal-grid').innerHTML = html;
  renderDayPanel();
}
$('#cal-grid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-d]');
  if (!c) return;
  calState.sel = c.dataset.d;
  const d = parseYmd(c.dataset.d);
  if (d.getMonth() !== calState.m) { calState.y = d.getFullYear(); calState.m = d.getMonth(); }
  renderCalendar();
});

function renderDayPanel() {
  const s = calState.sel;
  $('#cal-day-title').textContent = fmtDate(s, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const { plans, visits } = eventsOn(s);
  const ul = $('#cal-day-list');
  if (!plans.length && !visits.length) { ul.innerHTML = '<li class="muted" style="cursor:default">ไม่มีแผนหรือการเดินทางในวันนี้</li>'; return; }
  ul.innerHTML = [
    ...plans.map((pl) => `<li data-plan="${pl.id}"><span class="sw" style="background:${esc(pl.color || '#0d9488')}"></span>${esc(pl.title)}<small>${pl.placeIds.length} ที่ · ${fmtRange(pl.start, pl.end)}</small></li>`),
    ...visits.map((p) => `<li data-place="${p.id}"><span class="sw" style="background:var(--visited)"></span>${icon(p.category)} ${esc(p.name)}<small>ไปแล้ว</small></li>`),
  ].join('');
}
$('#cal-day-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li?.dataset.plan) openPlanForm(li.dataset.plan);
  if (li?.dataset.place) openPlaceForm(li.dataset.place);
});
$('#cal-add-plan').addEventListener('click', () => openPlanForm(null, { start: calState.sel, end: calState.sel }));

/* ---------- plans ---------- */
const dlgPlan = $('#dlg-plan');
const formPlan = $('#form-plan');
let pickedIds = [];

$('#swatches').innerHTML = PLAN_COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="สี ${c}"></button>`).join('');
function setColor(c) {
  formPlan.color.value = c;
  $$('#swatches button').forEach((b) => b.classList.toggle('on', b.dataset.c === c));
}
$('#swatches').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setColor(b.dataset.c); });

let extraStops = []; // companion's places already in the plan being edited

function renderPicker() {
  const ul = $('#plan-place-picker');
  const all = [...store.places, ...extraStops.filter((s) => !store.getPlace(s.id))];
  if (!all.length) { ul.innerHTML = '<li class="muted">ยังไม่มีสถานที่ — เพิ่มสถานที่ก่อน</li>'; return; }
  const sorted = all.sort((a, b) => {
    const ia = pickedIds.indexOf(a.id), ib = pickedIds.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return (a.status === 'visited') - (b.status === 'visited') || a.name.localeCompare(b.name, 'th');
  });
  ul.innerHTML = sorted.map((p) => {
    const i = pickedIds.indexOf(p.id);
    const tag = !store.getPlace(p.id) ? 'ของเพื่อน' : p.status === 'visited' ? 'ไปแล้ว' : '';
    return `<li data-id="${p.id}" class="${i >= 0 ? 'on' : ''}"><span class="n">${i >= 0 ? i + 1 : ''}</span>${icon(p.category)} ${esc(p.name)}<small>${tag}</small></li>`;
  }).join('');
}
$('#plan-place-picker').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  pickedIds = pickedIds.includes(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id];
  renderPicker();
});

/* Search for new places right inside the plan form; each result can be added (several in a row). */
let planResults = [];
async function planSearch() {
  const q = $('#plan-search').value.trim();
  const ul = $('#plan-search-results');
  if (!q) { ul.hidden = true; return; }
  ul.hidden = false;
  ul.innerHTML = '<li>กำลังค้นหา…</li>';
  try {
    const c = map.getCenter();
    const { source, items } = await searchPlaces(q, { lat: c.lat, lng: c.lng });
    planResults = items;
    renderPlanResults(source);
  } catch {
    ul.innerHTML = '<li>ค้นหาไม่สำเร็จ (ต้องเชื่อมต่ออินเทอร์เน็ต)</li>';
  }
}
const existingFor = (it) => store.places.find((p) => (it.gmapsId && p.gmapsId === it.gmapsId)
  || (p.name === it.name && Math.abs(p.lat - it.lat) < 0.0005 && Math.abs(p.lng - it.lng) < 0.0005));
function renderPlanResults(source) {
  const ul = $('#plan-search-results');
  if (!planResults.length) { ul.innerHTML = '<li>ไม่พบสถานที่ ลองใส่ชื่อจังหวัดด้วย</li>'; return; }
  ul.innerHTML = planResults.map((it, i) => {
    const added = pickedIds.includes(existingFor(it)?.id);
    return `<li data-i="${i}" class="${added ? 'added' : ''}">
      <span>${it.category ? icon(it.category) + ' ' : ''}${esc(it.name)}<small>${esc(it.address)}</small></span>
      <b>${added ? '✓ อยู่ในแผน' : '+ เพิ่ม'}</b></li>`;
  }).join('') + `<li class="credit">${source === 'google' ? 'ผลการค้นหาโดย Google' : 'ผลการค้นหาจาก OpenStreetMap'}</li>`;
  ul.dataset.source = source;
}
$('#plan-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); planSearch(); } });
$('#plan-search-btn').addEventListener('click', planSearch);
$('#plan-search-results').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const it = planResults[+li.dataset.i];
  let place = existingFor(it);
  if (!place) {
    place = store.savePlace({
      name: it.name, category: it.category || 'อื่นๆ', status: 'want', visitedAt: null, priority: 2,
      note: it.address || '', lat: it.lat, lng: it.lng, gmapsId: it.gmapsId || null,
    });
  }
  if (!pickedIds.includes(place.id)) pickedIds = [...pickedIds, place.id];
  renderPicker();
  renderPlanResults($('#plan-search-results').dataset.source);
  toast(`เพิ่ม “${place.name}” แล้ว (${pickedIds.length} ที่ในแผน)`);
});

formPlan.start.addEventListener('change', () => {
  if (!formPlan.end.value || formPlan.end.value < formPlan.start.value) formPlan.end.value = formPlan.start.value;
});

function openPlanForm(id, preset = {}) {
  const pl = id ? store.getPlan(id) : null;
  formPlan.reset();
  formPlan.dataset.id = pl?.id || '';
  $('#plan-form-title').textContent = pl ? 'แก้ไขแผนเที่ยว' : 'สร้างแผนเที่ยว';
  const del = $('#btn-delete-plan');
  del.hidden = !pl;
  del.textContent = pl && !store.isOwner(pl) ? 'ออกจากแผน' : 'ลบ';
  formPlan.title.value = pl?.title || '';
  formPlan.start.value = pl?.start || preset.start || addDays(todayStr(), 7);
  formPlan.end.value = pl?.end || preset.end || formPlan.start.value;
  formPlan.note.value = pl?.note || '';
  setColor(pl?.color || PLAN_COLORS[store.plans.length % PLAN_COLORS.length]);
  pickedIds = pl ? [...pl.placeIds] : preset.placeIds || [];
  extraStops = pl?.stops || preset.stops || [];
  $('#plan-search').value = '';
  $('#plan-search-results').hidden = true;
  planResults = [];
  renderPicker();
  dlgPlan.showModal();
}

formPlan.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = formPlan;
  if (f.end.value < f.start.value) { toast('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'); return; }
  const stops = pickedIds
    .map((id) => store.getPlace(id) || extraStops.find((s) => s.id === id))
    .filter(Boolean).map(stopOf);
  store.savePlan({
    id: f.dataset.id || undefined,
    title: f.title.value.trim(),
    start: f.start.value,
    end: f.end.value,
    color: f.color.value,
    note: f.note.value.trim(),
    placeIds: stops.map((s) => s.id),
    stops,
  });
  dlgPlan.close();
  toast('บันทึกแผนแล้ว');
});
$('#btn-delete-plan').addEventListener('click', () => {
  const pl = store.getPlan(formPlan.dataset.id);
  if (!pl) return;
  const owner = store.isOwner(pl);
  if (confirm(owner ? `ลบแผน “${pl.title}”? (เพื่อนร่วมทางจะไม่เห็นแผนนี้อีก)` : `ออกจากแผน “${pl.title}”?`)) {
    store.deletePlan(pl.id);
    dlgPlan.close();
    toast(owner ? 'ลบแผนแล้ว' : 'ออกจากแผนแล้ว');
  }
});
$('#btn-new-plan').addEventListener('click', () => openPlanForm(null));

function planStatus(pl) {
  const t = todayStr();
  if (pl.end < t) return { label: 'ผ่านไปแล้ว', cls: '' };
  if (pl.start <= t) return { label: 'กำลังเที่ยว', cls: 'now' };
  const days = Math.round((parseYmd(pl.start) - parseYmd(t)) / 86400000);
  return { label: days === 1 ? 'พรุ่งนี้' : `อีก ${days} วัน`, cls: '' };
}

/** Members of a plan: [{uid, name, thumb, owner, me}] owner first. */
function planMembers(pl) {
  const members = pl.members || {};
  return (pl.memberIds || [])
    .map((id) => {
      const live = id === social.uid ? social.me : social.friendProfile(id);
      const snap = members[id] || {};
      return { uid: id, name: live?.name || snap.name || 'สมาชิก', thumb: live?.thumb ?? snap.thumb ?? '', owner: id === pl.ownerId, me: id === social.uid };
    })
    .sort((a, b) => b.owner - a.owner);
}
const memberFace = (m) => ({ name: m.name, photo: m.thumb });

function membersRow(pl) {
  if (!store.isCloud) return '';
  const ms = planMembers(pl);
  const faces = ms.slice(0, 6).map((m) => avatar(memberFace(m))).join('');
  const label = ms.length > 1 ? `${ms.length} คน` : 'ยังไม่มีเพื่อนร่วมทาง';
  return `<div class="avatars" data-a="members" role="button" tabindex="0">${faces}<span class="label">${label}</span></div>`;
}

/* ---------- "you were added to a plan" notifications ----------
   Plans someone else owns that this user hasn't opened yet (remembered per device). */
let seenPlans = null; // Set of plan ids already seen; null until the server has answered
const freshPlans = new Set(); // tagged "ใหม่" while the Plans tab is open
const announced = new Set();
const seenKey = () => `wanderpin:seenPlans:${social.uid}`;
const invitedPlans = () => (store.isCloud ? store.plans.filter((pl) => !store.isOwner(pl)) : []);
const unseenPlans = () => (seenPlans ? invitedPlans().filter((pl) => !seenPlans.has(pl.id)) : []);
const ownerName = (pl) => pl.members?.[pl.ownerId]?.name || 'เพื่อน';
function saveSeen() { try { localStorage.setItem(seenKey(), JSON.stringify([...seenPlans])); } catch {} }

function onPlansArrived(fromCache) {
  if (!store.isCloud || !social.uid) return;
  if (!seenPlans) {
    if (fromCache) return; // wait for the server before deciding what is new
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(seenKey()) || 'null'); } catch {}
    if (saved) seenPlans = new Set(saved);
    else { seenPlans = new Set(invitedPlans().map((pl) => pl.id)); saveSeen(); } // first time on this device
  }
  const news = unseenPlans().filter((pl) => !announced.has(pl.id));
  news.forEach((pl) => announced.add(pl.id));
  if (news.length === 1) toast(`👋 ${ownerName(news[0])} ชวนคุณเข้าแผน “${news[0].title}”`);
  else if (news.length > 1) toast(`👋 คุณถูกชวนเข้าแผนใหม่ ${news.length} แผน`);
  if (current === 'plans') markPlansSeen();
  else renderBadges();
}

function markPlansSeen() {
  const unseen = unseenPlans();
  if (unseen.length) {
    unseen.forEach((pl) => { seenPlans.add(pl.id); freshPlans.add(pl.id); });
    saveSeen();
    renderPlans();
  }
  renderBadges();
}

function resetPlanNotices() { seenPlans = null; freshPlans.clear(); announced.clear(); }

const expandedPlans = new Set(); // finished trips the user opened

function renderPlans() {
  const ul = $('#plan-list');
  if (!store.plans.length) {
    ul.innerHTML = '<li class="empty"><b>🧭</b>ยังไม่มีแผนเที่ยว — กด “+ สร้างแผน” แล้วเลือกสถานที่และวันเดินทาง</li>';
    return;
  }
  const t = todayStr();
  const isFinished = isClosed;
  const active = store.plans.filter((p) => !isFinished(p));
  const upcoming = active.filter((p) => p.end >= t).sort((a, b) => a.start.localeCompare(b.start));
  const past = active.filter((p) => p.end < t).sort((a, b) => b.start.localeCompare(a.start));
  const finished = store.plans.filter(isFinished).sort((a, b) => b.end.localeCompare(a.end));
  ul.innerHTML = [...upcoming, ...past, ...finished].map((pl) => {
    // Finished trips are folded to one line (name + status); tap to open.
    if (isFinished(pl) && !expandedPlans.has(pl.id)) {
      return `<li class="card plan-card plan-mini" data-id="${pl.id}">
        <button class="mini-row" data-a="expand" aria-expanded="false">
          <i class="mini-dot" style="background:${esc(pl.color || '#0d9488')}"></i>
          <span class="mini-title">${esc(pl.title)}</span>
          ${closedChip(pl)}
          <span class="mini-caret" aria-hidden="true">▾</span>
        </button></li>`;
    }
    const st = planStatus(pl);
    const places = planPlaces(pl);
    const done = places.filter((p) => p.status === 'visited').length;
    const nights = Math.round((parseYmd(pl.end) - parseYmd(pl.start)) / 86400000);
    const owner = store.isCloud && !store.isOwner(pl) ? pl.members?.[pl.ownerId] : null;
    return `<li class="card plan-card ${freshPlans.has(pl.id) ? 'is-fresh' : ''}" data-id="${pl.id}">
      <div class="plan-bar" style="background:${esc(pl.color || '#0d9488')}"></div>
      <div class="plan-body">
        <div class="title">${esc(pl.title)}${isClosed(pl) ? closedChip(pl, 'tag') : `<span class="tag ${st.cls}">${st.label}</span>`}${freshPlans.has(pl.id) ? '<span class="tag fresh">ใหม่</span>' : ''}</div>
        ${owner ? `<div class="shared-by">${freshPlans.has(pl.id) ? '👋 ชวนโดย' : 'แชร์โดย'} ${esc(owner.name || owner.email)}</div>` : ''}
        <div class="plan-dates">📅 ${fmtRange(pl.start, pl.end)} · ${nights + 1} วัน${nights ? ` ${nights} คืน` : ''}</div>
        ${places.length ? `<ol>${places.map((p) => `<li class="${p.status === 'visited' ? 'done' : ''}">${icon(p.category)} ${esc(p.name)}</li>`).join('')}</ol>
          <div class="progress" title="ไปแล้ว ${done}/${places.length}"><i style="width:${(done / places.length) * 100}%"></i></div>
          <div class="meta">ไปแล้ว ${done}/${places.length} ที่</div>` : '<p class="note">ยังไม่ได้เลือกสถานที่</p>'}
        ${pl.note ? `<p class="note">${esc(pl.note)}</p>` : ''}
        ${callLine(pl)}
        ${membersRow(pl)}
        <div class="row">
          <button class="chip" data-a="map">ดูเส้นทาง</button>
          <button class="chip" data-a="cal">ดูในปฏิทิน</button>
          <button class="chip" data-a="members">👥 เพื่อนร่วมทาง</button>
          ${store.isCloud && (pl.memberIds || []).length > 1 && !isClosed(pl)
            ? `<a class="chip call-chip" data-a="call" href="${esc(roomUrl(planRoom(pl), social.me?.name))}" target="_blank" rel="noopener">📞 โทรกลุ่ม</a>` : ''}
          <button class="chip" data-a="edit">แก้ไข</button>
          ${store.isCloud && !store.isOwner(pl) ? '<button class="chip danger-chip" data-a="leave">ออกจากแผน</button>' : ''}
          ${closeButtons(pl, places)}
        </div>
      </div></li>`;
  }).join('');
}
$('#plan-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!li || !a) return;
  const pl = store.getPlan(li.dataset.id);
  if (a === 'map') showPlanOnMap(pl.id);
  if (a === 'edit') openPlanForm(pl.id);
  if (a === 'members') openMembers(pl.id);
  if (a === 'call' || a === 'join-call') {
    // The link opens the room; tell the others a call has started.
    if (a === 'call' && !(minutesSince(pl.call?.at) < RING_MINUTES)) {
      cloudApi?.startPlanCall(pl.id, social.uid).catch((err) => toast(cloudError(err)));
    }
    hideBanner(`plan:${pl.id}`);
  }
  if (a === 'finish') finishPlan(pl);
  if (a === 'cancel-trip' && confirm(`ทริป “${pl.title}” ล่ม? ทริปจะถูกปิด และทุกคนในทริปจะเห็นว่าทริปล่ม`)) cancelPlan(pl);
  if (a === 'reopen') {
    expandedPlans.delete(pl.id);
    store.savePlan({ id: pl.id, finishedAt: null, outcome: null });
    toast(`เปิดทริป “${pl.title}” อีกครั้งแล้ว`);
  }
  if (a === 'mine') {
    const n = markMyPlacesVisited(pl);
    toast(n ? `บันทึกว่าคุณไป ${n} ที่ในทริปนี้แล้ว` : 'บันทึกไว้ครบแล้ว');
  }
  if (a === 'expand') { expandedPlans.add(pl.id); renderPlans(); }
  if (a === 'collapse') { expandedPlans.delete(pl.id); renderPlans(); }
  if (a === 'leave' && confirm(`ออกจากแผน “${pl.title}”? แผนนี้จะหายจากรายการของคุณ`)) {
    store.deletePlan(pl.id);
    toast('ออกจากแผนแล้ว');
  }
  if (a === 'cal') {
    const d = parseYmd(pl.start);
    Object.assign(calState, { y: d.getFullYear(), m: d.getMonth(), sel: pl.start });
    go('calendar');
  }
});

/* ---------- "we went": mark a whole plan as visited ---------- */
/** My own copy of a plan stop: the place itself, or one I saved with the same Google place / name and spot. */
function myPlaceFor(stop) {
  const own = store.getPlace(stop.id);
  if (own) return own;
  return store.places.find((p) =>
    (stop.gmapsId && p.gmapsId === stop.gmapsId)
    || (p.name === stop.name && typeof p.lat === 'number' && typeof stop.lat === 'number'
      && Math.abs(p.lat - stop.lat) < 0.0005 && Math.abs(p.lng - stop.lng) < 0.0005));
}

/* Closing a trip (creator only, from its first day): "จบทริป" (done) or "ทริปล่ม" (cancelled).
   Stored on the plan (finishedAt + outcome), so everyone in the trip sees the same state. */
const isClosed = (pl) => Boolean(pl.finishedAt);
const isCancelled = (pl) => isClosed(pl) && pl.outcome === 'cancelled';
const closedChip = (pl, cls = 'chip') => (isCancelled(pl)
  ? `<span class="${cls} cancel-chip">❌ ทริปล่ม</span>`
  : `<span class="${cls} done-chip">🏁 จบทริปแล้ว</span>`);
const allMineVisited = (pl) => planPlaces(pl).every((s) => myPlaceFor(s)?.status === 'visited');

function closeButtons(pl, places) {
  const owner = store.isOwner(pl);
  if (isClosed(pl)) {
    return [
      '<button class="chip" data-a="collapse" aria-expanded="true">▴ ย่อ</button>',
      !isCancelled(pl) && places.length && !allMineVisited(pl) ? '<button class="chip" data-a="mine">✓ บันทึกว่าฉันไปแล้ว</button>' : '',
      owner ? '<button class="chip" data-a="reopen">↩ เปิดทริปอีกครั้ง</button>' : '',
    ].join('');
  }
  if (!owner || pl.start > todayStr()) return ''; // only the creator, and only once the trip has started
  return '<button class="chip danger-chip" data-a="cancel-trip">❌ ทริปล่ม</button><button class="chip primary" data-a="finish">🏁 จบทริป</button>';
}

/** Record every place of the plan as visited in my own list. Returns how many were changed. */
function markMyPlacesVisited(pl) {
  const today = todayStr();
  const when = today > pl.end ? pl.end : today; // trip already over → its last day
  let changed = 0;
  planPlaces(pl).forEach((stop) => {
    const mine = myPlaceFor(stop);
    if (mine?.status === 'visited') return;
    if (mine) store.savePlace({ ...mine, status: 'visited', visitedAt: when });
    else {
      // A companion's place: save it to my own list as visited, so it counts for me too.
      const { id, ...rest } = stop;
      store.savePlace({ ...rest, priority: 2, note: `จากแผน “${pl.title}”`, status: 'visited', visitedAt: when });
    }
    changed++;
  });
  return changed;
}

/** The plan's snapshot of places, with my own places refreshed (so companions see their status). */
const freshStops = (pl) => pl.placeIds.map((id) => {
  const own = store.getPlace(id);
  return own ? stopOf(own) : (pl.stops || []).find((s) => s.id === id);
}).filter(Boolean);

function finishPlan(pl) {
  const n = markMyPlacesVisited(pl);
  expandedPlans.delete(pl.id);
  store.savePlan({ id: pl.id, stops: freshStops(pl), finishedAt: new Date().toISOString(), outcome: 'done' });
  toast(n ? `🏁 จบทริป “${pl.title}” แล้ว บันทึกว่าไป ${n} ที่` : `🏁 จบทริป “${pl.title}” แล้ว`);
}

function cancelPlan(pl) {
  expandedPlans.delete(pl.id);
  store.savePlan({ id: pl.id, finishedAt: new Date().toISOString(), outcome: 'cancelled' });
  toast(`❌ ปิดทริป “${pl.title}” ว่าทริปล่มแล้ว`);
}

/* ---------- calls ---------- */
/** "📞 Alice started a group call 3 min ago — join" line on a plan card. */
function callLine(pl) {
  if (!store.isCloud || !pl.call || !(minutesSince(pl.call.at) < LIVE_MINUTES) || isClosed(pl)) return '';
  const mine = pl.call.by === social.uid;
  return `<div class="call-live">📞 ${mine ? 'คุณ' : esc(pl.call.name || 'เพื่อน')} เริ่มโทรกลุ่ม ${agoText(pl.call.at)}
    <a class="chip primary" data-a="join-call" href="${esc(roomUrl(planRoom(pl), social.me?.name))}" target="_blank" rel="noopener">เข้าร่วม</a></div>`;
}

const seenCalls = new Set(); // banners already shown or closed (this session)

/** A friend started a group call in one of my plans → banner. */
function notifyPlanCalls() {
  store.plans.forEach((pl) => {
    const c = pl.call;
    const key = `plan:${pl.id}`;
    if (!c || c.by === social.uid || !(minutesSince(c.at) < RING_MINUTES) || isClosed(pl)) { hideBanner(key); return; }
    const id = `${key}:${c.at}`;
    if (seenCalls.has(id) || hasBanner(key)) return;
    seenCalls.add(id);
    showBanner(key, {
      who: { name: c.name, photo: c.thumb },
      text: `<b>${esc(c.name || 'เพื่อน')}</b> เริ่มโทรกลุ่มในแผน “${esc(pl.title)}”`,
      url: roomUrl(planRoom(pl), social.me?.name),
      joinLabel: 'เข้าร่วม',
    });
  });
}

/** A friend is calling me → banner with answer / decline. */
function notifyFriendCalls(calls) {
  const live = new Set();
  calls.forEach((c) => {
    if (!(minutesSince(c.at) < RING_MINUTES)) { cloudApi?.endCall(c.id).catch(() => {}); return; }
    const key = `call:${c.id}`;
    live.add(key);
    const id = `${key}:${c.at}`;
    if (seenCalls.has(id)) return;
    seenCalls.add(id);
    showBanner(key, {
      who: { name: c.fromName, photo: c.fromThumb },
      text: `<b>${esc(c.fromName || 'เพื่อน')}</b> โทรหาคุณ`,
      url: roomUrl(c.room, social.me?.name),
      joinLabel: 'รับสาย',
      onJoin: () => cloudApi?.endCall(c.id).catch(() => {}),
      onDismiss: () => cloudApi?.endCall(c.id).catch(() => {}),
    });
  });
  // The caller hung up (deleted the ring) → remove its banner.
  document.querySelectorAll('.call-banner[data-key^="call:"]').forEach((el) => { if (!live.has(el.dataset.key)) hideBanner(el.dataset.key); });
}

function clearCallBanners() {
  document.querySelectorAll('.call-banner').forEach((el) => hideBanner(el.dataset.key));
  seenCalls.clear();
}

/* ---------- companions (friends only) ---------- */
const dlgMembers = $('#dlg-members');
let membersPlanId = null;

function openMembers(planId) {
  if (!store.isCloud) {
    openAccount(cloudConfigured ? 'เข้าสู่ระบบก่อน เพื่อชวนเพื่อนมาร่วมแผนนี้' : 'ระบบเพื่อนร่วมทางยังไม่ได้เปิดใช้');
    return;
  }
  membersPlanId = planId;
  renderMembers();
  dlgMembers.showModal();
}

function renderMembers() {
  const pl = store.getPlan(membersPlanId);
  if (!pl) { dlgMembers.close(); return; }
  const owner = store.isOwner(pl);
  $('#members-plan').textContent = `${pl.title} · ${fmtRange(pl.start, pl.end)}`;
  const ms = planMembers(pl);
  $('#member-list').innerHTML = ms.map((m) => `<li data-user="${esc(m.uid)}">
      ${avatar(memberFace(m))}
      <div class="who"><b>${esc(m.name)}${m.me ? ' (คุณ)' : ''}</b><small>${m.me ? '' : social.isFriend(m.uid) ? 'เพื่อนของคุณ' : 'เพื่อนของเจ้าของแผน'}</small></div>
      ${m.owner ? '<span class="role owner">เจ้าของแผน</span>' : '<span class="role">สมาชิก</span>'}
      ${owner && !m.owner ? `<button class="remove" data-remove="${esc(m.uid)}" aria-label="ลบ ${esc(m.name)} ออกจากแผน">ลบ</button>` : ''}
    </li>`).join('');

  const add = $('#member-add');
  if (!owner) {
    add.innerHTML = '<p class="muted small">เฉพาะเจ้าของแผนที่เพิ่มหรือลบสมาชิกได้</p>';
  } else {
    const candidates = social.friends.filter((f) => !(pl.memberIds || []).includes(f.uid));
    add.innerHTML = `<div class="add-friends"><h3>ชวนเพื่อนเข้าแผน</h3>${
      candidates.length
        ? `<ul class="people">${candidates.map((f) => `<li class="person" data-user="${esc(f.uid)}">
            ${avatar({ name: f.name, photo: f.thumb })}
            <div class="who"><b>${esc(f.name)}</b><small>${f.isPublic ? 'สาธารณะ' : 'ส่วนตัว'}</small></div>
            <div class="acts"><button class="chip primary" data-add="${esc(f.uid)}">+ เพิ่ม</button></div></li>`).join('')}</ul>`
        : `<p class="muted small">${social.friends.length ? 'เพื่อนทุกคนอยู่ในแผนนี้แล้ว' : 'ชวนได้เฉพาะเพื่อน ยังไม่มีเพื่อนเลย'}</p>
           <button class="btn" data-go-friends>ไปหน้าเพื่อนเพื่อค้นหาและเพิ่มเพื่อน</button>`
    }</div>`;
  }
  $('#btn-leave-plan').hidden = owner;
}

dlgMembers.addEventListener('click', async (e) => {
  const pl = store.getPlan(membersPlanId);
  if (!pl) return;
  const rm = e.target.closest('[data-remove]')?.dataset.remove;
  const addId = e.target.closest('[data-add]')?.dataset.add;
  try {
    if (rm) {
      const m = planMembers(pl).find((x) => x.uid === rm);
      if (!confirm(`ลบ ${m?.name || 'สมาชิก'} ออกจากแผน?`)) return;
      await store.removeMember(pl.id, rm);
      toast('ลบสมาชิกแล้ว');
      return;
    }
    if (addId) {
      e.target.closest('button').disabled = true;
      await store.addMember(pl.id, addId, social.friendProfile(addId));
      toast(`เพิ่ม ${social.friendProfile(addId)?.name || 'เพื่อน'} เข้าแผนแล้ว`);
      return;
    }
  } catch (err) { toast(cloudError(err)); renderMembers(); return; }
  if (e.target.closest('[data-go-friends]')) { dlgMembers.close(); go('friends'); return; }
  const user = e.target.closest('[data-user]')?.dataset.user;
  if (user && !e.target.closest('button')) openUser(user, planMembers(pl).find((m) => m.uid === user));
});

$('#btn-leave-plan').addEventListener('click', () => {
  const pl = store.getPlan(membersPlanId);
  if (pl && confirm(`ออกจากแผน “${pl.title}”?`)) {
    store.deletePlan(pl.id);
    dlgMembers.close();
    toast('ออกจากแผนแล้ว');
  }
});

/* ---------- menu: export / import ---------- */
const dlgMenu = $('#dlg-menu');
$('#btn-menu').addEventListener('click', () => {
  const v = store.places.filter((p) => p.status === 'visited').length;
  renderBadgeSetting();
  $('#stats').textContent = `สถานที่ทั้งหมด ${store.places.length} · ไปแล้ว ${v} · ยังไม่ได้ไป ${store.places.length - v} · แผน ${store.plans.length}`;
  dlgMenu.showModal();
});
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wanderpin-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const r = store.importJSON(await file.text());
    toast(`นำเข้า ${r.places} สถานที่, ${r.plans} แผน`);
    dlgMenu.close();
    fitAll();
  } catch (err) {
    toast('นำเข้าไม่สำเร็จ: ' + err.message);
  }
  e.target.value = '';
});
$('#btn-clear').addEventListener('click', () => {
  const msg = store.isCloud
    ? 'ลบสถานที่และแผนทั้งหมดในบัญชีนี้? แผนที่เป็นของเพื่อนจะเป็นการออกจากแผนแทน (ควรส่งออกไว้ก่อน)'
    : 'ลบข้อมูลทั้งหมดในเครื่องนี้? (ควรส่งออกไว้ก่อน)';
  if (confirm(msg)) { store.clear(); dlgMenu.close(); toast('ล้างข้อมูลแล้ว'); }
});

/* close buttons / backdrop click for dialogs */
$$('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

/* FAB */
$('#fab-add').addEventListener('click', () => {
  if (current === 'plans') return openPlanForm(null);
  if (current === 'calendar') return openPlanForm(null, { start: calState.sel, end: calState.sel });
  const c = current === 'map' ? map.getCenter() : null;
  openPlaceForm(null, c ? { lat: c.lat, lng: c.lng } : {});
});

/* ---------- render all on change ---------- */
function renderAll() {
  renderMarkers();
  renderList();
  renderPlans();
  if (current === 'calendar') renderCalendar();
  if (dlgPlan.open) renderPicker();
  if (dlgMembers.open) renderMembers();
  if (store.isCloud) {
    social.updateStats({
      places: store.places.length,
      visited: store.places.filter((p) => p.status === 'visited').length,
      plans: store.plans.length,
    });
  }
}
store.subscribe(renderAll);
renderAll();
fitAll();

const hash = location.hash.slice(1);
if (hash === 'add') { go('map'); openPlaceForm(null); } else go(hash || 'map');
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

/* ---------- account (Google) & profile ---------- */
const dlgAccount = $('#dlg-account');
let cloudApi = null;
let cloudReady = null;
let unwatch = null;
let accountMsg = '';
let busy = false;

const GOOGLE_SVG = '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function cloudError(err) {
  if (!err) return 'เกิดข้อผิดพลาด';
  if (AUTH_ERRORS[err.code]) return AUTH_ERRORS[err.code];
  if (err.code === 'permission-denied') return 'ไม่มีสิทธิ์ทำรายการนี้';
  if (err.code === 'unavailable') return 'ออฟไลน์อยู่ จะซิงก์เมื่อกลับมาออนไลน์';
  return err.message || 'เกิดข้อผิดพลาด';
}
store.onError = (err) => toast(cloudError(err));

function renderAccountButton() {
  const btn = $('#btn-account');
  const me = store.user ? social.me : null;
  btn.classList.toggle('signed', Boolean(store.user));
  btn.innerHTML = store.user
    ? avatar({ name: me?.name || store.user.displayName || '?', photo: me ? me.thumb : store.user.photoURL })
    : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5z"/></svg>';
  btn.title = store.user ? `โปรไฟล์ของฉัน: ${me?.name || ''}` : 'เข้าสู่ระบบ';
}

function setTabBadge(id, n) {
  const b = $(id);
  b.hidden = !n;
  b.textContent = n > 9 ? '9+' : n;
}
/** Red numbers: Friends tab = friend requests, Plans tab = new plans you were added to, app icon = both. */
function renderBadges() {
  const requests = social.active ? social.incomingCount : 0;
  const plans = social.active ? unseenPlans().length : 0;
  setTabBadge('#friends-badge', requests);
  setTabBadge('#plans-badge', plans);
  setIconBadge(requests + plans);
}

/* Red number on the home-screen icon (App Badging API).
   iPhone: works for an app added to the Home Screen (iOS 16.4+) after notifications are allowed. */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canBadge = 'setAppBadge' in navigator;
function setIconBadge(n) {
  if (!canBadge) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
function renderBadgeSetting() {
  const btn = $('#btn-badge');
  const hint = $('#badge-hint');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  btn.hidden = !(canBadge && perm === 'default');
  hint.hidden = false;
  if (canBadge && perm === 'granted') hint.textContent = '🔴 เปิดตัวเลขแจ้งเตือนบนไอคอนแล้ว: แสดงจำนวนคำขอเป็นเพื่อนและแผนใหม่ที่คุณถูกชวน';
  else if (canBadge && perm === 'denied') hint.textContent = 'ปิดการแจ้งเตือนไว้ เปิดได้ที่ การตั้งค่า → การแจ้งเตือน → Wanderpin';
  else if (isIOS && !isStandalone()) hint.textContent = 'ติดตั้งแอปบนหน้าจอโฮมก่อน (ปุ่มแชร์ → เพิ่มไปยังหน้าจอโฮม) จึงจะเปิดตัวเลขแจ้งเตือนบนไอคอนได้';
  else if (!canBadge) hint.textContent = 'เครื่องหรือเบราว์เซอร์นี้แสดงตัวเลขบนไอคอนแอปไม่ได้';
  else hint.hidden = true;
}
$('#btn-badge').addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { toast('เปิดตัวเลขแจ้งเตือนบนไอคอนแล้ว'); renderBadges(); }
    else toast('ไม่ได้อนุญาตการแจ้งเตือน');
  } catch { toast('เปิดการแจ้งเตือนไม่ได้'); }
  renderBadgeSetting();
});

function renderAccount() {
  const body = $('#account-body');
  $('#dlg-account h2').textContent = store.user ? 'โปรไฟล์ของฉัน' : 'บัญชีผู้ใช้';
  const msg = accountMsg ? `<p class="notice">${esc(accountMsg)}</p>` : '';
  if (!cloudConfigured) {
    body.innerHTML = `${msg}<div class="notice">ระบบสมาชิกและเพื่อนต้องเชื่อม Firebase ก่อน
      ใส่ค่าโปรเจกต์ใน <code>js/firebase-config.js</code> ตามขั้นตอนใน README
      ระหว่างนี้ข้อมูลทั้งหมดเก็บอยู่ในเครื่องนี้และใช้งานได้ตามปกติ</div>`;
    return;
  }
  if (store.user) {
    body.innerHTML = `${msg}<div id="profile-editor"></div>`;
    renderProfileEditor($('#profile-editor'), {
      onSignOut: async () => { await cloudApi.signOut(); dlgAccount.close(); toast('ออกจากระบบแล้ว'); },
    });
    return;
  }
  const signup = authMode === 'signup';
  body.innerHTML = `${msg}<p class="muted">เข้าสู่ระบบเพื่อซิงก์ข้อมูลข้ามเครื่อง ตั้งชื่อและรูปของคุณ เพิ่มเพื่อน และชวนเพื่อนไปเที่ยวตามแผนเดียวกัน</p>
    <div class="signin">
      <button id="btn-google" ${busy ? 'disabled' : ''}>${GOOGLE_SVG}เข้าสู่ระบบด้วย Google</button>
    </div>
    <div class="or"><span>หรือใช้ชื่อผู้ใช้ (ไม่ต้องมีอีเมล)</span></div>
    <div class="segmented auth-tabs" role="tablist">
      <button type="button" role="tab" class="seg ${signup ? '' : 'active'}" data-mode="login">เข้าสู่ระบบ</button>
      <button type="button" role="tab" class="seg ${signup ? 'active' : ''}" data-mode="signup">สมัครใหม่</button>
    </div>
    <form id="form-userpass" class="userpass" autocomplete="on" novalidate>
      <label for="up-username">ชื่อผู้ใช้</label>
      <input id="up-username" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
        inputmode="email" maxlength="20" required placeholder="เช่น somkiat" value="${esc(draftUsername)}">
      ${signup ? '<small class="muted">ภาษาอังกฤษตัวเล็ก ตัวเลข จุด หรือ _ ยาว 3–20 ตัว ใช้สำหรับเข้าระบบเท่านั้น (ชื่อที่แสดงตั้งทีหลังได้)</small>' : ''}
      <label for="up-password">รหัสผ่าน</label>
      <input id="up-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required>
      ${signup ? `<label for="up-password2">ยืนยันรหัสผ่าน</label>
      <input id="up-password2" name="password2" type="password" autocomplete="new-password" minlength="6" required>
      <p class="notice small">⚠️ จดรหัสผ่านไว้ให้ดี บัญชีแบบนี้ไม่มีอีเมล ถ้าลืมรหัสผ่านจะกู้คืนเองไม่ได้</p>` : ''}
      <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${signup ? 'สมัครและเข้าสู่ระบบ' : 'เข้าสู่ระบบ'}</button>
    </form>
    <p class="muted small">ครั้งแรกที่เข้าระบบ สถานที่และแผนที่มีอยู่ในเครื่องนี้จะถูกอัปโหลดเข้าบัญชีให้</p>`;
  $('#btn-google').onclick = () => signIn();
  $$('.auth-tabs .seg').forEach((b) => b.addEventListener('click', () => {
    draftUsername = $('#up-username').value;
    authMode = b.dataset.mode;
    accountMsg = '';
    renderAccount();
  }));
  $('#form-userpass').onsubmit = (e) => { e.preventDefault(); signInUsername(e.target); };
}

let authMode = 'login';
let draftUsername = '';

async function signInUsername(f) {
  const username = normalizeUsername(f.username.value);
  const password = f.password.value;
  draftUsername = username;
  const fail = (m) => { accountMsg = m; renderAccount(); $('#up-password')?.focus(); };
  if (!USERNAME_RE.test(username)) return fail('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษตัวเล็ก ตัวเลข จุด หรือ _ ยาว 3–20 ตัว');
  if (password.length < 6) return fail('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
  if (authMode === 'signup' && password !== f.password2.value) return fail('ยืนยันรหัสผ่านไม่ตรงกัน');
  busy = true; accountMsg = ''; renderAccount();
  try {
    const api = await cloudReady;
    if (!api) throw new Error('เชื่อมต่อระบบสมาชิกไม่ได้ (ต้องใช้อินเทอร์เน็ต)');
    if (authMode === 'signup') await api.signUpWithUsername(username, password);
    else await api.signInWithUsername(username, password);
    draftUsername = '';
    authMode = 'login';
    dlgAccount.close();
  } catch (err) {
    accountMsg = cloudError(err);
  } finally {
    busy = false;
    if (dlgAccount.open) renderAccount();
  }
}

async function signIn() {
  busy = true; accountMsg = ''; renderAccount();
  try {
    const api = await cloudReady;
    if (!api) throw new Error('เชื่อมต่อระบบสมาชิกไม่ได้ (ต้องใช้อินเทอร์เน็ต)');
    await api.signIn();
    dlgAccount.close();
  } catch (err) {
    accountMsg = cloudError(err);
  } finally {
    busy = false;
    if (dlgAccount.open) renderAccount();
  }
}

function openAccount(message = '') {
  accountMsg = message;
  resetProfileDraft();
  renderAccount();
  if (!dlgAccount.open) dlgAccount.showModal();
}
$('#btn-account').addEventListener('click', () => openAccount());

social.onNewProfile = () => {
  toast('ยินดีต้อนรับ! ตั้งชื่อและรูปของคุณได้เลย');
  openAccount();
};
social.subscribe(() => {
  renderAccountButton();
  renderBadges();
  if (current === 'friends') { renderFriendsView(); if (!social.fofReady) social.loadFriendsOfFriends(); }
  if (dlgMembers.open) renderMembers();
  if (store.isCloud) renderPlans();
});
bindFriendsView({ openAccount: () => openAccount(), openSignIn: () => openAccount() });
bindUserDialog({ openAccount: () => openAccount() });

async function onSignedIn(user) {
  const migratedKey = `wanderpin:uploaded:${user.uid}`;
  let uploaded = false;
  try { uploaded = localStorage.getItem(migratedKey) === '1'; } catch {}
  if (!uploaded) {
    const local = loadLocal();
    if (local.places.length || local.plans.length) {
      try {
        await cloudApi.uploadLocal(user, local);
        toast(`อัปโหลด ${local.places.length} สถานที่, ${local.plans.length} แผน เข้าบัญชีแล้ว`);
      } catch (err) { toast(cloudError(err)); }
    }
    try { localStorage.setItem(migratedKey, '1'); } catch {}
  }
  store.useCloud(cloudApi, user);
  const h = social.start(cloudApi, user);
  renderAccountButton();
  let firstPlaces = true;
  let gotPlans = false;
  let gotProfile = false;
  const trySync = () => { if (gotPlans && gotProfile) { gotPlans = gotProfile = false; social.syncPlans(); } };
  unwatch = cloudApi.watch(user.uid, {
    ...h,
    onCalls: (calls) => notifyFriendCalls(calls),
    onProfile: (p, fromCache) => { h.onProfile(p, fromCache); if (p && !fromCache) { gotProfile = true; trySync(); } },
    onPlaces: (places) => { store.setPlaces(places); if (firstPlaces) { firstPlaces = false; fitAll(); } },
    onPlans: (plans, fromCache) => {
      store.setPlans(plans);
      onPlansArrived(fromCache);
      if (!fromCache) notifyPlanCalls();
      if (!gotPlans && !fromCache) { gotPlans = true; trySync(); }
    },
    onError: (err) => toast(cloudError(err)),
  });
  if (current === 'friends') { renderFriendsView(); social.loadDirectory(); }
}

function startCloud() {
  renderAccountButton();
  if (!cloudConfigured) return;
  cloudReady = initCloud().catch((err) => { console.warn('Firebase init failed', err); return null; });
  cloudReady.then((api) => {
    if (!api) return;
    cloudApi = api;
    api.redirectError.then((err) => { if (err) toast(cloudError(err)); });
    api.onAuth((user) => {
      unwatch?.(); unwatch = null;
      if (user) onSignedIn(user);
      else if (store.isCloud) { clearCallBanners(); resetPlanNotices(); social.stop(); store.useLocal(); renderAccountButton(); renderBadges(); }
    });
  });
}
startCloud();

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.warn));
  // A new version took over: reload once so the page runs the new code.
  if (navigator.serviceWorker.controller) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
}
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('ติดตั้งแอปแล้ว'); });

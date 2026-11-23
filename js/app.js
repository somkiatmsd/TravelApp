import { store, loadLocal } from './store.js';
import { initCloud, cloudConfigured, AUTH_ERRORS, lowerEmail, profileOf } from './cloud.js';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/** Places of a plan, in order. Own places are live; a companion's places come from the plan's snapshot. */
const planPlaces = (pl) =>
  pl.placeIds.map((id) => store.getPlace(id) || (pl.stops || []).find((s) => s.id === id)).filter(Boolean);
const stopOf = (p) => ({ id: p.id, name: p.name, category: p.category, status: p.status, visitedAt: p.visitedAt ?? null, lat: p.lat ?? null, lng: p.lng ?? null });

const initials = (name = '?') => [...name.trim()][0]?.toUpperCase() || '?';
function avatar(m, cls = '') {
  const title = esc(m.name || m.email || '');
  if (m.photo) return `<img class="avatar ${cls}" src="${esc(m.photo)}" alt="" title="${title}" data-initial="${esc(initials(m.name || m.email))}" referrerpolicy="no-referrer">`;
  return `<span class="avatar ${cls}" title="${title}">${esc(initials(m.name || m.email))}</span>`;
}

// Profile photo failed to load (offline, expired link): show the initial instead.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('avatar')) return;
  const span = document.createElement('span');
  span.className = img.className;
  span.title = img.title;
  span.textContent = img.dataset.initial || '?';
  img.replaceWith(span);
}, true);

const directionsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

/* ---------- routing / tabs ---------- */
let current = 'map';
function go(view) {
  if (!['map', 'list', 'calendar', 'plans'].includes(view)) view = 'map';
  current = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.go === view));
  if (view === 'map') setTimeout(() => map.invalidateSize(), 0);
  if (view === 'calendar') renderCalendar();
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.go)));

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false }).setView([13.7563, 100.5018], 6);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerById = new Map();
let tempMarker = null;
let picking = false;

const pinIcon = (cls, label = '') =>
  L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${esc(label)}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

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
    </div>`;
  div.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'edit') { map.closePopup(); openPlaceForm(p.id); }
    if (a === 'toggle') { toggleVisited(p.id); }
  });
  return div;
}

function renderMarkers() {
  markersLayer.clearLayers();
  markerById.clear();
  store.places.forEach((p) => {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p.status === 'visited' ? 'visited' : 'want'), title: p.name })
      .bindPopup(() => placePopup(store.getPlace(p.id)))
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

/* search (OpenStreetMap Nominatim) */
async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=th&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('search failed');
  return r.json();
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=th&lat=${lat}&lon=${lng}`);
    if (!r.ok) return '';
    const j = await r.json();
    return j.name || (j.display_name || '').split(',')[0] || '';
  } catch { return ''; }
}

const results = $('#search-results');
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  results.hidden = false;
  results.innerHTML = '<li>กำลังค้นหา…</li>';
  try {
    const items = await geocode(q);
    if (!items.length) { results.innerHTML = '<li>ไม่พบสถานที่</li>'; return; }
    results.innerHTML = items.map((it, i) => {
      const [first, ...rest] = it.display_name.split(',');
      return `<li tabindex="0" data-i="${i}">${esc(it.name || first)}<small>${esc(rest.join(',').trim())}</small></li>`;
    }).join('');
    results.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      const it = items[+li.dataset.i];
      const lat = +it.lat, lng = +it.lon;
      results.hidden = true;
      map.setView([lat, lng], 15);
      clearTemp();
      const div = document.createElement('div');
      div.className = 'popup';
      const nm = it.name || it.display_name.split(',')[0];
      div.innerHTML = `<h4>${esc(nm)}</h4><p>${esc(it.display_name)}</p>
        <div class="row"><button class="chip primary">+ เพิ่มสถานที่</button></div>`;
      div.querySelector('button').addEventListener('click', () => {
        map.closePopup();
        openPlaceForm(null, { lat, lng, name: nm });
      });
      tempMarker = L.marker([lat, lng], { icon: pinIcon('temp') }).addTo(map).bindPopup(div).openPopup();
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
      .bindPopup(() => placePopup(store.getPlace(p.id) || p)).addTo(routeLayer);
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
  formPlace.category.value = p?.category || 'ธรรมชาติ';
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
  getPosition().then(({ lat, lng }) => setCoords(lat, lng))
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
      ...plans.map((pl) => `<div class="ev" style="background:${esc(pl.color || '#0d9488')}">${esc(pl.title)}</div>`),
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
  extraStops = pl?.stops || [];
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

/** Members of a plan: [{uid, name, email, photo, owner, me}] owner first. */
function planMembers(pl) {
  const members = pl.members || {};
  return (pl.memberIds || [])
    .map((id) => ({ uid: id, ...(members[id] || (store.user?.uid === id ? profileOf(store.user) : { name: 'สมาชิก' })), owner: id === pl.ownerId, me: id === store.user?.uid }))
    .sort((a, b) => b.owner - a.owner);
}

function membersRow(pl) {
  if (!store.isCloud) return '';
  const ms = planMembers(pl);
  const pending = pl.pendingEmails || [];
  const faces = ms.slice(0, 5).map((m) => avatar(m)).join('') + pending.slice(0, 3).map((e) => avatar({ email: e }, 'pending')).join('');
  const label = ms.length > 1 || pending.length
    ? `${ms.length} คน${pending.length ? ` · รอเข้าร่วม ${pending.length}` : ''}`
    : 'ยังไม่มีเพื่อนร่วมทาง';
  return `<div class="avatars" data-a="members" role="button" tabindex="0">${faces}<span class="label">${label}</span></div>`;
}

function renderPlans() {
  const ul = $('#plan-list');
  if (!store.plans.length) {
    ul.innerHTML = '<li class="empty"><b>🧭</b>ยังไม่มีแผนเที่ยว — กด “+ สร้างแผน” แล้วเลือกสถานที่และวันเดินทาง</li>';
    return;
  }
  const t = todayStr();
  const upcoming = store.plans.filter((p) => p.end >= t).sort((a, b) => a.start.localeCompare(b.start));
  const past = store.plans.filter((p) => p.end < t).sort((a, b) => b.start.localeCompare(a.start));
  ul.innerHTML = [...upcoming, ...past].map((pl) => {
    const st = planStatus(pl);
    const places = planPlaces(pl);
    const done = places.filter((p) => p.status === 'visited').length;
    const nights = Math.round((parseYmd(pl.end) - parseYmd(pl.start)) / 86400000);
    const owner = store.isCloud && !store.isOwner(pl) ? pl.members?.[pl.ownerId] : null;
    return `<li class="card plan-card" data-id="${pl.id}">
      <div class="plan-bar" style="background:${esc(pl.color || '#0d9488')}"></div>
      <div class="plan-body">
        <div class="title">${esc(pl.title)}<span class="tag ${st.cls}">${st.label}</span></div>
        ${owner ? `<div class="shared-by">แชร์โดย ${esc(owner.name || owner.email)}</div>` : ''}
        <div class="plan-dates">📅 ${fmtRange(pl.start, pl.end)} · ${nights + 1} วัน${nights ? ` ${nights} คืน` : ''}</div>
        ${places.length ? `<ol>${places.map((p) => `<li class="${p.status === 'visited' ? 'done' : ''}">${icon(p.category)} ${esc(p.name)}</li>`).join('')}</ol>
          <div class="progress" title="ไปแล้ว ${done}/${places.length}"><i style="width:${(done / places.length) * 100}%"></i></div>
          <div class="meta">ไปแล้ว ${done}/${places.length} ที่</div>` : '<p class="note">ยังไม่ได้เลือกสถานที่</p>'}
        ${pl.note ? `<p class="note">${esc(pl.note)}</p>` : ''}
        ${membersRow(pl)}
        <div class="row">
          <button class="chip" data-a="map">ดูเส้นทาง</button>
          <button class="chip" data-a="cal">ดูในปฏิทิน</button>
          <button class="chip" data-a="members">👥 เพื่อนร่วมทาง</button>
          <button class="chip" data-a="edit">แก้ไข</button>
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
  if (a === 'cal') {
    const d = parseYmd(pl.start);
    Object.assign(calState, { y: d.getFullYear(), m: d.getMonth(), sel: pl.start });
    go('calendar');
  }
});

/* ---------- companions ---------- */
const dlgMembers = $('#dlg-members');
let membersPlanId = null;

function openMembers(planId) {
  if (!store.isCloud) {
    openAccount(cloudConfigured
      ? 'เข้าสู่ระบบก่อน เพื่อชวนเพื่อนร่วมทางและแชร์แผนนี้'
      : 'ระบบเพื่อนร่วมทางยังไม่ได้เปิดใช้');
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
  const rows = planMembers(pl).map((m) => `<li>
      ${avatar(m)}
      <div class="who"><b>${esc(m.name || m.email)}${m.me ? ' (คุณ)' : ''}</b><small>${esc(m.email || '')}</small></div>
      ${m.owner ? '<span class="role owner">เจ้าของแผน</span>' : '<span class="role">สมาชิก</span>'}
      ${owner && !m.owner ? `<button class="remove" data-remove="${esc(m.uid)}" aria-label="ลบ ${esc(m.name)}">ลบ</button>` : ''}
    </li>`);
  const pend = (pl.pendingEmails || []).map((e) => `<li>
      ${avatar({ email: e }, 'pending')}
      <div class="who"><b>${esc(e)}</b><small>ยังไม่ได้เข้าระบบ</small></div>
      <span class="role">รอเข้าร่วม</span>
      ${owner ? `<button class="remove" data-cancel="${esc(e)}" aria-label="ยกเลิกคำเชิญ ${esc(e)}">ยกเลิก</button>` : ''}
    </li>`);
  $('#member-list').innerHTML = [...rows, ...pend].join('');
  $('#form-invite').hidden = !owner;
  $('#btn-leave-plan').hidden = owner;
}

$('#member-list').addEventListener('click', async (e) => {
  const pl = store.getPlan(membersPlanId);
  const rm = e.target.closest('[data-remove]')?.dataset.remove;
  const cancel = e.target.closest('[data-cancel]')?.dataset.cancel;
  try {
    if (rm) {
      const m = planMembers(pl).find((x) => x.uid === rm);
      if (!confirm(`ลบ ${m?.name || 'สมาชิก'} ออกจากแผน?`)) return;
      await store.removeMember(pl.id, rm);
      toast('ลบสมาชิกแล้ว');
    }
    if (cancel) { await store.cancelInvite(pl.id, cancel); toast('ยกเลิกคำเชิญแล้ว'); }
  } catch (err) { toast(cloudError(err)); }
});

$('#form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pl = store.getPlan(membersPlanId);
  const email = lowerEmail($('#invite-email').value);
  if (!pl || !email) return;
  if (planMembers(pl).some((m) => m.email === email)) { toast('คนนี้อยู่ในแผนแล้ว'); return; }
  if ((pl.pendingEmails || []).includes(email)) { toast('เชิญคนนี้ไว้แล้ว'); return; }
  try {
    await store.invite(pl.id, email);
    $('#invite-email').value = '';
    toast(`เชิญ ${email} แล้ว`);
  } catch (err) { toast(cloudError(err)); }
});

$('#btn-share-invite').addEventListener('click', async () => {
  const pl = store.getPlan(membersPlanId);
  if (!pl) return;
  const url = location.origin + location.pathname;
  const text = `มาเที่ยวด้วยกัน! ทริป “${pl.title}” (${fmtRange(pl.start, pl.end)}) เปิด Wanderpin แล้วเข้าสู่ระบบด้วยอีเมลที่ฉันเชิญไว้ จะเห็นแผนนี้ทันที`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Wanderpin', text, url }); return; }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('คัดลอกข้อความเชิญแล้ว');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('แชร์ไม่สำเร็จ');
  }
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
}
store.subscribe(renderAll);
renderAll();
fitAll();

const hash = location.hash.slice(1);
if (hash === 'add') { go('map'); openPlaceForm(null); } else go(hash || 'map');
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

/* ---------- account (Google / Facebook) ---------- */
const dlgAccount = $('#dlg-account');
let cloudApi = null;
let cloudReady = null;
let unwatch = null;
let accountMsg = '';
let busy = false;

const GOOGLE_SVG = '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const FB_SVG = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.88v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/></svg>';

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
  const u = store.user;
  btn.classList.toggle('signed', Boolean(u));
  btn.innerHTML = u
    ? avatar(profileOf(u))
    : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5z"/></svg>';
  btn.title = u ? `เข้าระบบแล้ว: ${profileOf(u).name}` : 'เข้าสู่ระบบ';
}

function renderAccount() {
  const body = $('#account-body');
  const u = store.user;
  const msg = accountMsg ? `<p class="notice">${esc(accountMsg)}</p>` : '';
  if (!cloudConfigured) {
    body.innerHTML = `${msg}<div class="notice">ระบบสมาชิกและเพื่อนร่วมทางต้องเชื่อม Firebase ก่อน
      ใส่ค่าโปรเจกต์ใน <code>js/firebase-config.js</code> ตามขั้นตอนใน README
      ระหว่างนี้ข้อมูลทั้งหมดเก็บอยู่ในเครื่องนี้และใช้งานได้ตามปกติ</div>`;
    return;
  }
  if (u) {
    const p = profileOf(u);
    body.innerHTML = `${msg}<div class="profile">${avatar(p, 'lg')}<div><b>${esc(p.name)}</b><small>${esc(p.email || 'ไม่มีอีเมลในบัญชีนี้')}</small></div></div>
      <p class="muted small">ข้อมูลซิงก์กับบัญชีนี้ ใช้ได้ทุกเครื่องที่เข้าระบบ${p.email ? '' : ' · บัญชีที่ไม่มีอีเมลจะรับคำเชิญจากเพื่อนไม่ได้'}</p>
      <div class="menu-actions"><button class="btn danger" id="btn-signout">ออกจากระบบ</button></div>`;
    $('#btn-signout').onclick = async () => { await cloudApi.signOut(); dlgAccount.close(); toast('ออกจากระบบแล้ว'); };
    return;
  }
  body.innerHTML = `${msg}<p class="muted">เข้าสู่ระบบเพื่อซิงก์ข้อมูลข้ามเครื่อง และชวนเพื่อนร่วมทางมาดูและแก้แผนเที่ยวด้วยกัน</p>
    <div class="signin">
      <button id="btn-google" ${busy ? 'disabled' : ''}>${GOOGLE_SVG}เข้าสู่ระบบด้วย Google</button>
      <button id="btn-facebook" class="fb" ${busy ? 'disabled' : ''}>${FB_SVG}เข้าสู่ระบบด้วย Facebook</button>
    </div>
    <p class="muted small">ครั้งแรกที่เข้าระบบ สถานที่และแผนที่มีอยู่ในเครื่องนี้จะถูกอัปโหลดเข้าบัญชีให้</p>`;
  $('#btn-google').onclick = () => signIn('google');
  $('#btn-facebook').onclick = () => signIn('facebook');
}

async function signIn(kind) {
  busy = true; accountMsg = ''; renderAccount();
  try {
    const api = await cloudReady;
    if (!api) throw new Error('เชื่อมต่อระบบสมาชิกไม่ได้ (ต้องใช้อินเทอร์เน็ต)');
    await api.signIn(kind);
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
  renderAccount();
  dlgAccount.showModal();
}
$('#btn-account').addEventListener('click', () => openAccount());

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
  renderAccountButton();
  let first = true;
  unwatch = cloudApi.watch(user, {
    onPlaces: (places) => { store.setPlaces(places); if (first) { first = false; fitAll(); } },
    onPlans: (plans) => store.setPlans(plans),
    onJoined: (title) => toast(`👋 เข้าร่วมแผน “${title}” แล้ว`),
    onError: (err) => toast(cloudError(err)),
  });
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
      else if (store.isCloud) { store.useLocal(); renderAccountButton(); }
    });
  });
}
startCloud();

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.warn));
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

// Calls: rooms on Jitsi Meet (free video/voice calls in the browser or the Jitsi app),
// plus in-app banners that tell friends a call has started.
import { $, esc, avatar } from './ui.js';

const CALL_BASE = 'https://meet.jit.si/';
export const RING_MINUTES = 10; // a ring / "call started" banner shows this long
export const LIVE_MINUTES = 60; // a plan card shows "call in progress" this long

/** Link that opens a room with my name filled in. */
export const roomUrl = (room, name = '') =>
  `${CALL_BASE}${encodeURIComponent(room)}#userInfo.displayName=${encodeURIComponent(JSON.stringify(name))}`;
/** Each plan has one fixed room; plan IDs are random, so only its members know it. */
export const planRoom = (pl) => `Wanderpin-${String(pl.id).replace(/[^A-Za-z0-9]/g, '')}`;
/** A fresh random room for a call between two friends. */
export const newRoom = () =>
  `Wanderpin-${(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')}`;

export const minutesSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);
export const agoText = (iso) => {
  const m = Math.floor(minutesSince(iso));
  return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม.ที่แล้ว`;
};

/* ----- banners ----- */
const banners = new Map(); // key -> { who, text, url, joinLabel, onJoin, onDismiss }

function render() {
  const root = $('#call-banners');
  if (!root) return;
  root.innerHTML = [...banners.entries()].map(([key, b]) => `
    <div class="call-banner" data-key="${esc(key)}" role="alert">
      ${avatar(b.who || {}, 'call-face')}
      <div class="call-text">${b.text}</div>
      <a class="btn primary" href="${esc(b.url)}" target="_blank" rel="noopener" data-join>${esc(b.joinLabel || 'เข้าร่วม')}</a>
      <button class="icon-btn" data-dismiss aria-label="ปิด">✕</button>
    </div>`).join('');
}

export function showBanner(key, banner) {
  banners.set(key, banner);
  render();
}
export function hideBanner(key) {
  if (banners.delete(key)) render();
}
export const hasBanner = (key) => banners.has(key);

document.addEventListener('click', (e) => {
  const el = e.target.closest('.call-banner');
  if (!el) return;
  const key = el.dataset.key;
  const b = banners.get(key);
  if (!b) return;
  if (e.target.closest('[data-join]')) { b.onJoin?.(); hideBanner(key); }
  if (e.target.closest('[data-dismiss]')) { b.onDismiss?.(); hideBanner(key); }
});

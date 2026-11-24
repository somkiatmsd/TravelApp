// Small DOM helpers shared by the app modules.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

export const initials = (name = '?') => [...String(name).trim()][0]?.toUpperCase() || '?';

/** Round avatar: photo when there is one, otherwise the first letter of the name. */
export function avatar(m = {}, cls = '') {
  const label = m.name || m.email || '';
  const title = esc(label);
  if (m.photo) return `<img class="avatar ${cls}" src="${esc(m.photo)}" alt="" title="${title}" data-initial="${esc(initials(label))}" referrerpolicy="no-referrer">`;
  return `<span class="avatar ${cls}" title="${title}">${esc(initials(label))}</span>`;
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

/** Resize an image file to a square JPEG data URL (cover crop). */
export function resizeImage(file, size, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดไฟล์รูปไม่ได้')); };
    img.src = url;
  });
}

// Place search: Google Places (when an API key is set) with OpenStreetMap Nominatim as fallback.
// The map itself stays OpenStreetMap, so it keeps working offline.
import { googleMapsApiKey } from './maps-config.js';

export const googleSearchEnabled = Boolean(googleMapsApiKey);

// Google place types → app categories.
const TYPE_CATEGORY = [
  [['cafe', 'coffee_shop', 'tea_house'], 'คาเฟ่'],
  [['restaurant', 'food', 'bakery', 'meal_takeaway', 'bar'], 'ร้านอาหาร'],
  [['hindu_temple', 'buddhist_temple', 'place_of_worship', 'church', 'mosque', 'shrine'], 'วัด/ศาสนสถาน'],
  [['museum', 'art_gallery', 'historical_landmark', 'cultural_landmark'], 'พิพิธภัณฑ์'],
  [['shopping_mall', 'market', 'store', 'department_store', 'clothing_store'], 'ช้อปปิ้ง'],
  [['lodging', 'hotel', 'resort_hotel', 'hostel', 'campground', 'guest_house'], 'ที่พัก'],
  [['beach', 'marina', 'island'], 'ทะเล'],
  [['mountain', 'hiking_area', 'mountain_peak'], 'ภูเขา'],
  [['park', 'national_park', 'natural_feature', 'garden', 'zoo', 'botanical_garden', 'waterfall', 'lake'], 'ธรรมชาติ'],
];
export function categoryFromTypes(types = []) {
  for (const [keys, cat] of TYPE_CATEGORY) if (types.some((t) => keys.includes(t))) return cat;
  return '';
}

/* ----- Google ----- */
let googleReady = null;
function loadGoogle() {
  if (googleReady) return googleReady;
  googleReady = new Promise((resolve, reject) => {
    const cb = `__wpGmaps${Date.now()}`;
    window[cb] = () => { delete window[cb]; resolve(window.google.maps); };
    window.gm_authFailure = () => reject(new Error('Google API key ใช้ไม่ได้'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleMapsApiKey)}&loading=async&language=th&region=TH&callback=${cb}`;
    s.async = true;
    s.onerror = () => reject(new Error('โหลด Google Maps ไม่ได้'));
    document.head.appendChild(s);
  }).catch((e) => { googleReady = null; throw e; });
  return googleReady;
}

async function searchGoogle(q, near) {
  const maps = await loadGoogle();
  const { Place } = await maps.importLibrary('places');
  const req = {
    textQuery: q,
    fields: ['id', 'displayName', 'formattedAddress', 'location', 'types'],
    language: 'th',
    region: 'th',
    maxResultCount: 8,
  };
  if (near) req.locationBias = { center: near, radius: 50000 };
  const { places } = await Place.searchByText(req);
  return (places || []).map((p) => ({
    name: p.displayName || '',
    address: p.formattedAddress || '',
    lat: p.location.lat(),
    lng: p.location.lng(),
    category: categoryFromTypes(p.types),
    gmapsId: p.id,
  }));
}

/* ----- OpenStreetMap ----- */
async function searchOsm(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=th&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('search failed');
  return (await r.json()).map((it) => {
    const [first, ...rest] = it.display_name.split(',');
    return { name: it.name || first, address: rest.join(',').trim(), lat: +it.lat, lng: +it.lon, category: '' };
  });
}

/** Search places. Returns { source: 'google' | 'osm', items: [{name, address, lat, lng, category, gmapsId?}] } */
export async function searchPlaces(q, near) {
  if (googleSearchEnabled) {
    try {
      return { source: 'google', items: await searchGoogle(q, near) };
    } catch (e) {
      console.warn('Google search failed, using OpenStreetMap', e);
    }
  }
  return { source: 'osm', items: await searchOsm(q) };
}

/** Link that opens a place in Google Maps (exact place when we know its Google ID). */
export function googleMapsUrl(p) {
  const q = encodeURIComponent(p.name || `${p.lat},${p.lng}`);
  return p.gmapsId
    ? `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(p.gmapsId)}`
    : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}
export function directionsUrl(p) {
  const base = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  return p.gmapsId ? `${base}&destination_place_id=${encodeURIComponent(p.gmapsId)}` : base;
}

/* Sortaties — version légère pour iPhone.
 * Cette page ne contient aucune donnée. Elle lit les fichiers choisis sur l'appareil,
 * calcule les stats ici (rando-ski-api.js, nage-api.js) et garde le résultat dans IndexedDB.
 * La règle CSP de index.html (connect-src 'none') l'empêche d'envoyer quoi que ce soit à un serveur. */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const tick = () => new Promise(r => setTimeout(r, 0));

const OUT_RE = /\.(gpx|fit|zip|tcx)$/i;
const SKIP_DIR = /^(photos|stats|api-nage)$/i;
const PALETTE = ['#2D6E8E', '#7A4E9E', '#2F8558', '#C9820A', '#3E5FD6', '#B04A7C', '#5E7A23', '#0E8C84', '#8B6A3E', '#55606B'];
const CATEGORIES = { marche: 'Marche', rando: 'Rando', ski_rando: 'Ski de rando', ski_fond: 'Ski de fond', nage: 'Eau libre', nage_piscine: 'Piscine' };

const state = { items: new Map(), person: null, year: '', selected: null, colors: new Map(), visible: [] };

/* ---------- Formats ---------- */
const nf0 = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' });
const km = m => m == null ? '—' : m < 1000 ? nf0.format(m) + ' m' : nf1.format(m / 1000) + ' km';
const metres = m => m == null ? '—' : nf0.format(Math.round(m)) + ' m';
function hours(s) {
  if (s == null) return '—';
  let h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  if (m === 60) { h++; m = 0; }
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
function pace(s) { return s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`; }
const yearOf = t => t.start ? new Date(t.start).getFullYear() : null;
const sum = (a, f) => a.reduce((s, t) => s + (f(t) || 0), 0);
const plural = (n, one, many) => n === 1 ? one : many;
const personName = p => p || 'Non classées';
const byName = (a, b) => (a === '') - (b === '') || a.localeCompare(b, 'fr', { sensitivity: 'base' });

/* ---------- Mémoire de l'appareil ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sortaties', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sorties', { keyPath: 'key' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(mode, fn) {
    return new Promise((res, rej) => {
      if (!this.db) { res([]); return; }
      const tx = this.db.transaction('sorties', mode), out = fn(tx.objectStore('sorties'));
      tx.oncomplete = () => res(out && out.result);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  },
  all() { return this.run('readonly', st => st.getAll()); },
  put(list) { return this.run('readwrite', st => { list.forEach(x => st.put(x)); }); },
  del(keys) { return this.run('readwrite', st => { keys.forEach(k => st.delete(k)); }); },
  clear() { return this.run('readwrite', st => { st.clear(); }); }
};

/* ---------- Carte ---------- */
const BASEMAPS = {
  suisse: { label: 'Suisse', url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
    opt: { maxNativeZoom: 18, maxZoom: 19, attribution: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>' } },
  relief: { label: 'Relief', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opt: { subdomains: 'abc', maxZoom: 17, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM, © <a href="https://opentopomap.org">OpenTopoMap</a>' } }
};
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([46.8, 8.2], 7);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
const renderer = L.canvas({ padding: 0.5, tolerance: 10 });
const tracks = L.layerGroup().addTo(map), chosen = L.layerGroup().addTo(map);
let baseLayer = null;

function setBasemap(key) {
  const b = BASEMAPS[key];
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(b.url, b.opt).addTo(map);
  document.querySelectorAll('#basemaps button').forEach(x => x.setAttribute('aria-pressed', x.dataset.key === key));
  try { localStorage.setItem('sortaties-fond', key); } catch (e) {}
}
for (const [key, b] of Object.entries(BASEMAPS)) {
  const btn = el('button', '', b.label);
  btn.type = 'button'; btn.dataset.key = key;
  btn.addEventListener('click', () => setBasemap(key));
  $('#basemaps').append(btn);
}
{
  let saved = null;
  try { saved = localStorage.getItem('sortaties-fond'); } catch (e) {}
  setBasemap(BASEMAPS[saved] ? saved : 'suisse');
}

function drawTracks() {
  tracks.clearLayers();
  for (const t of state.visible) {
    if (!t.line.length) continue;
    const line = L.polyline(t.line, { renderer, color: state.colors.get(t.person) || PALETTE[0], weight: 3, opacity: .9, dashArray: t.isSwim ? '0.1 7' : null, lineCap: 'round' });
    line.on('click', () => select(t.key, false));
    tracks.addLayer(line);
  }
  drawChosen();
}
function drawChosen() {
  chosen.clearLayers();
  const t = state.items.get(state.selected);
  if (!t || !t.line.length) return;
  L.polyline(t.line, { renderer, color: '#fff', weight: 9, opacity: 1, interactive: false, lineCap: 'round' }).addTo(chosen);
  L.polyline(t.line, { renderer, color: '#D52B1E', weight: 4, opacity: 1, interactive: false, lineCap: 'round' }).addTo(chosen);
}
function fit(list) {
  const placed = list.filter(t => t.bounds);
  if (!placed.length) return;
  const b = L.latLngBounds(placed[0].bounds);
  placed.forEach(t => b.extend(t.bounds));
  map.fitBounds(b, { padding: [28, 28], maxZoom: 14 });
}

/* ---------- Affichage ---------- */
function statCell(label, value) {
  const d = el('div');
  d.append(el('dt', '', label), el('dd', '', value));
  return d;
}
function recapRow(cls, tag, cells) {
  const row = el('div', 'recap-row' + cls), nums = el('dl', 'nums');
  nums.append(...cells);
  row.append(el('span', 'tag', tag), nums);
  return row;
}
function renderRecap() {
  const box = $('#recap');
  box.replaceChildren();
  if (!state.items.size) {
    box.append(el('p', 'hint', 'Choisis ton dossier dans iCloud Drive. Tes sous-dossiers restent tels quels ; le dossier photos est ignoré.'));
    return;
  }
  const land = state.visible.filter(t => !t.isSwim), water = state.visible.filter(t => t.isSwim);
  if (!state.visible.length) box.append(el('p', 'hint', 'Aucune sortie avec ces filtres.'));
  if (land.length) box.append(recapRow('', `${nf0.format(land.length)} ${plural(land.length, 'sortie', 'sorties')} à pied et à ski`, [
    statCell('parcourus', km(sum(land, t => t.distance))), statCell('de montée', metres(sum(land, t => t.gain))), statCell('en mouvement', hours(sum(land, t => t.moving)))]));
  if (water.length) box.append(recapRow(' swim', `${nf0.format(water.length)} ${plural(water.length, 'nage', 'nages')}`, [
    statCell('dans l’eau', km(sum(water, t => t.distance))), statCell('à nager', hours(sum(water, t => t.moving)))]));
}
function renderFilters() {
  const all = [...state.items.values()];
  const people = [...new Set(all.map(t => t.person))].sort(byName);
  state.colors = new Map(people.map((p, i) => [p, PALETTE[i % PALETTE.length]]));
  if (state.person !== null && !people.includes(state.person)) state.person = null;
  const years = [...new Set(all.map(yearOf).filter(Boolean))].sort((a, b) => b - a);
  if (state.year && !years.includes(+state.year)) state.year = '';

  $('#filters').hidden = !all.length;
  const chips = $('#people');
  chips.replaceChildren();
  const chip = (label, value, color) => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', state.person === value);
    if (color) { const d = el('span', 'dot'); d.style.background = color; b.append(d); }
    b.append(label);
    b.addEventListener('click', () => { state.person = value; render(true); });
    return b;
  };
  if (people.length > 1) {
    chips.append(chip('Tout le monde', null));
    people.forEach(p => chips.append(chip(personName(p), p, state.colors.get(p))));
  }
  const sel = $('#year');
  sel.replaceChildren(new Option('Toutes', ''), ...years.map(y => new Option(String(y), String(y))));
  sel.value = state.year;
}
function renderList() {
  const box = $('#list');
  box.replaceChildren();
  for (const t of state.visible) {
    const li = el('li'), b = el('button', 'item');
    b.type = 'button';
    b.dataset.key = t.key;
    if (t.key === state.selected) b.setAttribute('aria-current', 'true');
    const bar = el('span', 'bar');
    bar.style.background = state.colors.get(t.person) || PALETTE[0];
    const mid = el('span');
    mid.append(el('span', 'item-name', t.name), el('span', 'item-date', whenText(t)));
    const num = el('span', 'item-num');
    num.append(el('span', '', km(t.distance)), el('span', '', t.isSwim ? hours(t.moving) : metres(t.gain)));
    b.append(bar, mid, num);
    b.addEventListener('click', () => select(t.key, true));
    li.append(b);
    box.append(li);
  }
}
function whenText(t) {
  return [t.start ? dateFmt.format(t.start) : 'date inconnue', t.person, CATEGORIES[t.category]].filter(Boolean).join(' · ');
}
function renderCard() {
  const t = state.items.get(state.selected), card = $('#card');
  card.hidden = !t;
  if (!t) return;
  card.classList.toggle('swim', t.isSwim);
  $('#cardName').textContent = t.name;
  $('#cardTime').textContent = hours(t.moving);
  $('#cardWhen').textContent = whenText(t);
  const cells = t.isSwim
    ? [statCell('Distance', km(t.distance)), statCell('Allure /100 m', pace(t.pace100)), statCell('En mouvement', hours(t.moving))]
    : [statCell('Distance', km(t.distance)), statCell('Montée', metres(t.gain)), statCell('Point haut', metres(t.eleMax))];
  $('#cardStats').replaceChildren(...cells);
}
function render(refit) {
  renderFilters();
  state.visible = [...state.items.values()]
    .filter(t => (state.person === null || t.person === state.person) && (!state.year || yearOf(t) === +state.year))
    .sort((a, b) => (b.start || 0) - (a.start || 0));
  if (state.selected && !state.visible.some(t => t.key === state.selected)) state.selected = null;
  renderRecap();
  renderList();
  renderCard();
  drawTracks();
  $('#dirLabel').textContent = state.items.size ? 'Actualiser le dossier' : 'Choisir le dossier';
  $('#clear').hidden = !state.items.size;
  if (refit) fit(state.visible);
}
function select(key, zoom) {
  state.selected = key;
  document.querySelectorAll('.item').forEach(b => { if (b.dataset.key === key) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  renderCard();
  drawChosen();
  const t = state.items.get(key);
  if (zoom && t && t.bounds) {
    const c = $('#card'), wide = matchMedia('(min-width: 760px)').matches;
    map.fitBounds(t.bounds, { paddingTopLeft: [24, 24], paddingBottomRight: wide ? [c.offsetWidth + 36, 24] : [24, c.offsetHeight + 20], maxZoom: 15 });
  }
  if (!zoom) { const b = document.querySelector(`.item[aria-current="true"]`); if (b) b.scrollIntoView({ block: 'nearest' }); }
}

/* ---------- Lecture des fichiers ---------- */
/* Même règle que la grande carte : la personne est le premier sous-dossier du dossier choisi.
   Si on choisit directement le dossier d'une personne, tout ce qu'il contient est à elle. */
function describe(files) {
  const entries = [];
  const nested = new Set();
  for (const file of files) {
    const seg = (file.webkitRelativePath || '').split('/').filter(Boolean);
    if (seg.slice(0, -1).some(s => SKIP_DIR.test(s)) || file.name.startsWith('.') || !OUT_RE.test(file.name)) continue;
    if (seg.length >= 3) nested.add(seg[0]);
    entries.push({ file, seg });
  }
  for (const e of entries) {
    const g = e.seg;
    e.person = g.length < 2 ? '' : nested.has(g[0]) ? (g.length >= 3 ? g[1].trim() : '') : g[0].trim();
    e.sig = `${e.file.size}:${e.file.lastModified}`;
  }
  /* Le GPX d'abord : il porte le nom de la sortie. Le ZIP de la même activité vient ensuite la compléter. */
  return entries.sort((a, b) => /\.gpx$/i.test(b.file.name) - /\.gpx$/i.test(a.file.name));
}
const srcKey = (person, name) => person + '|' + name;
function slim(s, e) {
  return {
    key: srcKey(e.person, s.id || s.file || e.file.name), person: e.person, formulas: s.formulas, srcs: { [e.file.name]: e.sig },
    name: s.name || e.file.name.replace(OUT_RE, ''), isSwim: !!s.isSwim, category: s.category || null,
    start: s.start ?? null, distance: s.distance ?? null, moving: s.moving ?? null, gain: s.gain ?? null,
    eleMax: s.eleMax ?? null, pace100: s.pace100 ?? null, line: s.line || [], bounds: s.bounds || null
  };
}
async function loadFiles(fileList, wholeFolder) {
  const entries = describe(fileList), status = $('#status');
  if (!window.SoldatisRando || !window.SoldatisNage) { status.textContent = 'Il manque rando-ski-api.js ou nage-api.js à côté de cette page.'; return; }
  if (!entries.length) { status.textContent = 'Aucune sortie trouvée ici (GPX, FIT, ZIP ou TCX).'; return; }
  const known = new Map(), formulas = new Set([SoldatisRando.FORMULAS, SoldatisNage.FORMULAS]);
  for (const t of state.items.values()) for (const [name, sig] of Object.entries(t.srcs)) known.set(srcKey(t.person, name), { t, sig });

  const fresh = new Map(), seen = new Set();
  let done = 0, failed = 0;
  for (const e of entries) {
    done++;
    const id = srcKey(e.person, e.file.name);
    seen.add(id);
    const k = known.get(id);
    if (k && k.sig === e.sig && formulas.has(k.t.formulas)) continue;
    status.textContent = `Lecture ${done} sur ${entries.length}…`;
    await tick();
    try {
      const rec = slim(await SoldatisRando.analyseSortie(e.file, e.file.name), e);
      const first = fresh.get(rec.key) || state.items.get(rec.key);
      if (first && fresh.has(rec.key)) Object.assign(first.srcs, rec.srcs);   // même activité, deux fichiers
      else fresh.set(rec.key, first ? Object.assign(rec, { srcs: Object.assign({}, first.srcs, rec.srcs) }) : rec);
    } catch (err) {
      if (err.code !== 'pool_gpx_empty') failed++;                            // le GPX de piscine est vide : le ZIP fait foi
    }
  }

  /* Dossier complet : une sortie dont aucun fichier n'existe plus disparaît. */
  const gone = [];
  if (wholeFolder) {
    const covered = new Set(entries.map(e => e.person));
    for (const t of state.items.values()) {
      if (covered.has(t.person) && !fresh.has(t.key) && !Object.keys(t.srcs).some(n => seen.has(srcKey(t.person, n)))) gone.push(t.key);
    }
  }
  gone.forEach(k => state.items.delete(k));
  fresh.forEach((t, k) => state.items.set(k, t));
  try { await DB.put([...fresh.values()]); await DB.del(gone); } catch (e) {}

  const parts = [fresh.size ? `${fresh.size} ${plural(fresh.size, 'sortie mise', 'sorties mises')} à jour.` : 'Tout est déjà à jour.'];
  if (gone.length) parts.push(`${gone.length} ${plural(gone.length, 'retirée', 'retirées')}.`);
  if (failed) parts.push(`${failed} ${plural(failed, 'fichier non lu', 'fichiers non lus')}. Si le problème vient d’iCloud, ouvre le fichier une fois dans Fichiers, puis réessaie.`);
  status.textContent = parts.join(' ');
  render(fresh.size > 0);
}

function onPick(input, wholeFolder) {
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    try { await loadFiles(files, wholeFolder); }
    catch (e) { $('#status').textContent = 'La lecture a échoué. Réessaie, ou choisis un dossier plus petit.'; }
  });
}
onPick($('#dirInput'), true);
onPick($('#fileInput'), false);

$('#year').addEventListener('change', e => { state.year = e.target.value; render(true); });
$('#cardClose').addEventListener('click', () => { state.selected = null; render(false); });
$('#clear').addEventListener('click', async () => {
  if (!confirm('Effacer les sorties gardées sur cet appareil ? Tes fichiers dans iCloud ne changent pas.')) return;
  state.items.clear();
  state.selected = null;
  try { await DB.clear(); } catch (e) {}
  $('#status').textContent = '';
  render(false);
});

/* ---------- Démarrage ---------- */
(async () => {
  try {
    await DB.open();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    (await DB.all()).forEach(t => state.items.set(t.key, t));
  } catch (e) {
    $('#status').textContent = 'Ce navigateur ne garde rien : choisis le dossier à chaque visite.';
  }
  render(state.items.size > 0);
})();
})();

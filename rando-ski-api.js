/* Soldatis — API de statistiques des sorties à pied et à ski, dans le navigateur.
 *
 * Spécification : guideline-stats-rando.md (§1 à §6 pour les calculs, §14 pour la réponse).
 * Les numéros de section dans le code renvoient à ce document.
 * Aucun serveur : ce fichier est chargé par la page (<script src="api-nage/soldatis_rando.js">),
 * fonctionne en file:// et ne dépend d'aucune bibliothèque.
 *
 *   const stats = await SoldatisRando.analyse(fichier, nomDuFichier);        // une sortie à pied ou à ski
 *   const stats = await SoldatisRando.analyseSortie(fichier, nomDuFichier);  // tout fichier : envoie les nages à SoldatisNage
 *   SoldatisRando.analyseTexte(texteGpx, nomDuFichier)                       // version synchrone, depuis le texte du GPX
 *   SoldatisRando.InputError                                                 // erreurs : e.code, e.message
 *
 * Entrée : File, Blob, ArrayBuffer, Uint8Array ou texte. Sortie : un objet (voir le guideline, §14).
 * Même entrée, même sortie : aucun état, aucun aléa.
 */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const FORMULAS = 'rando-2026-11-05';

  /* paramètres (guideline §12) */
  const P = {
    GAP: 60,               // s : trou d'enregistrement, coupe la trace (N3)
    GAP_WINDOW: 600,       // s : trou compté comme tel dans les fenêtres de 30 min
    SPIKE_DELTA: 4,        // m : écart à la médiane de 5 points (N2)
    FOOT_VMAX: 7, FOOT_VZMAX: 1.5,    // m/s : pas écarté à pied (N4)
    SKI_VMAX: 25, SKI_VZMAX: 4,       // m/s : pas écarté à ski (N4)
    N4_MARGIN: 20,         // s de chaque côté d'un pas écarté
    SMOOTH: 15,            // s : lissage de l'altitude e (§6.1)
    SMOOTH_POINTS: 3,      // ±3 points s'il n'y a pas d'heure
    GAIN_WIN: 2,           // ±2 points avant l'hystérésis du D+ (§3)
    GAIN_HYST: 3,          // m
    STEP_T: 20, STEP_D: 25,           // un pas se termine à 20 s ou 25 m (§6.2)
    GRADE: 0.03,           // montée / descente à partir de 3 %
    MOVE_V: 0.25, MOVE_VZ: 0.05,      // m/s : en mouvement
    MOVE_VMAX: 15, MOVE_DT: 300,      // §4
    VZ_WIN: 15,            // s : vz sur ±15 s (§4)
    HR_DT_CAP: 30,         // s (§5)
    SLOPE_WIN: 100,        // m (§6.3)
    CLIMB_BREAK: 10,       // m : redescente qui termine une montée (§6.4)
    PAUSE_WIN: 30, PAUSE_D: 6, PAUSE_DZ: 1.5, PAUSE_GAP: 300, PAUSE_MIN: 300,   // §6.6
    HIGH: 2000, HIGH_DT: 3600,        // §6.7
    WIN: 1800, WIN_STEP: 10,          // s : fenêtres de 30 min (§6.8)
    WIN_SHARE: 0.80, WIN_GAPS: 0.05, SHORT_STOP: 180,
    SKI_FAST: 6, SKI_FAST_SHARE: 0.05, SKI_FAST_TIME: 120,   // §6.9
    SKI_VZ90: 0.6, SKI_DOWN_MIN: 180,
    SLOPE_ABS: 9, XC_SLOPE_MAX: 20,
    ELE_MIN_SHARE: 0.80,   // §6 : part minimale de points avec altitude
    PROFILE_STEP: 25, PROFILE_MAX: 800,
    LINE_TOL: 8,           // m : simplification du tracé
    VEHICLE_WARN: 60       // s de pas directement écartés pour signaler un véhicule
  };

  const R_EARTH = 6371008.8;
  const SWIM_RE = /swim|nage|natation|schwimm|nuoto/i;
  const SKI_RE = /ski|snowboard|splitboard/i;
  const MARCHE = 'marche', RANDO = 'rando', SKI_RANDO = 'ski_rando', SKI_FOND = 'ski_fond';

  class InputError extends Error {
    constructor(code, message, status) { super(message); this.name = 'InputError'; this.code = code; this.status = status || 400; }
  }

  /* ------------------------------------------------------------------ outils */
  const rad = x => x * Math.PI / 180;
  function hav(lat1, lon1, lat2, lon2) {          // §2
    const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  /* arrondi : à l'entier le plus proche, et au pair en cas d'égalité (comme la version Python) */
  function rnd(x, d) {
    if (x == null || !isFinite(x)) return null;
    if (d) {
      const m = 10 ** d, y = x * m;
      if (y - Math.floor(y) === 0.5 && /^50*$/.test(x.toFixed(60).split('.')[1].slice(d))) return rnd(y) / m;   // égalité exacte
      return Number(x.toFixed(d));
    }
    const f = Math.floor(x), r = x - f;
    return r < 0.5 ? f : r > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
  }
  function median(a) {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  const num = s => { if (s == null) return null; const x = parseFloat(s); return isFinite(x) ? x : null; };
  function parseTime(s) {
    if (!s) return null;
    s = s.trim();
    if (!/(z|[+-]\d\d(:?\d\d)?)$/i.test(s)) s += 'Z';     // sans fuseau : UTC
    const t = Date.parse(s);
    return isFinite(t) ? t / 1000 : null;
  }
  const baseName = f => f ? String(f).split(/[\\/]/).pop() : null;
  /* premier indice dont la valeur est > x (ou >= x) dans un tableau trié */
  function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

  async function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
    if (typeof input === 'string') return new TextEncoder().encode(input);
    throw new InputError('empty', 'Entrée non lisible.');
  }
  const decodeText = u8 => new TextDecoder('utf-8').decode(u8);

  /* Douglas–Peucker sur une projection locale (mètres). Renvoie les indices gardés. */
  function simplify(pts, tol) {
    const n = pts.length;
    if (n <= 2) return pts.map((_, i) => i);
    const k = Math.cos(rad(pts[0][0]));
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = rad(pts[i][1]) * R_EARTH * k; Y[i] = rad(pts[i][0]) * R_EARTH; }
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]], tol2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const x1 = X[a], y1 = Y[a], dx = X[b] - x1, dy = Y[b] - y1, l2 = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const px = X[i] - x1, py = Y[i] - y1;
        let d2;
        if (l2 === 0) d2 = px * px + py * py;
        else { const u = Math.max(0, Math.min(1, (px * dx + py * dy) / l2)), ex = px - u * dx, ey = py - u * dy; d2 = ex * ex + ey * ey; }
        if (d2 > best) { best = d2; bi = i; }
      }
      if (best > tol2 && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    const idx = []; for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    return idx;
  }

  /* ------------------------------------------------------------------ lecture (§1) */
  const RE_BLOCK = /<(trk|rte)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g;
  const RE_PT = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  const RE_LAT = /\blat\s*=\s*["']\s*([^"']+)/, RE_LON = /\blon\s*=\s*["']\s*([^"']+)/;
  const RE_ELE = /<ele>\s*([^<]+)</, RE_TIME = /<time>\s*([^<\s]+)/;
  const RE_HR = /<(?:[\w-]+:)?hr>\s*([^<]+)</, RE_TEMP = /<(?:[\w-]+:)?atemp>\s*([^<]+)</, RE_CAD = /<(?:[\w-]+:)?cad>\s*([^<]+)</;
  const grab = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };

  function decodeXml(s) {
    s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, '&').trim();
  }
  function parsePoints(chunk) {
    const pts = [];
    RE_PT.lastIndex = 0;
    let m;
    while ((m = RE_PT.exec(chunk))) {
      const lat = num(grab(m[2], RE_LAT)), lon = num(grab(m[2], RE_LON));
      if (lat == null || lon == null || (lat === 0 && lon === 0)) continue;
      const b = m[3] || '';
      pts.push({ lat, lon, ele: num(grab(b, RE_ELE)), t: parseTime(grab(b, RE_TIME)), hr: num(grab(b, RE_HR)), temp: num(grab(b, RE_TEMP)), cad: num(grab(b, RE_CAD)) });
    }
    return pts;
  }
  function readGpx(text) {
    if (!/<gpx[\s>]/.test(text) || !/<\/gpx\s*>/.test(text)) throw new InputError('bad_gpx', 'GPX illisible ou incomplet.');
    let name = null, type = null;
    const segments = [];
    RE_BLOCK.lastIndex = 0;
    let m;
    while ((m = RE_BLOCK.exec(text))) {
      const body = m[2], cut = body.search(/<(trkseg|rtept)\b/), head = cut >= 0 ? body.slice(0, cut) : body;
      if (name == null) { const x = /<name>([\s\S]*?)<\/name>/.exec(head); if (x) name = decodeXml(x[1]); }
      if (type == null) { const x = /<type>([\s\S]*?)<\/type>/.exec(head); if (x) type = decodeXml(x[1]); }
      const parts = body.split(/<trkseg(?:\s[^>]*)?>/);
      for (const chunk of (parts.length > 1 ? parts.slice(1) : [body])) {
        const pts = parsePoints(chunk);
        if (pts.length >= 2) segments.push(pts);
      }
    }
    const meta = /<metadata[\s>][\s\S]*?<time>\s*([^<\s]+)[\s\S]*?<\/metadata>/.exec(text);
    const creator = /<gpx\b[^>]*\bcreator\s*=\s*["']([^"']*)/.exec(text);
    return { name: name || '', type: (type || '').toLowerCase(), segments, metaTime: meta ? parseTime(meta[1]) : null, creator: creator ? creator[1] : '' };
  }
  const isSwim = g => SWIM_RE.test(g.type) || (!g.type && SWIM_RE.test(g.name));   // §1 : le type, ou à défaut le nom

  /* ------------------------------------------------------------------ nettoyage (§1bis) */
  function cleanN1(segments, warnings) {          // heures strictement croissantes
    let total = 0, timed = 0;
    for (const s of segments) for (const p of s) { total++; if (p.t != null) timed++; }
    if (!(total > 0 && timed >= 0.95 * total)) {
      warnings.push('no_time');
      for (const s of segments) for (const p of s) p.t = null;
      return { segs: segments.filter(s => s.length >= 2), hasTime: false, dropped: 0 };
    }
    const segs = []; let dropped = 0, last = null;
    for (const s of segments) {
      const keep = [];
      for (const p of s) {
        if (p.t == null || (last != null && p.t <= last)) { dropped++; continue; }
        last = p.t; keep.push(p);
      }
      if (keep.length >= 2) segs.push(keep);
    }
    return { segs, hasTime: true, dropped };
  }
  function fillAltitude(seg) {                    // comble les points sans altitude par leurs voisins
    const known = [];
    seg.forEach((p, i) => { if (p.ele != null) known.push(i); });
    if (!known.length) return false;
    const first = known[0], lastK = known[known.length - 1];
    for (let i = 0; i < first; i++) seg[i].ele = seg[first].ele;
    for (let i = lastK + 1; i < seg.length; i++) seg[i].ele = seg[lastK].ele;
    for (let k = 0; k + 1 < known.length; k++) {
      const a = known[k], b = known[k + 1], va = seg[a].ele, vb = seg[b].ele;
      for (let i = a + 1; i < b; i++) seg[i].ele = va + (vb - va) * (i - a) / (b - a);
    }
    return true;
  }
  function cleanN2(values) {                      // médiane sur 5 points, sur les valeurs d'origine
    const out = values.slice(); let spikes = 0;
    for (let i = 0; i < values.length; i++) {
      const med = median(values.slice(Math.max(0, i - 2), i + 3));
      if (Math.abs(values[i] - med) > P.SPIKE_DELTA) { out[i] = med; spikes++; }
    }
    return { out, spikes };
  }

  /* ------------------------------------------------------------------ la sortie mise à plat
     run[i]  : numéro du trkseg (rien ne traverse une limite de trkseg).
     seg[i]  : numéro du segment N3 (limites de trkseg + trous de plus de 60 s).
     cum[i]  : distance §2, sans les trous.
     cum3[i] : distance avec les trous, pour les pas de §6.2.
     e[i]    : altitude lissée §6.1 (null si pas d'altitude). */
  function ranges(key, n) {
    const out = []; let a = 0;
    for (let i = 1; i <= n; i++) if (i === n || key[i] !== key[a]) { out.push([a, i]); a = i; }
    return out;
  }
  function makeTrack(segments, hasTime, hasEle) {
    const tr = { hasTime, hasEle, lat: [], lon: [], ele: [], t: [], hr: [], temp: [], cad: [], run: [], seg: [], spikes: 0, nGaps: 0, gaps: [] };
    let segId = 0;
    segments.forEach((s, r) => {
      let ele = null;
      if (hasEle) { const c = cleanN2(s.map(p => p.ele)); ele = c.out; tr.spikes += c.spikes; }
      if (r) segId++;
      s.forEach((p, i) => {
        if (i && hasTime) {
          const dt = p.t - s[i - 1].t;
          if (dt > P.GAP) { segId++; tr.nGaps++; tr.gaps.push(dt); }
        }
        tr.lat.push(p.lat); tr.lon.push(p.lon); tr.t.push(p.t); tr.ele.push(hasEle ? ele[i] : null);
        tr.hr.push(p.hr); tr.temp.push(p.temp); tr.cad.push(p.cad); tr.run.push(r); tr.seg.push(segId);
      });
    });
    const n = tr.n = tr.lat.length;
    tr.stepD = new Float64Array(n); tr.cum = new Float64Array(n); tr.cum3 = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const d = tr.run[i] === tr.run[i - 1] ? hav(tr.lat[i - 1], tr.lon[i - 1], tr.lat[i], tr.lon[i]) : 0;
      tr.stepD[i] = d;
      tr.cum3[i] = tr.cum3[i - 1] + d;
      tr.cum[i] = tr.cum[i - 1] + (tr.seg[i] === tr.seg[i - 1] ? d : 0);
    }
    tr.runs = ranges(tr.run, n); tr.segs = ranges(tr.seg, n);
    tr.e = hasEle ? smoothAltitude(tr) : null;
    return tr;
  }
  function smoothAltitude(tr) {                   // §6.1, segment N3 par segment N3
    const e = new Float64Array(tr.n), ele = tr.ele, t = tr.t;
    for (const [a, b] of tr.segs) {
      if (tr.hasTime) {
        let lo = a, hi = a, s = 0;
        for (let i = a; i < b; i++) {
          while (hi < b && t[hi] - t[i] <= P.SMOOTH) { s += ele[hi]; hi++; }
          while (t[i] - t[lo] > P.SMOOTH) { s -= ele[lo]; lo++; }
          e[i] = s / (hi - lo);
        }
      } else {
        const w = P.SMOOTH_POINTS;
        for (let i = a; i < b; i++) {
          let s = 0, c = 0;
          for (let k = Math.max(a, i - w); k < Math.min(b, i + w + 1); k++) { s += ele[k]; c++; }
          e[i] = s / c;
        }
      }
    }
    return e;
  }
  function at(tr, arr, t) {                       // valeur de arr à l'instant t (interpolation linéaire)
    const ts = tr.t;
    if (t <= ts[0]) return arr[0];
    if (t >= ts[tr.n - 1]) return arr[tr.n - 1];
    const j = upperBound(ts, t), i = j - 1;
    return arr[i] + (arr[j] - arr[i]) * (t - ts[i]) / (ts[j] - ts[i]);
  }

  /* ------------------------------------------------------------------ §3 dénivelé */
  function gainLoss(tr) {
    let gain = 0, loss = 0;
    const w = P.GAIN_WIN;
    for (const [a, b] of tr.segs) {
      if (b - a < 2) continue;
      const n = b - a, sm = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - w); k < Math.min(n, i + w + 1); k++) { s += tr.ele[a + k]; c++; }
        sm[i] = s / c;
      }
      let ref = sm[0];
      for (let i = 1; i < n; i++) {
        const d = sm[i] - ref;
        if (d >= P.GAIN_HYST) { gain += d; ref = sm[i]; }
        else if (d <= -P.GAIN_HYST) { loss -= d; ref = sm[i]; }
      }
    }
    return [gain, loss];
  }

  /* ------------------------------------------------------------------ §4 et §5 */
  function movingTime(tr) {
    if (!tr.hasTime) return null;
    let total = 0;
    for (let i = 1; i < tr.n; i++) {
      if (tr.run[i] !== tr.run[i - 1]) continue;
      const dt = tr.t[i] - tr.t[i - 1];
      if (dt <= 0 || dt > P.MOVE_DT) continue;
      const d = tr.stepD[i], dz = tr.hasEle ? tr.ele[i] - tr.ele[i - 1] : 0;
      const v3 = Math.hypot(d, dz) / dt;
      if (v3 >= P.MOVE_VMAX) continue;
      let vz = 0;
      if (tr.hasEle) {
        const tm = (tr.t[i] + tr.t[i - 1]) / 2;
        vz = (at(tr, tr.e, tm + P.VZ_WIN) - at(tr, tr.e, tm - P.VZ_WIN)) / (2 * P.VZ_WIN);
      }
      if (v3 >= P.MOVE_V || Math.abs(vz) >= P.MOVE_VZ) total += dt;
    }
    return total;
  }
  function hrSums(tr, a, b) {                     // somme pondérée du pouls entre les points a et b (§5)
    let s = 0, w = 0;
    for (let i = a + 1; i <= b; i++) {
      const h1 = tr.hr[i - 1], h2 = tr.hr[i];
      if (!h1 || !h2 || tr.run[i] !== tr.run[i - 1]) continue;
      const dt = tr.t[i] - tr.t[i - 1];
      if (dt > 0) { const x = Math.min(dt, P.HR_DT_CAP); s += (h1 + h2) / 2 * x; w += x; }
    }
    return [s, w];
  }

  /* ------------------------------------------------------------------ §6.2 pas */
  function buildSteps(tr) {
    const steps = [];
    for (const [a, b] of tr.runs) {
      let i = a;
      while (i < b - 1) {
        let j = i + 1;
        while (j < b - 1 && tr.t[j] - tr.t[i] < P.STEP_T && tr.cum3[j] - tr.cum3[i] < P.STEP_D) j++;
        steps.push({ a: i, b: j, dt: tr.t[j] - tr.t[i], dd: tr.cum3[j] - tr.cum3[i], de: tr.e[j] - tr.e[i], cls: null });
        i = j;
      }
    }
    return steps;
  }
  /* Donne sa classe X, N, S, U, D ou F à chaque pas. Renvoie les intervalles écartés. */
  function classify(tr, steps, vmax, vzmax) {
    const merged = []; let direct = 0;
    for (const s of steps) {
      if (s.dt <= P.GAP_WINDOW && (s.dd / s.dt > vmax || Math.abs(s.de) / s.dt > vzmax)) {
        const lo = tr.t[s.a] - P.N4_MARGIN, hi = tr.t[s.b] + P.N4_MARGIN, m = merged[merged.length - 1];
        if (m && lo <= m[1]) m[1] = Math.max(m[1], hi); else merged.push([lo, hi]);
        direct += s.dt;
      }
    }
    const starts = merged.map(m => m[0]);
    const excluded = (t0, t1) => { const k = lowerBound(starts, t1) - 1; return k >= 0 && merged[k][1] > t0; };
    let nExcl = 0;
    for (const s of steps) {
      if (s.dt > P.GAP_WINDOW) s.cls = 'X';
      else if (excluded(tr.t[s.a], tr.t[s.b])) { s.cls = 'N'; nExcl++; }
      else if (!(Math.hypot(s.dd, s.de) / s.dt >= P.MOVE_V || Math.abs(s.de) / s.dt >= P.MOVE_VZ)) s.cls = 'S';
      else {
        const g = s.dd > 0 ? s.de / s.dd : (s.de < 0 ? -Infinity : Infinity);
        s.cls = g >= P.GRADE ? 'U' : (g <= -P.GRADE ? 'D' : 'F');
      }
    }
    return { merged, direct, nExcl };
  }
  function pointMask(tr, merged) {                // points écartés par N4, marge comprise
    const mask = new Uint8Array(tr.n);
    if (tr.hasTime) for (const [lo, hi] of merged) {
      const end = upperBound(tr.t, hi);
      for (let i = lowerBound(tr.t, lo); i < end; i++) mask[i] = 1;
    }
    return mask;
  }
  function directionStats(tr, steps, cls) {
    let gain = 0, time = 0, dist = 0, hs = 0, hw = 0;
    for (const s of steps) {
      if (s.cls !== cls) continue;
      gain += Math.abs(s.de); time += s.dt; dist += s.dd;
      const [a, b] = hrSums(tr, s.a, s.b);
      hs += a; hw += b;
    }
    return [gain, time, dist, hs, hw];
  }

  /* ------------------------------------------------------------------ §6.3 pente maximale */
  function slopeExtremes(tr, mask) {
    const bad = new Int32Array(tr.n + 1);
    for (let i = 0; i < tr.n; i++) bad[i + 1] = bad[i] + mask[i];
    let gmax = null, gmin = null;
    for (const [a, b] of tr.segs) {
      let i0 = a;
      for (let j = a + 1; j < b; j++) {
        while (i0 + 1 < j && tr.cum[j] - tr.cum[i0 + 1] >= P.SLOPE_WIN) i0++;
        const dd = tr.cum[j] - tr.cum[i0];
        if (dd < P.SLOPE_WIN || bad[j + 1] - bad[i0]) continue;
        const g = (tr.e[j] - tr.e[i0]) / dd * 100;
        if (gmax == null || g > gmax) gmax = g;
        if (gmin == null || g < gmin) gmin = g;
      }
    }
    return [gmax, gmin];
  }

  /* ------------------------------------------------------------------ §6.4 */
  function biggestClimb(tr) {
    let best = 0, bestT = null;
    const e = tr.e;
    for (const [a, b] of tr.segs) {
      let lo = a, hi = a;
      const close = () => { const c = e[hi] - e[lo]; if (c > best) { best = c; bestT = tr.hasTime ? tr.t[hi] - tr.t[lo] : null; } };
      for (let k = a + 1; k < b; k++) {
        if (e[k] > e[hi]) hi = k;
        if (e[k] < e[lo] && hi <= lo) { lo = k; hi = k; }
        else if (e[hi] - e[k] > P.CLIMB_BREAK) { close(); lo = k; hi = k; }
      }
      close();
    }
    return [best, bestT];
  }

  /* ------------------------------------------------------------------ §6.6 */
  function pauses(tr) {
    let count = 0, longest = 0;
    if (!tr.hasTime) return [count, longest];
    for (const [a, b] of tr.runs) {
      let run = 0, i = a;
      const flush = () => { if (run >= P.PAUSE_MIN) { count++; longest = Math.max(longest, run); } run = 0; };
      while (i < b - 1) {
        let j = i + 1;
        while (j < b - 1 && tr.t[j] - tr.t[i] < P.PAUSE_WIN) j++;
        const dt = tr.t[j] - tr.t[i];
        let still = hav(tr.lat[i], tr.lon[i], tr.lat[j], tr.lon[j]) < P.PAUSE_D;
        if (still && tr.hasEle) {
          let mn = Infinity, mx = -Infinity;
          for (let k = i; k <= j; k++) { if (tr.e[k] < mn) mn = tr.e[k]; if (tr.e[k] > mx) mx = tr.e[k]; }
          still = mx - mn < P.PAUSE_DZ;
        }
        if (still || dt > P.PAUSE_GAP) run += dt; else flush();
        i = j;
      }
      flush();
    }
    return [count, longest];
  }

  /* ------------------------------------------------------------------ §6.7 */
  function aboveHigh(tr) {
    let total = 0;
    for (let i = 1; i < tr.n; i++) {
      if (tr.run[i] === tr.run[i - 1] && tr.e[i] >= P.HIGH && tr.e[i - 1] >= P.HIGH) total += Math.min(tr.t[i] - tr.t[i - 1], P.HIGH_DT);
    }
    return total;
  }

  /* ------------------------------------------------------------------ §6.8 et §6.10 fenêtres de 30 min */
  /* Une classe par seconde de la sortie. Les arrêts deviennent « s » (petit) ou « L » (long). */
  function paintSeconds(tr, steps) {
    const t0 = tr.t[0], total = Math.ceil(tr.t[tr.n - 1] - t0), sec = new Array(total).fill('?');
    for (const s of steps) {
      const end = Math.min(total, Math.ceil(tr.t[s.b] - t0));
      for (let k = Math.trunc(tr.t[s.a] - t0); k < end; k++) sec[k] = s.cls;
    }
    const runsOf = (ch, name) => {
      let k = 0;
      while (k < total) {
        if (sec[k] !== ch) { k++; continue; }
        let m = k;
        while (m < total && sec[m] === ch) m++;
        sec.fill(name(m - k), k, m);
        k = m;
      }
    };
    runsOf('?', len => len > P.GAP_WINDOW ? 'X' : 'S');   // temps entre deux trkseg
    runsOf('S', len => len <= P.SHORT_STOP ? 's' : 'L');  // suites d'arrêts
    return sec;
  }
  function prefix(sec, ch) {
    const out = new Int32Array(sec.length + 1);
    for (let i = 0; i < sec.length; i++) out[i + 1] = out[i] + (sec[i] === ch ? 1 : 0);
    return out;
  }
  function pick(cands) {                          // par valeur décroissante, sans chevauchement (§6.8, point 4)
    const chosen = [];
    for (const c of [...cands].sort((x, y) => y[0] - x[0] || x[1] - y[1])) {
      if (chosen.every(o => Math.abs(c[1] - o[1]) >= P.WIN)) chosen.push(c);
    }
    return chosen;
  }
  function windows(tr, sec) {
    const w = P.WIN, out = { up: [], down: [], flat: [] };
    if (sec.length < w) return out;
    const pc = { up: prefix(sec, 'U'), down: prefix(sec, 'D'), flat: prefix(sec, 'F'), stop: prefix(sec, 's'), n: prefix(sec, 'N'), x: prefix(sec, 'X') };
    const count = (key, a) => pc[key][a + w] - pc[key][a];
    const t0 = tr.t[0], need = P.WIN_SHARE * w;
    for (let a = 0; a <= sec.length - w; a += P.WIN_STEP) {
      if (count('n', a) || count('x', a) >= P.WIN_GAPS * w) continue;
      const stop = count('stop', a);
      for (const key of ['up', 'down', 'flat']) {
        if (count(key, a) + stop < need) continue;
        let v;
        if (key === 'flat') v = (at(tr, tr.cum, t0 + a + w) - at(tr, tr.cum, t0 + a)) / 0.5 / 1000;
        else { v = (at(tr, tr.e, t0 + a + w) - at(tr, tr.e, t0 + a)) / 0.5; if (key === 'down') v = -v; }
        if (v > 0) out[key].push([v, a]);
      }
    }
    return { up: pick(out.up), down: pick(out.down), flat: pick(out.flat) };
  }
  function summary(chosen, digits) {
    if (!chosen.length) return null;
    const vals = chosen.map(c => c[0]);
    return { best: rnd(Math.max(...vals), digits), mean: rnd(vals.reduce((s, x) => s + x, 0) / vals.length, digits), n: vals.length };
  }
  function makeBlocks(tr, wins) {
    const blocks = [], t0 = tr.t[0];
    for (const [key, digits] of [['up', 0], ['down', 0], ['flat', 1]]) {
      wins[key].forEach(([v, a], k) => {                // pick trie par valeur : la première est la meilleure
        blocks.push({ type: key, tStart: a, tEnd: a + P.WIN, dStart: rnd(at(tr, tr.cum, t0 + a)), dEnd: rnd(at(tr, tr.cum, t0 + a + P.WIN)), value: rnd(v, digits), best: k === 0 });
      });
    }
    return blocks.sort((x, y) => x.tStart - y.tStart);
  }

  /* ------------------------------------------------------------------ §6.9 catégorie */
  function skiDetection(steps, gtype) {
    const down = steps.filter(s => s.cls === 'D');
    let tdown = 0, fast = 0;
    for (const s of down) { tdown += s.dt; if (s.dd / s.dt > P.SKI_FAST) fast += s.dt; }
    let p90 = null;
    if (tdown > 0) {
      let acc = 0;
      for (const [v, dt] of down.map(s => [Math.abs(s.de) / s.dt, s.dt]).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
        acc += dt;
        if (acc >= 0.9 * tdown) { p90 = v; break; }
      }
    }
    const why = { descentTime: rnd(tdown), descentFastShare: tdown ? rnd(fast / tdown, 3) : null, descentFastTime: rnd(fast), vzDownP90: rnd(p90, 2) };
    if (SKI_RE.test(gtype || '')) return ['type', why];
    if (tdown >= P.SKI_DOWN_MIN) {
      if (fast / tdown >= P.SKI_FAST_SHARE && fast >= P.SKI_FAST_TIME) return ['speed', why];
      if (p90 != null && p90 >= P.SKI_VZ90) return ['descent_rate', why];
    }
    return [null, why];
  }
  function categoryOf(ski, slopeAbs, slopeMax) {
    if (slopeAbs == null) return ski ? SKI_RANDO : null;
    if (ski) return slopeAbs < P.SLOPE_ABS && (slopeMax == null || slopeMax < P.XC_SLOPE_MAX) ? SKI_FOND : SKI_RANDO;
    return slopeAbs < P.SLOPE_ABS ? MARCHE : RANDO;
  }

  /* ------------------------------------------------------------------ sortie */
  function makeProfile(tr) {                      // [distance, altitude lissée, heure (s), lat, lon], ≤ 800 points
    let pts = [], last = -Infinity;
    for (let i = 0; i < tr.n; i++) {
      const end = i === tr.n - 1 || tr.seg[i + 1] !== tr.seg[i];
      if (tr.cum[i] - last >= P.PROFILE_STEP || end) { pts.push(i); last = tr.cum[i]; }
    }
    if (pts.length > P.PROFILE_MAX) {
      const m = P.PROFILE_MAX, step = (pts.length - 1) / (m - 1), src = pts;
      pts = [];
      for (let k = 0; k < m; k++) pts.push(src[rnd(k * step)]);
    }
    return pts.map(i => [rnd(tr.cum[i]), tr.e ? rnd(tr.e[i], 1) : null, tr.hasTime ? rnd(tr.t[i]) : null, rnd(tr.lat[i], 6), rnd(tr.lon[i], 6)]);
  }
  function makeLines(tr) {                        // une polyligne par segment N3 : aucun trait à travers un trou
    const out = [];
    for (const [a, b] of tr.segs) {
      if (b - a < 2) continue;
      const ll = [];
      for (let i = a; i < b; i++) ll.push([tr.lat[i], tr.lon[i]]);
      out.push(simplify(ll, P.LINE_TOL).map(k => [rnd(ll[k][0], 6), rnd(ll[k][1], 6)]));
    }
    return out;
  }
  function garminId(filename, creator) {          // §13.1 : activity_<id>.gpx, sur un fichier écrit par Garmin
    if (!filename || !/garmin/i.test(creator)) return null;
    const m = /(\d{6,})/.exec(baseName(filename));
    return m ? m[1] : null;
  }
  function side(gain, time, dist, hs, hw, slope, vam, key) {
    return {
      [key]: rnd(gain), time: rnd(time), dist: rnd(dist),
      hrAvg: hw ? rnd(hs / hw) : null, hrTime: rnd(hw),
      slopeAvg: dist ? rnd(gain / dist * 100, 1) : null,
      slopeMax: rnd(slope, 1),
      angleMax: slope != null ? rnd(Math.atan(slope / 100) * 180 / Math.PI, 1) : null,
      vzCum: time ? rnd(gain / time * 3600) : null,
      vam30: vam
    };
  }

  function analyseGpx(g, filename) {
    if (!g.segments.length) throw new InputError('no_points', 'GPX sans points.', 422);
    const warnings = [];
    const n1 = cleanN1(g.segments, warnings), hasTime = n1.hasTime;
    let segs = n1.segs;
    if (!segs.length) throw new InputError('no_points', 'Aucun point exploitable dans le fichier.', 422);

    let total = 0, withEle = 0;
    for (const s of segs) for (const p of s) { total++; if (p.ele != null) withEle++; }
    const hasEle = withEle >= P.ELE_MIN_SHARE * total;
    if (hasEle) segs = segs.filter(fillAltitude);      // un trkseg entier sans altitude est retiré
    else warnings.push('no_altitude');

    const tr = makeTrack(segs, hasTime, hasEle);
    const distance = tr.cum[tr.n - 1];
    const [gain, loss] = hasEle ? gainLoss(tr) : [null, null];
    const moving = movingTime(tr);
    const slopeAbs = hasEle && distance > 0 ? (gain + loss) / distance * 100 : null;

    /* catégorie, puis N4 avec les seuils de la catégorie (§14 : « la catégorie avant N4 »).
       Passe 1 : seuils ski, les plus larges, pour ne pas effacer la descente qu'on cherche à reconnaître. */
    let steps = [], merged = [], direct = 0, nExcl = 0, skiBy = null, why = {};
    if (hasTime && hasEle) {
      steps = buildSteps(tr);
      merged = classify(tr, steps, P.SKI_VMAX, P.SKI_VZMAX).merged;
      [skiBy, why] = skiDetection(steps, g.type);
    } else if (SKI_RE.test(g.type || '')) skiBy = 'type';
    const [gmax1, gmin1] = hasEle ? slopeExtremes(tr, pointMask(tr, merged)) : [null, null];
    const slopePeak = gmax1 != null ? Math.max(Math.abs(gmax1), Math.abs(gmin1)) : null;
    const category = categoryOf(!!skiBy, slopeAbs, slopePeak);

    /* passe 2 : seuils définitifs */
    const ski = category === SKI_RANDO || category === SKI_FOND;
    if (steps.length) ({ merged, direct, nExcl } = classify(tr, steps, ski ? P.SKI_VMAX : P.FOOT_VMAX, ski ? P.SKI_VZMAX : P.FOOT_VZMAX));
    const [gmax, gmin] = hasEle ? slopeExtremes(tr, pointMask(tr, merged)) : [null, null];

    let up = null, down = null, wins = { up: [], down: [], flat: [] };
    if (hasTime && hasEle && tr.t[tr.n - 1] > tr.t[0]) wins = windows(tr, paintSeconds(tr, steps));
    if (hasEle) {
      const none = [null, null, null, null, null];     // sans heure, pas de pas (§14)
      up = side(...(steps.length ? directionStats(tr, steps, 'U') : none), gmax != null && gmax > 0 ? gmax : null, summary(wins.up, 0), 'gain');
      down = side(...(steps.length ? directionStats(tr, steps, 'D') : none), gmin != null && gmin < 0 ? -gmin : null, summary(wins.down, 0), 'loss');
    }

    const [climb, climbT] = hasEle ? biggestClimb(tr) : [null, null];
    const [nPauses, pauseMax] = pauses(tr);
    const duration = hasTime ? tr.t[tr.n - 1] - tr.t[0] : null;
    const [hs, hw] = hasTime ? hrSums(tr, 0, tr.n - 1) : [0, 0];
    const hrs = tr.hr.filter(h => h), temps = tr.temp.filter(x => x != null), cads = tr.cad.filter(c => c > 0);
    let din = null;
    if (hasEle && distance > 0) {
      const h = distance / 1000 / 4, v = gain / 300 + loss / 500;
      din = (Math.max(h, v) + Math.min(h, v) / 2) * 3600;
    }

    for (const dt of tr.gaps) if (dt > P.GAP_WINDOW) warnings.push(`gap_${rnd(dt / 60)}min`);
    if (direct >= P.VEHICLE_WARN) warnings.push('vehicle_excluded');
    if (skiBy === 'speed' || skiBy === 'descent_rate') warnings.push('category_from_speed');   // §6.9 ne sépare pas le ski d'un véhicule ou d'un vélo

    const gid = garminId(filename, g.creator), base = baseName(filename);
    let eleMax = -Infinity, eleMin = Infinity;
    if (hasEle) for (const x of tr.ele) { if (x > eleMax) eleMax = x; if (x < eleMin) eleMin = x; }
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (let i = 0; i < tr.n; i++) {
      if (tr.lat[i] < la0) la0 = tr.lat[i]; if (tr.lat[i] > la1) la1 = tr.lat[i];
      if (tr.lon[i] < lo0) lo0 = tr.lon[i]; if (tr.lon[i] > lo1) lo1 = tr.lon[i];
    }
    return {
      schema: SCHEMA, formulas: FORMULAS, file: base, id: gid ? 'activity_' + gid : base, garminId: gid,
      name: g.name || (base ? base.replace(/\.gpx$/i, '') : 'Sans nom'),
      gpxType: g.type, isSwim: false, category,
      categoryWhy: Object.assign(why, { slopeAbs: rnd(slopeAbs, 1), slopeMaxAbs: rnd(slopePeak, 1), skiBy }),
      start: hasTime ? rnd(tr.t[0] * 1000) : (g.metaTime ? rnd(g.metaTime * 1000) : null),
      end: hasTime ? rnd(tr.t[tr.n - 1] * 1000) : null,
      distance: rnd(distance), duration: rnd(duration),
      moving: moving ? rnd(moving) : null,
      avgSpeedKmh: moving ? rnd(distance / moving * 3.6, 1) : null,
      eleMax: hasEle ? rnd(eleMax, 1) : null, eleMin: hasEle ? rnd(eleMin, 1) : null,
      gain: rnd(gain), loss: rnd(loss),
      hrAvg: hw ? rnd(hs / hw) : null, hrMax: hrs.length ? rnd(Math.max(...hrs)) : null,
      tempAvg: temps.length ? rnd(median(temps), 1) : null,
      cadAvg: cads.length ? rnd(cads.reduce((s, x) => s + x, 0) / cads.length) : null,
      up, down, flat30: summary(wins.flat, 1),
      din: rnd(din), pace: din && moving ? rnd((din - moving) / din, 3) : null,
      pauses: hasTime ? { count: nPauses, max: rnd(pauseMax), total: duration && moving ? rnd(Math.max(0, duration - moving)) : null } : null,
      above2000: hasEle && hasTime ? rnd(aboveHigh(tr)) : null,
      climbMax: hasEle ? { gain: rnd(climb), time: rnd(climbT) } : null,
      blocks: hasTime && hasEle ? makeBlocks(tr, wins) : [],
      profile: makeProfile(tr), line: makeLines(tr), bounds: [[la0, lo0], [la1, lo1]],
      cleaning: { spikes: tr.spikes, gaps: tr.nGaps, excludedSteps: nExcl, droppedPoints: n1.dropped },
      warnings
    };
  }

  /* ------------------------------------------------------------------ points d'entrée */
  /* Depuis le texte d'un GPX, sans attendre. Une nage lève InputError('not_a_hike'). */
  function analyseTexte(text, filename) {
    if (!text) throw new InputError('empty', 'Fichier vide.');
    const g = readGpx(text);
    if (isSwim(g)) throw new InputError('not_a_hike', "Ce GPX est une nage : utiliser SoldatisNage.analyse ou analyseSortie.", 422);
    return analyseGpx(g, filename);
  }
  async function analyse(input, filename) {
    const u8 = await toBytes(input);
    if (!u8.length) throw new InputError('empty', 'Fichier vide.');
    return analyseTexte(decodeText(u8), filename);
  }
  /* Tout type de fichier : un GPX à pied ou à ski reste ici, le reste (nage, FIT, ZIP, TCX) va à SoldatisNage. */
  async function analyseSortie(input, filename) {
    const u8 = await toBytes(input);
    if (!u8.length) throw new InputError('empty', 'Fichier vide.');
    if (decodeText(u8.subarray(0, 4000)).includes('<gpx')) {
      const g = readGpx(decodeText(u8));
      if (!isSwim(g)) return analyseGpx(g, filename);
    }
    const nage = root.SoldatisNage;
    if (!nage) throw new InputError('nage_missing', 'soldatis_nage.js doit être chargé par la page pour les nages.', 500);
    return nage.analyse(u8, filename);
  }

  const api = { analyse, analyseSortie, analyseTexte, InputError, P, SCHEMA, FORMULAS, _readGpx: readGpx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoldatisRando = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
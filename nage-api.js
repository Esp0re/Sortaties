/* Soldatis — API de statistiques de natation (eau libre et piscine), dans le navigateur.
 *
 * Spécification : guideline-stats-nage.md (version du 5 novembre 2026).
 * Aucun serveur : ce fichier est chargé par la page (<script src="api-nage/soldatis_nage.js">),
 * fonctionne en file:// et ne dépend d'aucune bibliothèque.
 *
 *   const stats = await SoldatisNage.analyse(fichier, nomDuFichier);   // File, Blob, ArrayBuffer ou Uint8Array
 *   SoldatisNage.isSwimFile(nom)          // .gpx / .fit / .zip / .tcx candidats
 *   SoldatisNage.InputError               // erreurs : e.code, e.message
 *
 * Entrées (reconnues au contenu) : GPX (eau libre), FIT ou ZIP « Exporter l'original » de Garmin Connect
 * (piscine ou eau libre), TCX (repli). Sortie : un objet identique à la réponse JSON décrite dans le guideline.
 * Navigateurs : Chrome 80+, Edge 80+, Safari 16.4+, Firefox 113+ (DecompressionStream pour les ZIP).
 */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const FORMULAS = 'nage-2026-11-05';

  /* paramètres (guideline §8 et §10.6) */
  const P = {
    SMOOTH_WIN: 12, SMOOTH_RATIO: 1.10, GAP: 15, VMAX: 3.0, MOVE_V: 0.25,
    BEST: [100, 500, 1000], BEST_MAX_REMOVED: 0.10, STROKE_DT: 10, HR_DT_CAP: 30,
    PROFILE_STEP: 25, LINE_TOL: 8, JUMPS_WARN: 5, REMOVED_WARN: 0.20,
    POOL_ANOM: 0.30, POOL_TOL: 0.20, POOL_BRIDGE: 30, POOL_MIN_LENGTHS: 6, POOL_PAUSE: 1.30,
    REST_MIN: 5, PULSE_BIN: 15
  };

  const SWIM_RE = /swim|nage|natation|schwimm|nuoto/i;
  const STYLE_FR = { freestyle: 'crawl', backstroke: 'dos', breaststroke: 'brasse', butterfly: 'papillon', drill: 'éducatif', mixed: 'mixte', im: '4 nages' };
  const R_EARTH = 6371008.8;

  class InputError extends Error {
    constructor(code, message, status) { super(message); this.name = 'InputError'; this.code = code; this.status = status || 400; }
  }

  /* ------------------------------------------------------------------ outils */
  const rad = x => x * Math.PI / 180;
  function hav(lat1, lon1, lat2, lon2) {
    const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const r0 = x => (x == null || !isFinite(x)) ? null : Math.round(x);
  const r1 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 10) / 10;
  const r2 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;
  const ms = t => t == null ? null : Math.round(t * 1000);
  const sum = a => a.reduce((s, x) => s + x, 0);
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function parseTime(s) {
    if (!s) return null;
    const t = Date.parse(s.trim());
    return isFinite(t) ? t / 1000 : null;
  }
  const num = s => { if (s == null) return null; const x = parseFloat(s); return isFinite(x) ? x : null; };
  function baseName(f) { return f ? String(f).split(/[\\/]/).pop() : null; }
  function garminIdFrom(f) { const m = /(\d{6,})/.exec(baseName(f) || ''); return m ? m[1] : null; }

  async function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
    if (typeof input === 'string') return new TextEncoder().encode(input);
    throw new InputError('empty', 'Entrée non lisible.');
  }
  const decodeText = u8 => new TextDecoder('utf-8').decode(u8);

  /* ------------------------------------------------------------------ formats */
  function sniff(u8) {
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4) return 'zip';
    if (u8.length >= 12 && u8[8] === 0x2e && u8[9] === 0x46 && u8[10] === 0x49 && u8[11] === 0x54) return 'fit';
    const head = decodeText(u8.subarray(0, 4000));
    if (head.includes('<gpx')) return 'gpx';
    if (head.includes('<TrainingCenterDatabase')) return 'tcx';
    throw new InputError('unknown_format', 'Format non reconnu : envoyer un GPX, un FIT, un ZIP (export original Garmin) ou un TCX.');
  }

  /* GPX — lecture par expressions régulières (comme le site), sans DOM */
  const RE_PT = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  const attr = (s, k) => { const m = new RegExp('\\b' + k + '\\s*=\\s*["\']([^"\']+)').exec(s); return m ? num(m[1]) : null; };
  const tagVal = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };
  const RE_TIME = /<time>\s*([^<\s]+)\s*<\/time>/, RE_HR = /<(?:\w+:)?hr>\s*([^<]+)</, RE_TEMP = /<(?:\w+:)?(?:atemp|wtemp)>\s*([^<]+)</, RE_CAD = /<(?:\w+:)?cad>\s*([^<]+)</;

  function parsePts(chunk) {
    const pts = [];
    RE_PT.lastIndex = 0;
    let m;
    while ((m = RE_PT.exec(chunk))) {
      const lat = attr(m[2], 'lat'), lon = attr(m[2], 'lon');
      if (lat == null || lon == null || (lat === 0 && lon === 0)) continue;
      const b = m[4] || '';
      pts.push({ lat, lon, t: parseTime(tagVal(b, RE_TIME)), hr: num(tagVal(b, RE_HR)), temp: num(tagVal(b, RE_TEMP)), cad: num(tagVal(b, RE_CAD)) });
    }
    return pts;
  }
  function readGpx(u8) {
    const text = decodeText(u8);
    const trkAt = text.search(/<trk[\s>]/), rteAt = text.search(/<rte[\s>]/);
    const head = trkAt >= 0 ? trkAt : rteAt;
    const first = (tag) => { if (head < 0) return ''; const m = new RegExp('<' + tag + '>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</' + tag + '>').exec(text.slice(head)); return m ? m[1].trim() : ''; };
    const name = first('name').replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const type = first('type').toLowerCase();
    const meta = /<metadata>[\s\S]*?<time>\s*([^<\s]+)/.exec(text.slice(0, 3000));
    let segments = [];
    if (trkAt >= 0) {
      const parts = text.slice(trkAt).split(/<trkseg[\s>/]/);
      for (let i = 1; i < parts.length; i++) { const p = parsePts(parts[i]); if (p.length) segments.push(p); }
    } else if (rteAt >= 0) {
      const p = parsePts(text.slice(rteAt)); if (p.length) segments.push(p);
    }
    return { name, type, segments, metaTime: meta ? parseTime(meta[1]) : null };
  }

  function readTcx(u8) {
    const text = decodeText(u8);
    const sport = (/<Activity\s+Sport="([^"]*)"/.exec(text) || [])[1] || '';
    const laps = [], points = [];
    const RE_LAP = /<Lap\s+StartTime="([^"]+)"[^>]*>([\s\S]*?)<\/Lap>/g;
    let m;
    while ((m = RE_LAP.exec(text))) {
      const body = m[2], cut = body.search(/<Track>/), top = cut >= 0 ? body.slice(0, cut) : body;
      laps.push({
        start: parseTime(m[1]),
        time: num(tagVal(top, /<TotalTimeSeconds>([^<]+)</)),
        dist: num(tagVal(top, /<DistanceMeters>([^<]+)</)),
      });
      const RE_TP = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
      let q;
      while ((q = RE_TP.exec(body))) {
        const b = q[1];
        points.push({
          t: parseTime(tagVal(b, /<Time>([^<]+)</)),
          lat: num(tagVal(b, /<LatitudeDegrees>([^<]+)</)), lon: num(tagVal(b, /<LongitudeDegrees>([^<]+)</)),
          hr: num(tagVal(b, /<HeartRateBpm>\s*<Value>([^<]+)</)), cad: num(tagVal(b, /<Cadence>([^<]+)</)), temp: null
        });
      }
    }
    return { sport: sport.toLowerCase(), laps, points };
  }

  /* ZIP — répertoire central + DecompressionStream('deflate-raw') */
  async function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new InputError('bad_zip', 'ZIP illisible.');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new InputError('bad_zip', 'ZIP illisible (répertoire central).');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = decodeText(u8.subarray(p + 46, p + 46 + nl));
      entries.push({ name, method, csize, usize, off });
      p += 46 + nl + xl + cl;
    }
    for (const ext of ['.fit', '.gpx', '.tcx']) {
      const e = entries.find(x => x.name.toLowerCase().endsWith(ext) && !x.name.endsWith('/'));
      if (!e) continue;
      if (e.usize > 100 * 1024 * 1024) throw new InputError('too_big', 'Fichier trop gros dans le ZIP.');
      const lnl = dv.getUint16(e.off + 26, true), lxl = dv.getUint16(e.off + 28, true);
      const data = u8.subarray(e.off + 30 + lnl + lxl, e.off + 30 + lnl + lxl + e.csize);
      if (e.method === 0) return { data, name: e.name };
      if (e.method !== 8) throw new InputError('bad_zip', 'Compression ZIP non prise en charge.');
      if (typeof DecompressionStream !== 'function') throw new InputError('bad_zip', 'Ce navigateur ne sait pas ouvrir les ZIP : envoyer le .fit qu\'il contient.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return { data: new Uint8Array(await new Response(stream).arrayBuffer()), name: e.name };
    }
    throw new InputError('empty_zip', 'Le ZIP ne contient ni .fit, ni .gpx, ni .tcx.');
  }

  /* FIT — décodeur minimal (messages session, lap, record, length) */
  const FIT_EPOCH = 631065600;
  const SPORT = { 5: 'swimming', 0: 'generic', 1: 'running', 2: 'cycling', 11: 'walking', 17: 'hiking' };
  const SUB_SPORT = { 17: 'lap_swimming', 18: 'open_water' };
  const STROKE = ['freestyle', 'backstroke', 'breaststroke', 'butterfly', 'drill', 'mixed', 'im'];
  const LEN_TYPE = ['idle', 'active'];
  /* numéro global -> { numéro de champ: [nom, échelle | 'time' | table d'énumération] } */
  const FIT_MSG = {
    18: ['session', { 2: ['start_time', 'time'], 5: ['sport', SPORT], 6: ['sub_sport', SUB_SPORT], 7: ['total_elapsed_time', 1000], 8: ['total_timer_time', 1000], 9: ['total_distance', 100], 44: ['pool_length', 100], 253: ['timestamp', 'time'] }],
    19: ['lap', { 2: ['start_time', 'time'], 7: ['total_elapsed_time', 1000], 8: ['total_timer_time', 1000], 9: ['total_distance', 100], 32: ['num_lengths', 1], 40: ['num_active_lengths', 1], 253: ['timestamp', 'time'] }],
    20: ['record', { 0: ['position_lat', 1], 1: ['position_long', 1], 3: ['heart_rate', 1], 4: ['cadence', 1], 13: ['temperature', 1], 253: ['timestamp', 'time'] }],
    101: ['length', { 2: ['start_time', 'time'], 3: ['total_elapsed_time', 1000], 4: ['total_timer_time', 1000], 5: ['total_strokes', 1], 7: ['swim_stroke', STROKE], 9: ['avg_swimming_cadence', 1], 12: ['length_type', LEN_TYPE], 253: ['timestamp', 'time'] }]
  };
  /* type de base -> [taille, lecteur, valeur invalide] */
  function fitRead(dv, pos, bt, le) {
    switch (bt & 0x1f) {
      case 0: case 2: case 13: { const v = dv.getUint8(pos); return v === 0xff ? null : v; }
      case 10: { const v = dv.getUint8(pos); return v === 0 ? null : v; }
      case 1: { const v = dv.getInt8(pos); return v === 0x7f ? null : v; }
      case 3: { const v = dv.getInt16(pos, le); return v === 0x7fff ? null : v; }
      case 4: { const v = dv.getUint16(pos, le); return v === 0xffff ? null : v; }
      case 11: { const v = dv.getUint16(pos, le); return v === 0 ? null : v; }
      case 5: { const v = dv.getInt32(pos, le); return v === 0x7fffffff ? null : v; }
      case 6: { const v = dv.getUint32(pos, le); return v === 0xffffffff ? null : v; }
      case 12: { const v = dv.getUint32(pos, le); return v === 0 ? null : v; }
      case 8: { const v = dv.getFloat32(pos, le); return isFinite(v) ? v : null; }
      case 9: { const v = dv.getFloat64(pos, le); return isFinite(v) ? v : null; }
      default: return null;
    }
  }
  const FIT_SIZE = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8 };

  function readFit(u8) {
    if (u8.length < 14) throw new InputError('bad_fit', 'FIT trop court.');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const hsize = u8[0], dataSize = dv.getUint32(4, true);
    const end = Math.min(hsize + dataSize, u8.length);
    const defs = {}, out = { session: [], lap: [], record: [], length: [] };
    let pos = hsize, lastTs = null;
    try {
      while (pos < end) {
        const h = u8[pos++];
        let local, isDef = false, dev = false, compTs = null;
        if (h & 0x80) {
          local = (h >> 5) & 3;
          const off = h & 0x1f;
          if (lastTs != null) { let ts = (lastTs & ~0x1f) + off; if (off < (lastTs & 0x1f)) ts += 0x20; compTs = ts; lastTs = ts; }
        } else { local = h & 0x0f; isDef = !!(h & 0x40); dev = !!(h & 0x20); }
        if (isDef) {
          pos++;
          const le = u8[pos++] === 0;
          const gnum = dv.getUint16(pos, le); pos += 2;
          const nf = u8[pos++], fields = [];
          for (let i = 0; i < nf; i++) { fields.push([u8[pos], u8[pos + 1], u8[pos + 2]]); pos += 3; }
          let devSize = 0;
          if (dev) { const nd = u8[pos++]; for (let i = 0; i < nd; i++) { devSize += u8[pos + 1]; pos += 3; } }
          defs[local] = { gnum, le, fields, devSize };
          continue;
        }
        const d = defs[local];
        if (!d) throw new Error('message sans définition');
        const spec = FIT_MSG[d.gnum];
        const msg = spec ? {} : null;
        for (const [fnum, size, bt] of d.fields) {
          const base = FIT_SIZE[bt & 0x1f] || 1;
          if (fnum === 253 && size >= 4) { const v = fitRead(dv, pos, bt, d.le); if (v != null) lastTs = v; }
          if (msg && spec[1][fnum] && size >= base && (bt & 0x1f) !== 7) {
            const [name, k] = spec[1][fnum];
            let v = fitRead(dv, pos, bt, d.le);
            if (v != null) {
              if (k === 'time') v = v + FIT_EPOCH;
              else if (Array.isArray(k)) v = k[v] != null ? k[v] : String(v);
              else if (typeof k === 'object') v = k[v] != null ? k[v] : String(v);
              else if (k !== 1) v = v / k;
            }
            msg[name] = v;
          }
          pos += size;
        }
        pos += d.devSize;
        if (msg) {
          if (compTs != null && msg.timestamp == null) msg.timestamp = compTs + FIT_EPOCH;
          out[spec[0]].push(msg);
        }
      }
    } catch (e) {
      if (e instanceof InputError) throw e;
      if (!out.session.length && !out.length.length && !out.record.length) throw new InputError('bad_fit', 'FIT illisible : ' + e.message);
    }
    return out;
  }

  /* ------------------------------------------------------------------ eau libre (guideline §1 à §3) */
  function smoothSegment(seg, win) {
    const n = seg.length, hasT = seg.every(p => p.t != null), out = [];
    if (hasT) {
      let a = 0, b = 0, sl = 0, so = 0;
      for (let i = 0; i < n; i++) {
        const t = seg[i].t;
        while (b < n && seg[b].t - t <= win) { sl += seg[b].lat; so += seg[b].lon; b++; }
        while (t - seg[a].t > win) { sl -= seg[a].lat; so -= seg[a].lon; a++; }
        const c = b - a;
        out.push(Object.assign({}, seg[i], { lat: sl / c, lon: so / c }));
      }
    } else {
      for (let i = 0; i < n; i++) {
        const w = seg.slice(Math.max(0, i - 4), i + 5);
        out.push(Object.assign({}, seg[i], { lat: sum(w.map(p => p.lat)) / w.length, lon: sum(w.map(p => p.lon)) / w.length }));
      }
    }
    return out;
  }
  const pathLen = segs => { let s = 0; for (const g of segs) for (let i = 1; i < g.length; i++) s += hav(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon); return s; };

  function simplify(pts, tol) {
    const n = pts.length;
    if (n <= 2) return pts.map((_, i) => i);
    const lat0 = rad(pts[0][0]);
    const xy = pts.map(([la, lo]) => [rad(lo) * R_EARTH * Math.cos(lat0), rad(la) * R_EARTH]);
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [x1, y1] = xy[a], [x2, y2] = xy[b], dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = xy[i];
        let d;
        if (L2 === 0) d = Math.hypot(px - x1, py - y1);
        else { const u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)); d = Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy)); }
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    const idx = []; for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    return idx;
  }

  function analyseOpenWater(segments, name, gtype, source, metaTime) {
    const warnings = [];
    /* W1 */
    const clean = [];
    for (const seg of segments) {
      const s2 = []; let last = null;
      for (const p of seg) {
        if (p.t != null && last != null && p.t <= last) continue;
        if (p.t != null) last = p.t;
        s2.push(p);
      }
      if (s2.length >= 2) clean.push(s2);
    }
    if (!clean.length) throw new InputError('no_points', 'Aucun point GPS exploitable dans le fichier.', 422);
    const hasTime = clean.every(s => s.every(p => p.t != null));
    if (!hasTime) warnings.push('no_time');

    /* W2 */
    const rawLen = pathLen(clean);
    const sm = clean.map(s => smoothSegment(s, P.SMOOTH_WIN));
    const smLen = pathLen(sm);
    const smoothed = smLen > 0 && rawLen > smLen * P.SMOOTH_RATIO;
    const segs = smoothed ? sm : clean;
    const t0 = hasTime ? segs[0][0].t : null, tEnd = hasTime ? segs[segs.length - 1][segs[segs.length - 1].length - 1].t : null;

    let distance = 0, distValid = 0, moving = 0, nGaps = 0, nJumps = 0, gapTime = 0, jumpTime = 0;
    let strokes = 0, strokeDist = 0, hrSum = 0, hrW = 0;
    const T = [0], D = [0], X = [0], TR = [0], lines = [];
    let prevLast = null;
    for (const s of segs) {
      let line = [[s[0].lat, s[0].lon]];
      if (prevLast) {
        if (hasTime) { T.push(T[T.length - 1]); D.push(D[D.length - 1]); X.push(X[X.length - 1] + Math.max(0, s[0].t - prevLast.t)); TR.push(s[0].t - t0); }
        else { T.push(T[T.length - 1]); D.push(D[D.length - 1]); X.push(X[X.length - 1]); TR.push(TR[TR.length - 1]); }
      }
      for (let i = 1; i < s.length; i++) {
        const p = s[i], q = s[i - 1];
        const dd = hav(q.lat, q.lon, p.lat, p.lon);
        if (!hasTime) { distance += dd; distValid += dd; line.push([p.lat, p.lon]); continue; }
        const dt = p.t - q.t, v = dt > 0 ? dd / dt : 0;
        const gap = dt > P.GAP, jump = v > P.VMAX;
        if (jump) { nJumps++; jumpTime += dt; } else if (gap) { nGaps++; gapTime += dt; }
        if (!jump) distance += dd;
        const Tl = T[T.length - 1], Dl = D[D.length - 1], Xl = X[X.length - 1];
        if (gap || jump) {
          T.push(Tl); D.push(Dl); X.push(Xl + dt);
          if (line.length >= 2) lines.push(line);
          line = [[p.lat, p.lon]];
        } else {
          distValid += dd;
          if (v >= P.MOVE_V) moving += dt;
          T.push(Tl + dt); D.push(Dl + dd); X.push(Xl);
          line.push([p.lat, p.lon]);
          if (dt <= P.STROKE_DT && (p.cad || 0) > 0) { strokes += p.cad / 60 * dt; strokeDist += dd; }
        }
        TR.push(p.t - t0);
        if (p.hr && q.hr && dt > 0) { const w = Math.min(dt, P.HR_DT_CAP); hrSum += (p.hr + q.hr) / 2 * w; hrW += w; }
      }
      if (line.length >= 2) lines.push(line);
      prevLast = s[s.length - 1];
    }
    const all = [].concat(...segs);
    const duration = hasTime ? tEnd - t0 : null;

    function windowAt(j, i, Xm) {
      const dd = D[j] - D[i];
      if (dd < Xm) return null;
      const tv = T[j] - T[i], removed = X[j] - X[i], real = tv + removed;
      if (!(real > 0) || removed / real > P.BEST_MAX_REMOVED || !(tv > 0)) return null;
      return tv * Xm / dd;
    }
    function bestWindow(Xm) {
      let i = 0, best = null;
      for (let j = 1; j < D.length; j++) {
        while (i + 1 < j && D[j] - D[i + 1] >= Xm) i++;
        const tt = windowAt(j, i, Xm);
        if (tt != null && (best == null || tt < best)) best = tt;
      }
      return best;
    }
    const bests = {};
    for (const x of P.BEST) bests['best' + x] = hasTime ? r0(bestWindow(x)) : null;

    const profile = [];
    if (hasTime && D.length > 1) {
      let i = 0, next = 0;
      for (let j = 1; j < D.length; j++) {
        while (i + 1 < j && D[j] - D[i + 1] >= 100) i++;
        if (D[j] < next) continue;
        next = D[j] + P.PROFILE_STEP;
        const pace = windowAt(j, i, 100);
        profile.push([r0(D[j]), pace == null ? null : r0(pace), r0(TR[j])]);
      }
    }

    const temps = all.filter(p => p.temp != null).map(p => p.temp);
    const cads = all.filter(p => (p.cad || 0) > 0).map(p => p.cad);
    const hrs = all.filter(p => p.hr).map(p => p.hr);
    if (!cads.length) warnings.push('no_cadence');
    const removed = gapTime + jumpTime;
    if (nJumps > P.JUMPS_WARN || (duration && removed / duration > P.REMOVED_WARN)) warnings.push('many_gps_jumps');
    const outLines = lines.map(ln => simplify(ln, P.LINE_TOL).map(k => [Math.round(ln[k][0] * 1e6) / 1e6, Math.round(ln[k][1] * 1e6) / 1e6]));
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of all) { if (p.lat < la0) la0 = p.lat; if (p.lat > la1) la1 = p.lat; if (p.lon < lo0) lo0 = p.lon; if (p.lon > lo1) lo1 = p.lon; }

    return Object.assign({
      category: 'nage', source, name: name || '', gpxType: gtype || 'open_water_swimming',
      start: ms(hasTime ? t0 : metaTime), end: ms(tEnd),
      distance: r0(distance), distanceValid: r0(distValid), duration: r0(duration),
      moving: hasTime ? r0(moving) : null,
      pace100: hasTime && distValid > 0 && moving > 0 ? r0(moving / distValid * 100) : null
    }, bests, {
      strokes: strokes ? r0(strokes) : null, strokeDist: strokes ? r0(strokeDist) : null, dps: strokes ? r2(strokeDist / strokes) : null,
      cadAvg: cads.length ? r1(sum(cads) / cads.length) : null,
      waterTemp: temps.length ? r1(median(temps)) : null,
      hrAvg: hrW ? r0(hrSum / hrW) : null, hrMax: hrs.length ? r0(Math.max(...hrs)) : null,
      paceProfile: profile, line: outLines, bounds: [[la0, lo0], [la1, lo1]],
      cleaning: { smoothed, rawDistance: r0(rawLen), gaps: nGaps, gapTime: r0(gapTime), jumps: nJumps, jumpTime: r0(jumpTime) },
      warnings
    });
  }

  /* ------------------------------------------------------------------ piscine (guideline §10) */
  function detectLengths(L) {
    const act = [];
    L.forEach((d, i) => { if (d.type === 'active' && d.strokes) act.push(i); });
    if (act.length < P.POOL_MIN_LENGTHS) return { tm: null, sm: null, out: [] };
    const tm = median(act.map(i => L[i].time)), sm = median(act.map(i => L[i].strokes)), A = P.POOL_ANOM;
    const anom = i => !(Math.abs(L[i].time / tm - 1) <= A && Math.abs(L[i].strokes / sm - 1) <= A);
    const idleBetween = (i, j) => { let s = 0; for (let k = i + 1; k < j; k++) if (L[k].type !== 'active') s += L[k].time; return s; };
    const joinable = w => {
      for (let k = 0; k + 1 < w.length; k++) {
        const r = idleBetween(w[k], w[k + 1]);
        if (r === 0) continue;
        if (r <= P.POOL_BRIDGE && anom(w[k]) && anom(w[k + 1])) continue;
        return false;
      }
      return true;
    };
    const out = [], used = new Set();
    for (const size of [1, 2, 3]) {
      const cands = [];
      for (let k = 0; k + size <= act.length; k++) {
        const w = act.slice(k, k + size);
        if (!w.some(anom) || w.some(x => used.has(x)) || !joinable(w)) continue;
        const Tn = sum(w.map(x => L[x].time)) / tm, Sn = sum(w.map(x => L[x].strokes)) / sm;
        const n = Math.round((Tn + Sn) / 2);
        if (n < 1 || (size === 1 && n === 1)) continue;
        const res = Math.max(Math.abs(Tn - n), Math.abs(Sn - n)) / n;
        if (res <= P.POOL_TOL) cands.push({ res, w, n, Tn, Sn });
      }
      cands.sort((a, b) => a.res - b.res);
      for (const c of cands) {
        if (c.w.some(x => used.has(x))) continue;
        const kind = c.n > c.w.length ? 'missed' : (c.n < c.w.length ? 'extra' : 'split');
        const confidence = Math.abs(c.Tn - c.Sn) < 0.15 && c.res <= 0.10 ? 'high' : 'medium';
        out.push({ idx: c.w, counted: c.w.length, estimated: c.n, kind, timeRatio: c.Tn, strokeRatio: c.Sn, confidence });
        c.w.forEach(x => used.add(x));
      }
    }
    for (const i of act) {
      if (used.has(i) || !anom(i)) continue;
      const ti = L[i].time / tm, si = L[i].strokes / sm;
      const kind = ti > P.POOL_PAUSE && Math.abs(si - 1) <= A ? 'pause' : 'unexplained';
      out.push({ idx: [i], counted: 1, estimated: 1, kind, timeRatio: ti, strokeRatio: si, confidence: null });
    }
    out.sort((a, b) => a.idx[0] - b.idx[0]);
    return { tm, sm, out };
  }

  function poolBests(L, flagged, pool) {
    const series = []; let cur = [];
    L.forEach((d, i) => { if (d.type === 'active') cur.push(i); else { if (cur.length) series.push(cur); cur = []; } });
    if (cur.length) series.push(cur);
    const res = {};
    for (const X of P.BEST) {
      const k = Math.ceil(X / pool - 0.01);
      let best = null;
      for (const ser of series) for (let a = 0; a + k <= ser.length; a++) {
        const w = ser.slice(a, a + k);
        if (w.some(x => flagged.has(x))) continue;
        const tt = sum(w.map(x => L[x].time)) * X / (k * pool);
        if (best == null || tt < best) best = tt;
      }
      res['best' + X] = r0(best);
    }
    return res;
  }

  function hrStats(hrPts) {
    let s = 0, w = 0;
    for (let i = 1; i < hrPts.length; i++) {
      const dt = hrPts[i][0] - hrPts[i - 1][0];
      if (dt > 0) { const c = Math.min(dt, P.HR_DT_CAP); s += (hrPts[i][1] + hrPts[i - 1][1]) / 2 * c; w += c; }
    }
    return { avg: w ? r0(s / w) : null, max: hrPts.length ? r0(Math.max(...hrPts.map(x => x[1]))) : null };
  }
  function pulseSeries(hrPts, t0) {
    if (!hrPts.length || t0 == null) return [];
    const acc = new Map();
    for (const [t, h] of hrPts) { const k = Math.floor((t - t0) / P.PULSE_BIN); if (!acc.has(k)) acc.set(k, []); acc.get(k).push(h); }
    return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [r0((k + 0.5) * P.PULSE_BIN), r0(sum(v) / v.length)]);
  }

  function analysePoolFit(msgs) {
    const S = msgs.session[0] || {};
    const pool = S.pool_length;
    if (!pool) throw new InputError('no_pool_length', 'FIT de piscine sans longueur de bassin.', 422);
    const warnings = [];
    const L = msgs.length.map(d => ({
      type: d.length_type || (d.total_strokes ? 'active' : 'idle'), start: d.start_time,
      time: d.total_timer_time != null ? d.total_timer_time : (d.total_elapsed_time || 0),
      strokes: d.total_strokes || 0, style: d.swim_stroke || null, cad: d.avg_swimming_cadence
    }));
    if (!L.length) throw new InputError('no_lengths', 'FIT de piscine sans longueurs.', 422);
    const tStart = S.start_time != null ? S.start_time : L[0].start;
    const act = []; L.forEach((d, i) => { if (d.type === 'active') act.push(i); });
    const nAct = act.length;
    const det = detectLengths(L);
    if (det.tm == null) warnings.push('too_few_lengths_for_detection');
    const anomalies = det.out;
    const flagged = new Set();
    anomalies.forEach(o => { if (['missed', 'extra', 'split'].includes(o.kind)) o.idx.forEach(i => flagged.add(i)); });
    const corr = sum(anomalies.map(o => o.estimated - o.counted));
    const numOf = new Map(act.map((i, k) => [i, k + 1]));
    const flagOf = new Map(); anomalies.forEach(o => o.idx.forEach(i => flagOf.set(i, o.kind)));

    const rec = msgs.record.filter(r => r.timestamp != null);
    const hrPts = rec.filter(r => r.heart_rate).map(r => [r.timestamp, r.heart_rate]);
    const temps = rec.filter(r => r.temperature != null).map(r => r.temperature);
    const hrBetween = (a, b) => { const v = hrPts.filter(x => x[0] >= a && x[0] <= b).map(x => x[1]); return v.length ? r0(sum(v) / v.length) : null; };

    const swimTime = sum(act.map(i => L[i].time));
    const stroked = act.filter(i => L[i].strokes);
    const totStrokes = sum(stroked.map(i => L[i].strokes));
    const strokeDist = stroked.length * pool;
    const distance = S.total_distance || nAct * pool;
    const distEst = (nAct + corr) * pool;

    const rests = []; let cur = null;
    for (const d of L) {
      if (d.type !== 'active') { if (!cur) cur = [d.start, 0]; cur[1] += d.time; }
      else { if (cur) rests.push(cur); cur = null; }
    }
    if (cur) rests.push(cur);
    const restsF = rests.filter(r => r[1] >= P.REST_MIN);

    const detail = act.map(i => {
      const d = L[i], sw = d.strokes ? d.time + d.strokes : null;
      return {
        n: numOf.get(i), start: d.start != null ? r1(d.start - tStart) : null, time: r1(d.time), strokes: d.strokes || null,
        style: STYLE_FR[d.style] || d.style, cadence: d.cad != null ? d.cad : null,
        swolf: r0(sw), swolf25: sw ? r1(sw * 25 / pool) : null, pace100: r0(d.time / pool * 100),
        hr: d.start != null ? hrBetween(d.start, d.start + d.time) : null, flag: flagOf.get(i) || null
      };
    });
    const styles = {};
    act.forEach(i => { const k = STYLE_FR[L[i].style] || L[i].style || 'inconnu'; styles[k] = (styles[k] || 0) + pool; });
    Object.keys(styles).forEach(k => { styles[k] = r0(styles[k]); });
    const cadW = act.filter(i => L[i].cad).map(i => [L[i].cad, L[i].time]);
    const tMed = stroked.length ? median(stroked.map(i => L[i].time)) : null;
    const sMed = stroked.length ? median(stroked.map(i => L[i].strokes)) : null;
    const sets = msgs.lap.filter(lp => (lp.total_distance || 0) > 0).map(lp => {
      const t = lp.total_timer_time || 0, dist = lp.total_distance;
      return { start: lp.start_time != null ? r1(lp.start_time - tStart) : null, distance: r0(dist), time: r1(t), pace100: r0(t / dist * 100), lengths: lp.num_active_lengths != null ? lp.num_active_lengths : null };
    });
    const corrections = anomalies.map(o => ({
      lengths: o.idx.map(i => numOf.get(i)), kind: o.kind, counted: o.counted, estimated: o.estimated,
      timeRatio: r2(o.timeRatio), strokeRatio: r2(o.strokeRatio), confidence: o.confidence
    }));
    if (corr !== 0) warnings.push('distance_estimate_differs');
    const hr = hrStats(hrPts);
    const duration = S.total_elapsed_time;
    const end = tStart != null && duration ? tStart + duration : null;

    return Object.assign({
      category: 'nage_piscine', source: 'fit', name: 'Natation en piscine', gpxType: 'lap_swimming',
      start: ms(tStart), end: ms(end), poolLength: Math.round(pool * 100) / 100, lengths: nAct,
      distance: r0(distance), distanceEstimated: r0(distEst), duration: r0(duration),
      swimTime: r0(swimTime), moving: r0(swimTime), restCount: restsF.length, restTime: r0(sum(restsF.map(r => r[1]))),
      pace100: distance ? r0(swimTime / distance * 100) : null, pace100Estimated: distEst ? r0(swimTime / distEst * 100) : null
    }, poolBests(L, flagged, pool), {
      strokes: totStrokes ? r0(totStrokes) : null, strokeDist: totStrokes ? r0(strokeDist) : null,
      strokesPerLength: stroked.length ? r1(totStrokes / stroked.length) : null,
      dps: totStrokes ? r2(strokeDist / totStrokes) : null,
      swolf: stroked.length ? r0(median(stroked.map(i => L[i].time + L[i].strokes))) : null,
      swolf25: stroked.length ? r1(median(stroked.map(i => (L[i].time + L[i].strokes) * 25 / pool))) : null,
      medianPace100: tMed ? r0(tMed / pool * 100) : null, medianSwolf25: tMed ? r1((tMed + sMed) * 25 / pool) : null,
      medianDps: sMed ? r2(pool / sMed) : null,
      cadAvg: cadW.length ? r1(sum(cadW.map(x => x[0] * x[1])) / sum(cadW.map(x => x[1]))) : null,
      waterTemp: temps.length ? r1(median(temps)) : null,
      hrAvg: hr.avg, hrMax: hr.max, styles, sets,
      rests: restsF.map(([a, b]) => [a != null ? r1(a - tStart) : null, r1(b)]),
      lengthsDetail: detail, corrections, pulseSeries: pulseSeries(hrPts, tStart), warnings
    });
  }

  function analysePoolTcx(tcx) {
    const laps = tcx.laps.filter(l => l.time != null);
    if (!laps.length) throw new InputError('no_laps', 'TCX sans tours exploitables.', 422);
    const swim = laps.filter(l => (l.dist || 0) > 0), rest = laps.filter(l => !((l.dist || 0) > 0) && l.time >= P.REST_MIN);
    const distance = sum(swim.map(l => l.dist)), swimTime = sum(swim.map(l => l.time));
    const t0 = laps[0].start, last = laps[laps.length - 1], end = last.start != null ? last.start + last.time : null;
    const hrPts = tcx.points.filter(p => p.t != null && p.hr).map(p => [p.t, p.hr]);
    const hr = hrStats(hrPts);
    return {
      category: 'nage_piscine', source: 'tcx', name: 'Natation en piscine', gpxType: 'lap_swimming',
      start: ms(t0), end: ms(end), poolLength: null, lengths: null, distance: r0(distance), distanceEstimated: null,
      duration: end != null && t0 != null ? r0(end - t0) : null, swimTime: r0(swimTime), moving: r0(swimTime),
      restCount: rest.length, restTime: r0(sum(rest.map(l => l.time))),
      pace100: distance ? r0(swimTime / distance * 100) : null, pace100Estimated: null,
      best100: null, best500: null, best1000: null, strokes: null, strokeDist: null, strokesPerLength: null, dps: null,
      swolf: null, swolf25: null, medianPace100: null, medianSwolf25: null, medianDps: null, cadAvg: null, waterTemp: null,
      hrAvg: hr.avg, hrMax: hr.max, styles: {},
      sets: swim.map(l => ({ start: l.start != null && t0 != null ? r1(l.start - t0) : null, distance: r0(l.dist), time: r1(l.time), pace100: r0(l.time / l.dist * 100), lengths: null })),
      rests: rest.map(l => [l.start != null && t0 != null ? r1(l.start - t0) : null, r1(l.time)]),
      lengthsDetail: [], corrections: [], pulseSeries: pulseSeries(hrPts, t0), warnings: ['tcx_no_lengths']
    };
  }

  /* ------------------------------------------------------------------ point d'entrée */
  async function analyse(input, filename) {
    let u8 = await toBytes(input);
    if (!u8.length) throw new InputError('empty', 'Fichier vide.');
    let kind = sniff(u8), inner = null;
    if (kind === 'zip') { const z = await readZip(u8); u8 = z.data; inner = z.name; kind = sniff(u8); }
    const file = baseName(filename) || inner;
    const garminId = garminIdFrom(filename) || garminIdFrom(inner);
    const base = { schema: SCHEMA, formulas: FORMULAS, file, id: garminId ? 'activity_' + garminId : (file || null), garminId, isSwim: true };
    let res;
    if (kind === 'gpx') {
      const g = readGpx(u8);
      if (!(SWIM_RE.test(g.type) || (!g.type && SWIM_RE.test(g.name))))
        throw new InputError('not_a_swim', `Ce GPX n'est pas une nage (type « ${g.type || '—'} ») : il relève des stats de rando.`, 422);
      const nPts = sum(g.segments.map(s => s.length));
      if (!nPts) {
        if (/lap/.test(g.type) || /pool/i.test(g.name))
          throw new InputError('pool_gpx_empty', "Le GPX d'une natation en piscine est vide : utiliser le fichier original (ZIP ou FIT, « Exporter l'original » dans Garmin Connect).", 422);
        throw new InputError('no_points', 'GPX sans points.', 422);
      }
      res = analyseOpenWater(g.segments, g.name, g.type, 'gpx', g.metaTime);
    } else if (kind === 'fit') {
      const msgs = readFit(u8);
      const S = msgs.session[0] || {};
      const sport = S.sport != null ? String(S.sport) : '', sub = S.sub_sport != null ? String(S.sub_sport) : '';
      if (sport && sport !== 'swimming') throw new InputError('not_a_swim', `Ce FIT n'est pas une nage (sport « ${sport} »).`, 422);
      const pos = msgs.record.filter(r => r.position_lat != null && r.position_long != null);
      if (sub === 'lap_swimming' || (msgs.length.length && S.pool_length)) res = analysePoolFit(msgs);
      else if (pos.length) {
        const k = 180 / 2 ** 31;
        const pts = pos.map(r => ({ lat: r.position_lat * k, lon: r.position_long * k, t: r.timestamp != null ? r.timestamp : null, hr: r.heart_rate, temp: r.temperature, cad: r.cadence }));
        res = analyseOpenWater([pts], '', 'open_water_swimming', 'fit', null);
      } else throw new InputError('no_swim_data', 'FIT sans longueurs ni positions.', 422);
    } else {
      const tcx = readTcx(u8);
      const pos = tcx.points.filter(p => p.lat != null && p.lon != null);
      res = pos.length ? analyseOpenWater([pos], '', 'open_water_swimming', 'tcx', null) : analysePoolTcx(tcx);
    }
    return Object.assign(base, res);
  }

  const isSwimFile = name => /\.(gpx|fit|zip|tcx)$/i.test(name || '');

  const api = { analyse, isSwimFile, InputError, P, SCHEMA, FORMULAS, detectLengths, _readFit: readFit, _readGpx: readGpx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoldatisNage = api;
})(typeof self !== 'undefined' ? self : this);
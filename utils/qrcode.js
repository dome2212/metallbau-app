/**
 * Minimaler QR-Code-Generator (ohne externe Abhängigkeiten).
 * Byte-Modus, Fehlerkorrektur-Stufe M, Versionen 1–10 (bis 213 Zeichen).
 * Reicht für URLs wie https://appgehrmann.de/timetracking/scan/123.
 *
 * Nutzung:
 *   const { toSvg } = require('./utils/qrcode');
 *   const svg = toSvg('https://...', { size: 300 });
 */

const ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // Version 1..10
const NUM_BLOCKS_M    = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN_POS = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;

// ── Galois-Feld GF(256) / Reed-Solomon ───────────────────────────────────
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ── Kapazitäten ──────────────────────────────────────────────────────────
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
function dataCodewords(ver) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver - 1] * NUM_BLOCKS_M[ver - 1];
}

// ── Hauptfunktion ────────────────────────────────────────────────────────
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));

  // Version wählen
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error('Text für QR-Code zu lang (max. ~213 Zeichen)');

  // Bitstrom
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0x4, 4);                              // Byte-Modus
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach(b => put(b, 8));
  const capBits = dataCodewords(ver) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }

  // Blöcke + Fehlerkorrektur
  const nBlocks = NUM_BLOCKS_M[ver - 1];
  const eccLen = ECC_PER_BLOCK_M[ver - 1];
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const numShort = nBlocks - rawCw % nBlocks;
  const shortLen = Math.floor(rawCw / nBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);          // Platzhalter, wird beim Verschachteln übersprungen
    blocks.push(dat.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]);
    });
  }

  return buildMatrix(ver, codewords);
}

function buildMatrix(ver, codewords) {
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn  = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

  // Timing
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // Finder + Separator
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Alignment
  const ap = ALIGN_POS[ver - 1];
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  const drawFormat = (mask) => {
    const d = (0 << 3) | mask;              // ECC M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((fmt >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);                            // reserviert Bereich

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((v >>> i) & 1) !== 0;
      const a = size - 11 + i % 3, c = Math.floor(i / 3);
      setFn(a, c, b); setFn(c, a, b);
    }
  }

  // Daten platzieren (Zickzack)
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  // Beste Maske wählen
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0, bestPen = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty(mod, size);
    if (p < bestPen) { bestPen = p; best = m; }
    applyMask(m);                           // zurücknehmen (XOR)
  }
  applyMask(best); drawFormat(best);
  return mod;
}

function penalty(mod, size) {
  let result = 0;
  const runPen = (get) => {
    let pen = 0;
    for (let a = 0; a < size; a++) {
      let run = 1, prev = get(a, 0);
      for (let b = 1; b < size; b++) {
        const c = get(a, b);
        if (c === prev) { run++; if (run === 5) pen += 3; else if (run > 5) pen++; }
        else { run = 1; prev = c; }
      }
    }
    return pen;
  };
  result += runPen((a, b) => mod[a][b]) + runPen((a, b) => mod[b][a]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = mod[y][x];
    if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) result += 3;
  }
  const pat = [true, false, true, true, true, false, true];
  const finderPen = (get) => {
    let pen = 0;
    for (let a = 0; a < size; a++) for (let b = 0; b + 7 <= size; b++) {
      if (!pat.every((v, k) => get(a, b + k) === v)) continue;
      const light = (s, e) => { for (let k = s; k < e; k++) if (k >= 0 && k < size && get(a, k)) return false; return true; };
      if (light(b - 4, b) || light(b + 7, b + 11)) pen += 40;
    }
    return pen;
  };
  result += finderPen((a, b) => mod[a][b]) + finderPen((a, b) => mod[b][a]);
  let dark = 0;
  for (const row of mod) for (const c of row) if (c) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/** Liefert den QR-Code als SVG-String (mit weißer Ruhezone von 4 Modulen). */
function toSvg(text, opts = {}) {
  const mod = encode(text);
  const quiet = 4;
  const n = mod.length + quiet * 2;
  const size = opts.size || 300;
  let path = '';
  mod.forEach((row, y) => row.forEach((d, x) => { if (d) path += `M${x + quiet},${y + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR-Code">` +
         `<rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg };

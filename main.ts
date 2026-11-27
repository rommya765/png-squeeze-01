// PNG Squeeze — lossless PNG recompressor.
//
// Reads each screenshot under /input/<id>/image.png (a stored, unfiltered RGBA PNG),
// analyses its pixels, rebuilds the image in the cheapest exact PNG form (palette,
// grey, grey+alpha, RGB or RGBA, with a tRNS key when one transparent value allows
// it), filters every row with the filter that a fast cost model likes best, and
// deflates the result at maximum effort. Several candidate encodings are produced
// per image and the smallest verified one is written to /output/<id>/image.png.
//
// Everything is deterministic: candidate order and effort budgets depend only on
// the input bytes, never on the clock or the environment.

import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CRC-32 (PNG polynomial), table-driven.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG container writing: signature + length/type/data/CRC chunks.
// ---------------------------------------------------------------------------
function chunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

function ihdr(width, height, colourType) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  return data; // compression 0, filter 0, interlace 0
}

function pngFile(width, height, form, zlibStream) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr(width, height, form.colourType))];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', zlibStream));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG reading: collect IDAT, inflate, undo the row filters.
// ---------------------------------------------------------------------------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodeStoredPng(bytes) {
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idatParts = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos).getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos + 8);
      width = view.getUint32(0);
      height = view.getUint32(4);
      colourType = data[9];
    } else if (type === 'IDAT') idatParts.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idatParts));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * ch;
  const rgba = new Uint8Array(width * height * 4);
  const recon = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const filter = raw[rowAt];
    const src = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    // Unfilter into a per-row sample buffer first (samples, not RGBA).
    const prevSamples = y === 0 ? null : lastRowSamples;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? recon[i - ch] : 0;
      const b = prevSamples ? prevSamples[i] : 0;
      const c = prevSamples && i >= ch ? prevSamples[i - ch] : 0;
      const v = src[i];
      recon[i] =
        filter === 0 ? v :
        filter === 1 ? (v + a) & 0xff :
        filter === 2 ? (v + b) & 0xff :
        filter === 3 ? (v + ((a + b) >> 1)) & 0xff :
        (v + paeth(a, b, c)) & 0xff;
    }
    var lastRowSamples = recon.slice();
    // Expand the row's samples to RGBA (input is colour type 6 in this contest,
    // but the expansion keeps the reader honest for every type it may meet).
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const s = x * ch;
      if (colourType === 6) {
        rgba[d] = recon[s];
        rgba[d + 1] = recon[s + 1];
        rgba[d + 2] = recon[s + 2];
        rgba[d + 3] = recon[s + 3];
      } else if (colourType === 2) {
        rgba[d] = recon[s];
        rgba[d + 1] = recon[s + 1];
        rgba[d + 2] = recon[s + 2];
        rgba[d + 3] = 255;
      } else if (colourType === 0) {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = recon[s];
        rgba[d + 3] = 255;
      } else if (colourType === 4) {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = recon[s];
        rgba[d + 3] = recon[s + 1];
      } else {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = recon[s];
        rgba[d + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, colour census (up to 257 colours).
// ---------------------------------------------------------------------------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | a;
      const hit = counts.get(key);
      if (hit === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, { r: rgba[d], g: rgba[d + 1], b: rgba[d + 2], a, count: 1 });
      } else hit.count++;
    }
  }
  return { opaque, grey, colours: many ? null : [...counts.values()] };
}

// The single transparent value that could be carried by a tRNS key instead of
// an alpha channel: every non-opaque pixel shares it at alpha 0, and no opaque
// pixel uses the same colour. Returns {r,g,b} (grey uses r) or null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Sample extraction for the non-palette colour types.
// ---------------------------------------------------------------------------
function samplesOf(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    out[s] = rgba[d];
    if (colourType === 4) out[s + 1] = rgba[d + 3];
    else if (colourType === 2) {
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette forms. Entry order matters twice: it decides the tRNS length
// (entries after the last non-opaque one are free) and how well the index
// rows filter and match. Three orders are tried.
// ---------------------------------------------------------------------------
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  if (order === 'path') {
    // Greedy nearest-neighbour path through colour space, non-opaque
    // entries first (tRNS stays short): spatially adjacent colours in the
    // screenshot tend to be adjacent palette entries too, so Sub-filter
    // residuals of the index rows stay small and runs stay long.
    const dist2 = (a, b) => {
      const dr = a.r - b.r;
      const dg = a.g - b.g;
      const db = a.b - b.b;
      return dr * dr + dg * dg + db * db;
    };
    const pathOf = (group) => {
      const rest = [...group];
      if (rest.length === 0) return rest;
      let start = 0;
      for (let i = 1; i < rest.length; i++) if (rest[i].count > rest[start].count) start = i;
      const out = [rest.splice(start, 1)[0]];
      while (rest.length > 0) {
        const last = out[out.length - 1];
        let bestI = 0;
        let bestD = Infinity;
        for (let i = 0; i < rest.length; i++) {
          const d = dist2(last, rest[i]);
          if (d < bestD) {
            bestD = d;
            bestI = i;
          }
        }
        out.push(rest.splice(bestI, 1)[0]);
      }
      return out;
    };
    const transparent = colours.filter((c) => c.a !== 255).sort((a, b) => a.a - b.a || b.count - a.count);
    const opaque = colours.filter((c) => c.a === 255);
    const entries = [...pathOf(transparent), ...pathOf(opaque)];
    return paletteFromEntries(rgba, entries);
  }
  const entries = [...colours].sort((x, y) => {
    if (order === 'freq') return y.count - x.count || lum(x) - lum(y);
    if (order === 'lum') return lum(x) - lum(y) || y.count - x.count;
    // 'alpha-freq': non-opaque entries first (so tRNS stays short), then frequency.
    const xa = x.a === 255 ? 1 : 0;
    const ya = y.a === 255 ? 1 : 0;
    if (xa !== ya) return xa - ya;
    if (xa === 0 && x.a !== y.a) return x.a - y.a;
    return y.count - x.count || lum(x) - lum(y);
  });
  return paletteFromEntries(rgba, entries);
}

// Build the palette form (PLTE, tRNS, index rows) from an entry order.
function paletteFromEntries(rgba, entries) {
  const indexOf = new Map();
  entries.forEach((c, i) => indexOf.set((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a, i));
  const plte = new Uint8Array(entries.length * 3);
  let lastAlpha = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) lastAlpha = i + 1;
  });
  const trns = lastAlpha === 0 ? null : Uint8Array.from(entries.slice(0, lastAlpha), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = indexOf.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// All exact forms worth trying for this image.
function formsOf(rgba, info) {
  const forms = [];
  if (info.colours !== null) {
    for (const order of ['alpha-freq', 'freq', 'lum']) forms.push(paletteForm(rgba, info.colours, order));
    if (!info.grey) return forms;
  }
  const key = info.opaque ? null : transparentKey(rgba, info.grey);
  let colourType;
  let trns = null;
  if (info.grey) {
    colourType = info.opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = info.opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, (key >>> 16) & 0xff, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({ colourType, bpp, samples: samplesOf(rgba, colourType), plte: null, trns });
  return forms;
}

// ---------------------------------------------------------------------------
// Row filtering. filterRow writes one filtered row (without its filter byte).
// ---------------------------------------------------------------------------
function filterRow(type, cur, prev, bpp, out) {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    const v = cur[i];
    out[i] =
      type === 0 ? v :
      type === 1 ? (v - a) & 0xff :
      type === 2 ? (v - b) & 0xff :
      type === 3 ? (v - ((a + b) >> 1)) & 0xff :
      (v - paeth(a, b, c)) & 0xff;
  }
}

// Cost of a filtered row under the minimum-sum-of-absolute-signed-bytes model.
function signedAbsSum(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

// The cost of a filtered row under the fewest-distinct-byte-pairs model:
// residuals that reuse the pairs their row already holds compress better.
function distinctPairsCost(row, pairSeen, stamp) {
  let distinct = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (pairSeen[pair] !== stamp) {
      pairSeen[pair] = stamp;
      distinct++;
    }
  }
  return distinct;
}

// Build every wanted filtered variant of one form in a single pass: the five
// trial rows of each source row are computed once and shared between the
// fixed-filter streams and the adaptive choices ('minsum': per-row minimum
// signed-abs sum; 'pairs': fewest distinct byte pairs). Returns a Map from
// strategy (filter number or name) to its filtered byte stream.
function filteredVariants(samples, width, height, bpp, strategies) {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  const out = new Map();
  for (const s of strategies) out.set(s, new Uint8Array(height * rowBytes));
  const wantMinsum = strategies.includes('minsum');
  const wantPairs = strategies.includes('pairs');
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const pairSeen = new Int32Array(65536);
  let pairStamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowBytes;
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trials[t]);
    for (const s of strategies) {
      if (typeof s !== 'number') continue;
      const raw = out.get(s);
      raw[at] = s;
      raw.set(trials[s], at + 1);
    }
    if (wantMinsum || wantPairs) {
      let minType = 0;
      let minCost = Infinity;
      let pairType = 0;
      let pairCost = Infinity;
      for (let t = 0; t < 5; t++) {
        if (wantMinsum) {
          const c = signedAbsSum(trials[t]);
          if (c < minCost) {
            minCost = c;
            minType = t;
          }
        }
        if (wantPairs) {
          const c = distinctPairsCost(trials[t], pairSeen, ++pairStamp);
          if (c < pairCost) {
            pairCost = c;
            pairType = t;
          }
        }
      }
      if (wantMinsum) {
        const raw = out.get('minsum');
        raw[at] = minType;
        raw.set(trials[minType], at + 1);
      }
      if (wantPairs) {
        const raw = out.get('pairs');
        raw[at] = pairType;
        raw.set(trials[pairType], at + 1);
      }
    }
  }
  return out;
}

// Brute-force filtered stream for one form: every row's filter is the one
// whose trial row deflates smallest against the stream built so far (the
// preceding bytes as dictionary), which prices in the matches a row can
// reuse from its neighbours — the choice the cheap cost models only guess.
// Only narrow forms (palette, grey, grey+alpha) pay for this: their rows
// are short, so the thousands of small deflate trials stay affordable.
function bruteFiltered(samples, width, height, bpp) {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  const raw = new Uint8Array(height * rowBytes);
  const trial = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowBytes;
    const before = raw.subarray(Math.max(0, at - 4096), at);
    let bestType = 0;
    let bestSize = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      filterRow(t, cur, prev, bpp, trial.subarray(1));
      const size = deflateSync(trial, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: Buffer.from(before) }).length;
      if (size < bestSize) {
        bestSize = size;
        bestType = t;
      }
    }
    raw[at] = bestType;
    filterRow(bestType, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---------------------------------------------------------------------------
// A deflate compressor of our own: hash-chain match finding, a lazy parse,
// then cost-optimal re-parses driven by Huffman statistics of the previous
// parse (the zopfli idea, written from the deflate format up). Emits one zlib
// stream; the caller verifies it inflates back to the exact input.
// ---------------------------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_SYMBOL = new Uint8Array(259);
const DIST_SYMBOL = new Uint8Array(32769);
for (let s = 0; s < 29; s++) {
  const hi = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
  for (let l = LEN_BASE[s]; l <= hi; l++) LEN_SYMBOL[l] = s;
}
for (let s = 0; s < 30; s++) {
  const hi = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
  for (let d = DIST_BASE[s]; d <= hi; d++) DIST_SYMBOL[d] = s;
}

// Code lengths for a frequency table, limited to maxBits: plain Huffman
// depths first; when a depth overflows the limit, the length counts are
// repaired the way zlib repairs them and lengths are handed out by frequency.
function huffmanLengths(freq, maxBits) {
  const lengths = new Int32Array(freq.length);
  const used = [];
  for (let s = 0; s < freq.length; s++) if (freq[s] > 0) used.push(s);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  // Huffman depths via repeated two-smallest merging on a simple heap of
  // [weight, depth, symbolOrNode]. Nodes are tracked through parent links.
  const total = used.length;
  const weights = used.map((s) => freq[s]);
  const parent = new Int32Array(2 * total).fill(-1);
  const heapW = [];
  const heapId = [];
  const heapPush = (w, id) => {
    heapW.push(w);
    heapId.push(id);
    let i = heapW.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapW[p] <= heapW[i]) break;
      [heapW[p], heapW[i]] = [heapW[i], heapW[p]];
      [heapId[p], heapId[i]] = [heapId[i], heapId[p]];
      i = p;
    }
  };
  const heapPop = () => {
    const topW = heapW[0];
    const topId = heapId[0];
    const lastW = heapW.pop();
    const lastId = heapId.pop();
    if (heapW.length > 0) {
      heapW[0] = lastW;
      heapId[0] = lastId;
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        let r = l + 1;
        let m = i;
        if (l < heapW.length && heapW[l] < heapW[m]) m = l;
        if (r < heapW.length && heapW[r] < heapW[m]) m = r;
        if (m === i) break;
        [heapW[m], heapW[i]] = [heapW[i], heapW[m]];
        [heapId[m], heapId[i]] = [heapId[i], heapId[m]];
        i = m;
      }
    }
    return [topW, topId];
  };
  for (let i = 0; i < total; i++) heapPush(weights[i], i);
  let nodes = total;
  while (heapW.length > 1) {
    const [w1, id1] = heapPop();
    const [w2, id2] = heapPop();
    parent[id1] = nodes;
    parent[id2] = nodes;
    heapPush(w1 + w2, nodes);
    nodes++;
  }
  let maxDepth = 0;
  for (let i = 0; i < total; i++) {
    let depth = 0;
    let p = i;
    while (parent[p] !== -1) {
      depth++;
      p = parent[p];
    }
    lengths[used[i]] = depth;
    if (depth > maxDepth) maxDepth = depth;
  }
  if (maxDepth <= maxBits) return lengths;
  // Overflow: fall back to package-merge, which is exact for the limited
  // problem. Items carry, per leaf, how many times the leaf is packed in;
  // a leaf's final count over the last list is its code length.
  const syms = [...used].sort((a, b) => freq[a] - freq[b] || a - b);
  const m = syms.length;
  const leafItem = (k) => {
    const c = new Uint16Array(m);
    c[k] = 1;
    return { w: freq[syms[k]], c };
  };
  const leaves = syms.map((_, k) => leafItem(k));
  let list = leaves;
  for (let level = 1; level < maxBits; level++) {
    const packages = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      const a = list[i];
      const b = list[i + 1];
      const c = new Uint16Array(m);
      for (let k = 0; k < m; k++) c[k] = a.c[k] + b.c[k];
      packages.push({ w: a.w + b.w, c });
    }
    const merged = [];
    let li = 0;
    let pi = 0;
    while (li < leaves.length || pi < packages.length) {
      if (pi >= packages.length || (li < leaves.length && leaves[li].w <= packages[pi].w)) merged.push(leaves[li++]);
      else merged.push(packages[pi++]);
    }
    list = merged.slice(0, 2 * m - 2);
  }
  lengths.fill(0);
  for (const item of list) {
    for (let k = 0; k < m; k++) lengths[syms[k]] += item.c[k];
  }
  return lengths;
}

// Canonical codes from lengths, bit-reversed for the LSB-first writer.
function canonicalCodes(lengths) {
  const maxBits = Math.max(...lengths, 0);
  const blCount = new Int32Array(maxBits + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l === 0) continue;
    const c = next[l]++;
    let rev = 0;
    for (let b = 0; b < l; b++) rev = (rev << 1) | ((c >>> b) & 1);
    codes[s] = rev;
  }
  return codes;
}

// Longest-match pre-pass: for every position, walk the hash chain of its
// 3-byte prefix newest-first and record the Pareto frontier of (length,
// distance): candidates arrive in distance-ascending order, so the
// frontier is exactly the record-breaking lengths of the walk — for every
// match length, the cheapest distance that reaches it (the same submatch
// information zopfli's cache keeps). Packed as (dist << 9) | len in a
// pooled array with per-position offsets.
function findMatches(data, chainLimit) {
  const n = data.length;
  const lens = new Uint16Array(n);
  const dists = new Uint32Array(n);
  const offs = new Uint32Array(n + 1);
  let poolArr = new Uint32Array(1 << 22);
  let poolLen = 0;
  const HASH_BITS = 15;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashOf = (i) => ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 0x9e3779b1 >>> (32 - HASH_BITS);
  // (Positions inside a long match still get their own search: inheriting
  // the enclosing match capped their lengths and cost more bytes than the
  // time it saved, measured on the practice set.)
  // Word view of the data (padded copy) for fast unaligned 4-byte compares.
  const padded = new Uint8Array(n + 8);
  padded.set(data);
  const words = new Uint32Array(padded.buffer);
  const wordAt = (p) => {
    const o = p & 3;
    const idx = p >> 2;
    return o === 0 ? words[idx] : (words[idx] >>> (o << 3)) | (words[idx + 1] << (32 - (o << 3)));
  };
  const fLen = new Int32Array(16);
  const fDist = new Int32Array(16);
  for (let i = 0; i < n; i++) {
    offs[i] = poolLen;
    if (i + 2 < n) {
      let cand = head[hashOf(i)];
      let bestLen = 0;
      let bestDist = 0;
      let m = 0;
      let steps = chainLimit;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && steps-- > 0) {
        const dist = i - cand;
        if (dist > 32768) break;
        if (bestLen < maxLen && data[cand + bestLen] === data[i + bestLen]) {
          // Extend the match four bytes at a time through unaligned words.
          let l = 0;
          while (l + 4 <= maxLen && wordAt(cand + l) === wordAt(i + l)) l += 4;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = dist;
            if (m < 16) {
              fLen[m] = l;
              fDist[m] = dist;
              m++;
            }
            if (l >= maxLen) break;
            // A long match is nearly as good as the longest: stop walking
            // the chain soon after finding one (measured: relaxing the old
            // tight cutoffs was worth several percent on rich/alpha data).
            if (bestLen >= 96) break;
            if (bestLen >= 32 && steps > 64) steps = 64;
          }
        }
        cand = prev[cand];
      }
      if (bestLen >= 3) {
        lens[i] = bestLen;
        dists[i] = bestDist;
        if (poolLen + m > poolArr.length) {
          const bigger = new Uint32Array(poolArr.length * 2);
          bigger.set(poolArr);
          poolArr = bigger;
        }
        for (let k = 0; k < m; k++) poolArr[poolLen++] = (fDist[k] << 9) | fLen[k];
      }
      const h = hashOf(i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  offs[n] = poolLen;
  return { lens, dists, offs, pool: poolArr.subarray(0, poolLen) };
}

// Lazy parse driven by the precomputed matches.
function lazyParse(data, matches) {
  const n = data.length;
  const types = [];
  const vals = [];
  const dsts = [];
  let i = 0;
  while (i < n) {
    let l = matches.lens[i];
    if (l >= 3) {
      // Defer while the next position starts a longer match.
      while (i + 1 < n && matches.lens[i + 1] > l && l < 258) {
        types.push(0);
        vals.push(data[i]);
        dsts.push(0);
        i++;
        l = matches.lens[i];
        if (l < 3) break;
      }
      if (l >= 3) {
        types.push(1);
        vals.push(l);
        dsts.push(matches.dists[i]);
        i += l;
        continue;
      }
    }
    types.push(0);
    vals.push(data[i]);
    dsts.push(0);
    i++;
  }
  return { types: Uint8Array.from(types), vals: Uint32Array.from(vals), dsts: Uint32Array.from(dsts) };
}

// Symbol frequencies of a parse, per block span of the underlying data.
function parseFreqs(tokens) {
  const litFreq = new Float64Array(286);
  const distFreq = new Float64Array(30);
  for (let t = 0; t < tokens.types.length; t++) {
    if (tokens.types[t] === 0) litFreq[tokens.vals[t]]++;
    else {
      litFreq[257 + LEN_SYMBOL[tokens.vals[t]]]++;
      distFreq[DIST_SYMBOL[tokens.dsts[t]]]++;
    }
  }
  litFreq[256] = 1;
  return { litFreq, distFreq };
}

// Cost-optimal parse of the data range [start, end): backward dynamic
// programming with the bit costs of the previous parse's Huffman tables.
// Match lengths are tried exhaustively up to 34 and at length-code
// boundaries above that, for every recorded distance option.
function optimalParse(data, matches, litLens, distLens, start = 0, end = data.length) {
  const n = end;
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLens[s] > 0 ? litLens[s] : 64;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYMBOL[l];
    lenCost[l] = litCost[257 + s] + LEN_EXTRA[s];
  }
  const distCostCache = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = DIST_SYMBOL[d];
    distCostCache[d] = (distLens[s] > 0 ? distLens[s] : 64) + DIST_EXTRA[s];
  }
  const BOUNDARY = [35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const dp = new Float64Array(n + 1);
  const choiceLen = new Uint16Array(n);
  const choiceDist = new Uint32Array(n);
  for (let i = n - 1; i >= start; i--) {
    let best = dp[i + 1] + litCost[data[i]];
    let bestL = 0;
    let bestD = 0;
    // Frontier bands: entry k covers lengths (prevLen, len_k] at its dist —
    // for each band, try lengths exhaustively to 34, at length-code
    // boundaries above that, and at the band's own achieved length.
    const o0 = matches.offs[i];
    const o1 = matches.offs[i + 1];
    if (o1 > o0) {
      const lim = Math.min(matches.lens[i], n - i);
      let prevLen = 2;
      for (let k = o0; k < o1; k++) {
        const packed = matches.pool[k];
        const fl = packed & 511;
        const fd = packed >>> 9;
        const dc = distCostCache[fd];
        const hi = Math.min(fl, lim);
        const lo = Math.max(3, prevLen + 1);
        const small = Math.min(hi, 34);
        for (let l = lo; l <= small; l++) {
          const c = dp[i + l] + lenCost[l] + dc;
          if (c < best) {
            best = c;
            bestL = l;
            bestD = fd;
          }
        }
        for (const l of BOUNDARY) {
          if (l >= lo && l > 34 && l <= hi) {
            const c = dp[i + l] + lenCost[l] + dc;
            if (c < best) {
              best = c;
              bestL = l;
              bestD = fd;
            }
          }
        }
        if (hi > 34 && !BOUNDARY.includes(hi)) {
          const c = dp[i + hi] + lenCost[hi] + dc;
          if (c < best) {
            best = c;
            bestL = hi;
            bestD = fd;
          }
        }
        prevLen = fl;
        if (fl >= lim) break;
      }
    }
    dp[i] = best;
    choiceLen[i] = bestL;
    choiceDist[i] = bestD;
  }
  const types = [];
  const vals = [];
  const dsts = [];
  let i = start;
  while (i < n) {
    const l = choiceLen[i];
    if (l >= 3) {
      types.push(1);
      vals.push(l);
      dsts.push(choiceDist[i]);
      i += l;
    } else {
      types.push(0);
      vals.push(data[i]);
      dsts.push(0);
      i++;
    }
  }
  return { types: Uint8Array.from(types), vals: Uint32Array.from(vals), dsts: Uint32Array.from(dsts) };
}

// Bit writer (LSB first) and deflate block emission.
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  bits(value, count) {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const FIXED_LIT_LENS = (() => {
  const a = new Int32Array(288);
  for (let s = 0; s < 288; s++) a[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  return a;
})();
const FIXED_DIST_LENS = new Int32Array(30).fill(5);

// Run-length encoding of a combined code-length sequence, as symbol/extra
// pairs for the dynamic header.
function rleLengths(seq) {
  const out = []; // [symbol, extraValue, extraBits]
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        out.push([18, take - 11, 7]);
        left -= take;
      }
      if (left >= 3) {
        out.push([17, left - 3, 3]);
        left = 0;
      }
      while (left-- > 0) out.push([0, 0, 0]);
    } else {
      out.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        out.push([16, take - 3, 2]);
        left -= take;
      }
      while (left-- > 0) out.push([v, 0, 0]);
    }
    i += run;
  }
  return out;
}

// Exact bit cost and emission of one block. Returns {bits, write} where the
// cheaper of dynamic vs fixed Huffman wins; write(w) appends to a BitWriter.
function planBlock(tokens, from, to) {
  const litFreq = new Float64Array(286);
  const distFreq = new Float64Array(30);
  let hasMatch = false;
  for (let t = from; t < to; t++) {
    if (tokens.types[t] === 0) litFreq[tokens.vals[t]]++;
    else {
      hasMatch = true;
      litFreq[257 + LEN_SYMBOL[tokens.vals[t]]]++;
      distFreq[DIST_SYMBOL[tokens.dsts[t]]]++;
    }
  }
  litFreq[256]++;
  const litLens = huffmanLengths(litFreq, 15);
  let distLens = huffmanLengths(distFreq, 15);
  if (!hasMatch) distLens = Int32Array.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // Dynamic header geometry.
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = [...litLens.slice(0, hlit), ...distLens.slice(0, hdist)];
  const rle = rleLengths(seq);
  const clFreq = new Float64Array(19);
  for (const [sym] of rle) clFreq[sym]++;
  const clLens = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let dynBits = 3 + 5 + 5 + 4 + hclen * 3;
  for (const s of seq) dynBits += 0; // lengths are sent via the RLE below
  const clCodes = canonicalCodes(clLens);
  for (const [sym, , extraBits] of rle) dynBits += clLens[sym] + extraBits;
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  let dynPayload = 0;
  for (let t = from; t < to; t++) {
    if (tokens.types[t] === 0) dynPayload += litLens[tokens.vals[t]];
    else {
      const ls = LEN_SYMBOL[tokens.vals[t]];
      const ds = DIST_SYMBOL[tokens.dsts[t]];
      dynPayload += litLens[257 + ls] + LEN_EXTRA[ls] + distLens[ds] + DIST_EXTRA[ds];
    }
  }
  dynPayload += litLens[256];
  dynBits += dynPayload;
  // Fixed Huffman cost.
  const fixedLitCodes = canonicalCodes(FIXED_LIT_LENS);
  const fixedDistCodes = canonicalCodes(FIXED_DIST_LENS);
  let fixedBits = 3;
  for (let t = from; t < to; t++) {
    if (tokens.types[t] === 0) fixedBits += FIXED_LIT_LENS[tokens.vals[t]];
    else {
      const ls = LEN_SYMBOL[tokens.vals[t]];
      const ds = DIST_SYMBOL[tokens.dsts[t]];
      fixedBits += FIXED_LIT_LENS[257 + ls] + LEN_EXTRA[ls] + FIXED_DIST_LENS[ds] + DIST_EXTRA[ds];
    }
  }
  fixedBits += FIXED_LIT_LENS[256];
  const useDyn = dynBits <= fixedBits;
  const write = (w, isFinal) => {
    w.bits(isFinal ? 1 : 0, 1);
    if (useDyn) {
      w.bits(2, 2);
      w.bits(hlit - 257, 5);
      w.bits(hdist - 1, 5);
      w.bits(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) w.bits(clLens[CL_ORDER[i]], 3);
      for (const [sym, extra, extraBits] of rle) {
        w.bits(clCodes[sym], clLens[sym]);
        if (extraBits > 0) w.bits(extra, extraBits);
      }
      emitTokens(w, tokens, from, to, litCodes, litLens, distCodes, distLens);
    } else {
      w.bits(1, 2);
      emitTokens(w, tokens, from, to, fixedLitCodes, FIXED_LIT_LENS, fixedDistCodes, FIXED_DIST_LENS);
    }
  };
  return { bits: useDyn ? dynBits : fixedBits, write };
}

function emitTokens(w, tokens, from, to, litCodes, litLens, distCodes, distLens) {
  for (let t = from; t < to; t++) {
    if (tokens.types[t] === 0) {
      const s = tokens.vals[t];
      w.bits(litCodes[s], litLens[s]);
    } else {
      const len = tokens.vals[t];
      const ls = LEN_SYMBOL[len];
      w.bits(litCodes[257 + ls], litLens[257 + ls]);
      if (LEN_EXTRA[ls] > 0) w.bits(len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const dist = tokens.dsts[t];
      const ds = DIST_SYMBOL[dist];
      w.bits(distCodes[ds], distLens[ds]);
      if (DIST_EXTRA[ds] > 0) w.bits(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.bits(litCodes[256], litLens[256]);
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    if (a >= 65521) a -= 65521;
    b += a;
    if (b >= 4294967296) b %= 65521;
  }
  b %= 65521;
  return ((b << 16) | a) >>> 0;
}

// Compress `data` into a zlib stream with the parse/Huffman iteration loop.
// Effort (chain length, iterations, block span) scales with data size so the
// whole set stays inside its wall on one CPU.
function squeeze(data) {
  const n = data.length;
  const chain = n <= 400000 ? 384 : n <= 1500000 ? 512 : 128;
  const iterations = n > 1500000 ? 1 : 2;
  const matches = findMatches(data, chain);
  let tokens = lazyParse(data, matches);
  // (A per-block re-parse with per-block Huffman statistics was tried and
  // measured worse on the practice set; the global-statistics parse below
  // stays.)
  for (let it = 0; it < iterations; it++) {
    const { litFreq, distFreq } = parseFreqs(tokens);
    // The parse is priced with entropy costs (-log2 of the previous
    // parse's symbol frequencies), not with the previous parse's integer
    // Huffman lengths: fractional bit costs track the true price of a
    // token far better, measured on rich and alpha data. The Huffman
    // lengths themselves are only needed again at emission time.
    const litTotal = litFreq.reduce((a, b) => a + b, 0);
    const distTotal = distFreq.reduce((a, b) => a + b, 0);
    const litLens = Float64Array.from(litFreq, (f) => -Math.log2(Math.max(f, 1) / litTotal));
    const distLens = Float64Array.from(distFreq, (f) => -Math.log2(Math.max(f, 1) / distTotal));
    tokens = optimalParse(data, matches, litLens, distLens);
  }
  // Split the token stream into blocks where the split pays: recursively
  // try 23 evenly spaced split points per range and keep the best when it
  // saves more than 150 bits by exact block cost (each block re-derives
  // its Huffman tables, so splits track the image's changing statistics —
  // the fixed data-span blocks this replaces left real bytes behind).
  const bitsOf = (from, to) => planBlock(tokens, from, to).bits;
  const splitRec = (from, to, depth) => {
    if (depth === 0 || to - from < 3000) return [[from, to]];
    const whole = bitsOf(from, to);
    let bestGain = 150;
    let bestAt = -1;
    for (let k = 1; k < 24; k++) {
      const at = from + Math.floor(((to - from) * k) / 24);
      if (at <= from || at >= to) continue;
      const gain = whole - bitsOf(from, at) - bitsOf(at, to);
      if (gain > bestGain) {
        bestGain = gain;
        bestAt = at;
      }
    }
    if (bestAt < 0) return [[from, to]];
    return [...splitRec(from, bestAt, depth - 1), ...splitRec(bestAt, to, depth - 1)];
  };
  const spans = splitRec(0, tokens.types.length, 3);
  const w = new BitWriter();
  spans.forEach(([from, to], idx) => {
    planBlock(tokens, from, to).write(w, idx === spans.length - 1);
  });
  const body = w.finish();
  const adler = adler32(data);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  out[body.length + 2] = (adler >>> 24) & 0xff;
  out[body.length + 3] = (adler >>> 16) & 0xff;
  out[body.length + 4] = (adler >>> 8) & 0xff;
  out[body.length + 5] = adler & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Candidate compression for one image: screen every form and filter strategy
// at a fast zlib setting, then re-deflate the leaders at full effort.
// ---------------------------------------------------------------------------
const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_OPTS_LIST = [
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
];

function extraBytes(form) {
  return (form.plte ? form.plte.length + 12 : 0) + (form.trns ? form.trns.length + 12 : 0);
}

function compressImage(width, height, rgba) {
  const info = analyse(rgba);
  const forms = formsOf(rgba, info);
  // Full screening of every dataset. (Two shortcuts were tried and
  // reverted on generated-set validation: trimming the wide forms'
  // strategy list — the 'pairs' dataset feeds the winning squeeze on
  // alpha/rich images — and prefix-only pre-screening, which mis-ranked
  // datasets whose advantage only appears in later rows.)
  const screened = [];
  for (const form of forms) {
    const strategies = form.colourType === 3 ? [0, 'minsum', 'pairs'] : [0, 1, 2, 4, 'minsum', 'pairs'];
    const variants = filteredVariants(form.samples, width, height, form.bpp, strategies);
    for (const strategy of strategies) {
      const data = variants.get(strategy);
      const zipped = deflateSync(data, SCREEN_OPTS);
      screened.push({ form, data, size: zipped.length + extraBytes(form) });
    }
  }
  screened.sort((a, b) => a.size - b.size);
  let best = null;
  const leaders = screened.slice(0, 2);
  leaders.forEach((cand, idx) => {
    const optsList = idx === 0 ? FINAL_OPTS_LIST : [FINAL_OPTS_LIST[1]];
    for (const opts of optsList) {
      const zipped = deflateSync(cand.data, opts);
      const file = pngFile(width, height, cand.form, zipped);
      if (best === null || file.length < best.length) best = file;
    }
  });
  // A brute-force-filtered stream for a narrow leading form joins the
  // pool: its rows were chosen by real deflate trials, not a cost model.
  const leadForm = screened[0].form;
  let bruteData = null;
  let bruteFile = null;
  if (leadForm.bpp <= 2) {
    bruteData = bruteFiltered(leadForm.samples, width, height, leadForm.bpp);
    bruteFile = pngFile(width, height, leadForm, deflateSync(bruteData, FINAL_OPTS_LIST[1]));
    if (bruteFile.length < best.length) best = bruteFile;
  }
  // Our own deflate: both datasets when they are small (the zlib ranking
  // is an imperfect proxy for the squeezed ranking), otherwise only the
  // zlib winner. A stream is kept only when it inflates back to the exact
  // bytes it was given.
  const squeezePool = [screened[0]];
  if (bruteData !== null) {
    if (bruteData.length <= 950000) squeezePool.push({ form: leadForm, data: bruteData });
    else if (bruteFile.length < best.length) squeezePool[0] = { form: leadForm, data: bruteData };
  }
  for (const cand of squeezePool) {
    try {
      const zipped = squeeze(cand.data);
      const back = inflateSync(zipped);
      if (back.length === cand.data.length && Buffer.from(cand.data).equals(back)) {
        const file = pngFile(width, height, cand.form, zipped);
        if (file.length < best.length) best = file;
      }
    } catch {
      // A failed experiment must never lose the zlib result already in hand.
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Entry point: every instance directory under the input root, in order.
// ---------------------------------------------------------------------------
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const bytes = readFileSync(join(INPUT_DIR, id, 'image.png'));
  const { width, height, rgba } = decodeStoredPng(new Uint8Array(bytes));
  const out = compressImage(width, height, rgba);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), out);
}

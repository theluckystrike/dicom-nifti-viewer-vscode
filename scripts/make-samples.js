'use strict';
// Writes synthetic phantoms (made-up shapes, made-up names, no real patient data) as DICOM and NIfTI.
// Usage: node scripts/make-samples.js <out dir>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { deflateSync, gzipSync } = require('fflate');
const { encodeRleFrame } = require('../src/core/rle');

const TS = { implicit: '1.2.840.10008.1.2', explicit: '1.2.840.10008.1.2.1', deflated: '1.2.840.10008.1.2.1.99', big: '1.2.840.10008.1.2.2', rle: '1.2.840.10008.1.2.5', j2k: '1.2.840.10008.1.2.4.90' };
const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UC', 'UR']);
const CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
const MR_IMAGE = '1.2.840.10008.5.1.4.1.1.4';
const US_IMAGE = '1.2.840.10008.5.1.4.1.1.6.1';
const SC_IMAGE = '1.2.840.10008.5.1.4.1.1.7';

function uid(seed) {
  const h = crypto.createHash('sha1').update('zovo-phantom:' + seed).digest();
  return '2.25.' + BigInt('0x' + h.subarray(0, 15).toString('hex')).toString();
}
const ds = (v) => { let s = String(+(+v).toFixed(6)); if (s.length > 16) s = (+v).toPrecision(10); return s; };

/** One element: [group, element, VR, value]. value: string, number[], Uint8Array, or items (array of element lists) for SQ. */
function encodeElements(elements, { explicit = true, little = true } = {}) {
  const parts = [];
  const u16 = (v) => { const b = Buffer.alloc(2); little ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); little ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return b; };
  const sorted = elements.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [g, e, vr, value] of sorted) {
    let body;
    if (vr === 'SQ') {
      const items = value.map((it) => { const inner = encodeElements(it, { explicit, little }); return Buffer.concat([u16(0xfffe), u16(0xe000), u32(inner.length), inner]); });
      body = Buffer.concat(items);
    } else if (vr === 'US') body = Buffer.concat(value.map(u16));
    else if (vr === 'UL') body = Buffer.concat(value.map(u32));
    else if (value instanceof Uint8Array) body = Buffer.from(value);
    else body = Buffer.from(String(value), 'latin1');
    if (body.length % 2) body = Buffer.concat([body, Buffer.from([vr === 'UI' || vr === 'OB' ? 0 : 0x20])]);
    const head = [u16(g), u16(e)];
    if (!explicit) head.push(u32(body.length));
    else if (LONG_VR.has(vr)) head.push(Buffer.from(vr, 'latin1'), Buffer.alloc(2), u32(body.length));
    else head.push(Buffer.from(vr, 'latin1'), u16(body.length));
    parts.push(...head, body);
  }
  return Buffer.concat(parts);
}

/** Encapsulated pixel data: empty basic offset table, one fragment per frame, sequence delimiter. */
function encapsulated(frames) {
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const parts = [u16(0x7fe0), u16(0x0010), Buffer.from('OB'), Buffer.alloc(2), u32(0xffffffff), u16(0xfffe), u16(0xe000), u32(0)];
  for (const f of frames) { let b = Buffer.from(f); if (b.length % 2) b = Buffer.concat([b, Buffer.alloc(1)]); parts.push(u16(0xfffe), u16(0xe000), u32(b.length), b); }
  parts.push(u16(0xfffe), u16(0xe0dd), u32(0));
  return Buffer.concat(parts);
}

/** Part 10 file: preamble, DICM, explicit LE meta group, then the data set in the chosen syntax. */
function part10(elements, { ts = TS.explicit, sopClass, sopInstance, pixelFragments = null }) {
  const meta = [
    [0x0002, 0x0001, 'OB', new Uint8Array([0, 1])], [0x0002, 0x0002, 'UI', sopClass], [0x0002, 0x0003, 'UI', sopInstance],
    [0x0002, 0x0010, 'UI', ts], [0x0002, 0x0012, 'UI', uid('impl')], [0x0002, 0x0013, 'SH', 'ZOVO_PHANTOM'],
  ];
  const metaBody = encodeElements(meta);
  const gl = encodeElements([[0x0002, 0x0000, 'UL', [metaBody.length]]]);
  const explicit = ts !== TS.implicit;
  const little = ts !== TS.big;
  let body = encodeElements(elements, { explicit, little });
  if (pixelFragments) body = Buffer.concat([body, encapsulated(pixelFragments)]);
  if (ts === TS.deflated) body = Buffer.from(deflateSync(body, { level: 6 }));
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), gl, metaBody, body]);
}

function pixelBytes(values, bits, little = true) {
  const b = Buffer.alloc(values.length * (bits / 8));
  for (let i = 0; i < values.length; i++) {
    if (bits === 8) b[i] = values[i];
    else if (little) b.writeUInt16LE(values[i] & 0xffff, i * 2);
    else b.writeUInt16BE(values[i] & 0xffff, i * 2);
  }
  return b;
}

// ---- Phantoms (patient LPS millimetres: +x left, +y posterior, +z head) ----
function rand(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const inEll = (x, y, cx, cy, ax, ay) => ((x - cx) / ax) ** 2 + ((y - cy) / ay) ** 2 <= 1;

function chestHU(x, y, z) {
  const zf = Math.max(0, 1 - (z / 130) ** 2); // lungs taper toward the ends
  if (!inEll(x, y, 0, 0, 165, 115)) return -1000;
  if (!inEll(x, y, 0, 0, 157, 107)) return 30; // skin
  if (!inEll(x, y, 0, 0, 147, 97)) return -100; // fat
  // spine (posterior), cortex and cancellous bone
  if (inEll(x, y, 0, 72, 20, 18)) return inEll(x, y, 0, 72, 15, 13) ? 250 : 900;
  if (inEll(x, y, 0, 52, 10, 9)) return 30; // spinal canal
  // ribs, cut as short arcs inside the chest wall
  const ang = Math.atan2(y, x);
  if (inEll(x, y, 0, 0, 140, 90) && !inEll(x, y, 0, 0, 132, 82) && Math.sin(ang * 9 + z / 11) > 0.55) return 850;
  // aorta and heart (heart toward patient left = +x)
  if (inEll(x, y, -18, 38, 13, 13)) return 55;
  if (z < 60 && inEll(x, y, 22, -10, 58 * Math.sqrt(zf) + 5, 48 * Math.sqrt(zf) + 5)) return 45;
  // lungs with vessels
  for (const side of [-1, 1]) {
    if (inEll(x, y, side * 72, 0, 52 * zf + 4, 72 * zf + 4) && zf > 0.05) {
      const v = Math.sin(x / 7 + z / 13) * Math.cos(y / 9 - z / 17);
      return v > 0.93 ? 40 : -860;
    }
  }
  if (inEll(x, y, 0, -60, 45, 25)) return 55; // sternum soft tissue
  return 40; // muscle and mediastinum
}

function headHU(x, y, z) {
  const s = Math.max(0.2, Math.sqrt(Math.max(0, 1 - (z / 95) ** 2)));
  const ax = 78 * s; const ay = 95 * s;
  if (!inEll(x, y, 0, 0, ax + 6, ay + 6)) return -1000;
  if (!inEll(x, y, 0, 0, ax, ay)) return 40; // scalp
  if (!inEll(x, y, 0, 0, ax - 7, ay - 7)) return 1100; // skull
  if (!inEll(x, y, 0, 0, ax - 9, ay - 9)) return 8; // CSF
  if (Math.abs(z) < 30 && (inEll(x, y, -9, -8, 5, 26) || inEll(x, y, 9, -8, 5, 26))) return 6; // ventricles
  if (!inEll(x, y, 0, 0, ax - 17, ay - 17)) return 38; // gray matter
  return 29; // white matter
}

function mrBrain(x, y, z) {
  const hu = headHU(x, y, z);
  return { '-1000': 0, 40: 420, 1100: 60, 8: 180, 6: 170, 38: 640, 29: 880 }[hu] ?? 0;
}

function ctSlice(fn, n, ps, z, noise, r) {
  const out = new Int16Array(n * n);
  const x0 = -(n - 1) * ps / 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const hu = fn(x0 + i * ps, x0 + j * ps, z);
    out[j * n + i] = Math.max(-1024, Math.round(hu + (hu > -990 ? (r() - 0.5) * noise : 0)));
  }
  return out;
}

const patient = (named) => named
  ? [[0x0010, 0x0010, 'PN', 'PHANTOM^DEMO'], [0x0010, 0x0020, 'LO', 'SYN-0001'], [0x0010, 0x0030, 'DA', '19700101'], [0x0010, 0x0040, 'CS', 'O']]
  : [[0x0010, 0x0010, 'PN', ''], [0x0010, 0x0020, 'LO', ''], [0x0010, 0x0040, 'CS', 'O'], [0x0012, 0x0062, 'CS', 'YES'], [0x0012, 0x0063, 'LO', 'Synthetic phantom, never a patient']];

function imageElements({ sopClass, sopInstance, modality, seriesUid, studyUid, seriesNumber, desc, instance, rows, cols, ps, pos, ori, extra = [] }) {
  return [
    [0x0008, 0x0005, 'CS', 'ISO_IR 100'], [0x0008, 0x0008, 'CS', 'DERIVED\\SECONDARY\\AXIAL'], [0x0008, 0x0016, 'UI', sopClass], [0x0008, 0x0018, 'UI', sopInstance],
    [0x0008, 0x0020, 'DA', '20261106'], [0x0008, 0x0060, 'CS', modality], [0x0008, 0x0070, 'LO', 'Zovo synthetic phantom'], [0x0008, 0x1030, 'LO', 'Phantom study'],
    [0x0008, 0x103e, 'LO', desc], [0x0020, 0x000d, 'UI', studyUid], [0x0020, 0x000e, 'UI', seriesUid], [0x0020, 0x0011, 'IS', String(seriesNumber)],
    [0x0020, 0x0013, 'IS', String(instance)],
    ...(pos ? [[0x0020, 0x0032, 'DS', pos.map(ds).join('\\')]] : []),
    ...(ori ? [[0x0020, 0x0037, 'DS', ori.map(ds).join('\\')]] : []),
    [0x0028, 0x0010, 'US', [rows]], [0x0028, 0x0011, 'US', [cols]], [0x0028, 0x0030, 'DS', `${ds(ps)}\\${ds(ps)}`],
    ...extra,
  ];
}

/** Chest CT series: n slices of 256 x 256, files without extension named in a DICOMDIR (CT/IM000001 ...). */
function chestSeries(slices = 48, size = 256) {
  const ps = 1.25; const dz = 5; const r = rand(7);
  const studyUid = uid('chest-study'); const seriesUid = uid('chest-series');
  const files = [];
  for (let k = 0; k < slices; k++) {
    const z = -((slices - 1) * dz) / 2 + k * dz;
    const hu = ctSlice(chestHU, size, ps, z, 24, r);
    const stored = Uint16Array.from(hu, (v) => v + 1024);
    const sop = uid('chest-' + k);
    const el = imageElements({
      sopClass: CT_IMAGE, sopInstance: sop, modality: 'CT', seriesUid, studyUid, seriesNumber: 2, desc: 'Chest phantom 5 mm', instance: slices - k,
      rows: size, cols: size, ps, pos: [-(size - 1) * ps / 2, -(size - 1) * ps / 2, z], ori: [1, 0, 0, 0, 1, 0],
      extra: [[0x0018, 0x0050, 'DS', '5'], [0x0018, 0x0060, 'DS', '120'], [0x0020, 0x1041, 'DS', ds(z)], [0x0028, 0x0002, 'US', [1]], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
        [0x0028, 0x0100, 'US', [16]], [0x0028, 0x0101, 'US', [12]], [0x0028, 0x0102, 'US', [11]], [0x0028, 0x0103, 'US', [0]],
        [0x0028, 0x1050, 'DS', '40'], [0x0028, 0x1051, 'DS', '400'], [0x0028, 0x1052, 'DS', '-1024'], [0x0028, 0x1053, 'DS', '1'], [0x0028, 0x1054, 'LO', 'HU'],
        ...patient(false), [0x7fe0, 0x0010, 'OW', pixelBytes(stored, 16)]],
    });
    // instance numbers run head to feet on purpose, so ordering must come from Image Position (Patient)
    files.push({ id: ['CT', `IM${String(k + 1).padStart(6, '0')}`], sop, bytes: part10(el, { sopClass: CT_IMAGE, sopInstance: sop }) });
  }
  const records = files.map((f) => [
    [0x0004, 0x1400, 'UL', [0]], [0x0004, 0x1410, 'US', [0xffff]], [0x0004, 0x1420, 'UL', [0]], [0x0004, 0x1430, 'CS', 'IMAGE'],
    [0x0004, 0x1500, 'CS', f.id.join('\\')], [0x0004, 0x1510, 'UI', CT_IMAGE], [0x0004, 0x1511, 'UI', f.sop], [0x0004, 0x1512, 'UI', TS.explicit],
  ]);
  const dir = part10([
    [0x0004, 0x1130, 'CS', 'PHANTOM'], [0x0004, 0x1200, 'UL', [0]], [0x0004, 0x1202, 'UL', [0]], [0x0004, 0x1212, 'US', [0]], [0x0004, 0x1220, 'SQ', records],
  ], { sopClass: '1.2.840.10008.1.3.10', sopInstance: uid('dicomdir') });
  return { files, dicomdir: dir };
}

/** Head CT slices as .dcm files in one folder, in the chosen transfer syntax. */
function headCt({ slices = 32, size = 192, ts = TS.explicit, named = false, seriesSeed = 'head', only = null } = {}) {
  const ps = 1.2; const dz = 4; const r = rand(11);
  const studyUid = uid(seriesSeed + '-study'); const seriesUid = uid(seriesSeed + '-series');
  const out = [];
  for (let k = 0; k < slices; k++) {
    if (only !== null && k !== only) continue;
    const z = -((slices - 1) * dz) / 2 + k * dz;
    const hu = ctSlice(headHU, size, ps, z, 6, r);
    const sop = uid(seriesSeed + '-' + k);
    const el = imageElements({
      sopClass: CT_IMAGE, sopInstance: sop, modality: 'CT', seriesUid, studyUid, seriesNumber: 3, desc: 'Head phantom', instance: k + 1,
      rows: size, cols: size, ps, pos: [-(size - 1) * ps / 2, -(size - 1) * ps / 2, z], ori: [1, 0, 0, 0, 1, 0],
      extra: [[0x0018, 0x0050, 'DS', '4'], [0x0028, 0x0002, 'US', [1]], [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
        [0x0028, 0x0100, 'US', [16]], [0x0028, 0x0101, 'US', [16]], [0x0028, 0x0102, 'US', [15]], [0x0028, 0x0103, 'US', [1]],
        [0x0028, 0x1050, 'DS', '40'], [0x0028, 0x1051, 'DS', '80'], [0x0028, 0x1052, 'DS', '0'], [0x0028, 0x1053, 'DS', '1'],
        ...patient(named), [0x7fe0, 0x0010, ts === TS.implicit ? 'OW' : 'OW', pixelBytes(hu, 16, ts !== TS.big)]],
    });
    out.push({ name: `head-${String(k + 1).padStart(3, '0')}.dcm`, z, hu, bytes: part10(el, { ts, sopClass: CT_IMAGE, sopInstance: sop }) });
  }
  return out;
}

/** Multi-frame MR brain, RLE Lossless, unsigned 16-bit. */
function mrRle(frames = 24, size = 192) {
  const ps = 1; const dz = 5; const r = rand(5);
  const pixFrames = []; const values = [];
  for (let k = 0; k < frames; k++) {
    const z = -((frames - 1) * dz) / 2 + k * dz;
    const v = new Uint16Array(size * size);
    const x0 = -(size - 1) * ps / 2;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const s = mrBrain(x0 + i * ps, x0 + j * ps, z * 1.1); v[j * size + i] = s ? Math.round(s + (r() - 0.5) * 40) : 0; }
    values.push(v);
    pixFrames.push(encodeRleFrame(pixelBytes(v, 16), size, size, 1, 16));
  }
  const sop = uid('mr-rle');
  const el = imageElements({
    sopClass: MR_IMAGE, sopInstance: sop, modality: 'MR', seriesUid: uid('mr-series'), studyUid: uid('mr-study'), seriesNumber: 4, desc: 'Brain phantom T1-like, RLE', instance: 1,
    rows: size, cols: size, ps, pos: null, ori: [1, 0, 0, 0, 1, 0],
    extra: [[0x0018, 0x0050, 'DS', '5'], [0x0018, 0x0088, 'DS', '5'], [0x0028, 0x0002, 'US', [1]], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0008, 'IS', String(frames)],
      [0x0028, 0x0100, 'US', [16]], [0x0028, 0x0101, 'US', [16]], [0x0028, 0x0102, 'US', [15]], [0x0028, 0x0103, 'US', [0]], ...patient(false)],
  });
  return { bytes: part10(el, { ts: TS.rle, sopClass: MR_IMAGE, sopInstance: sop, pixelFragments: pixFrames }), values };
}

/** Small RGB ultrasound-style frame, uncompressed, interleaved. */
function rgbUs(w = 160, h = 120) {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3; const dx = x - w / 2; const ang = Math.atan2(dx, y + 10); const rr = Math.hypot(dx, y + 10);
    const inFan = Math.abs(ang) < 0.7 && rr < h;
    const g = inFan ? Math.round(80 + 70 * Math.sin(rr / 6) * Math.cos(ang * 5)) : 0;
    px[o] = g; px[o + 1] = g; px[o + 2] = g;
    if (inFan && Math.hypot(dx + 10, y - 60) < 12) { px[o] = 200; px[o + 1] = 40; px[o + 2] = 40; }
    if (inFan && Math.hypot(dx - 15, y - 75) < 9) { px[o] = 40; px[o + 1] = 60; px[o + 2] = 210; }
  }
  const sop = uid('us-rgb');
  const el = imageElements({
    sopClass: US_IMAGE, sopInstance: sop, modality: 'US', seriesUid: uid('us-series'), studyUid: uid('us-study'), seriesNumber: 5, desc: 'Doppler-like colour phantom', instance: 1,
    rows: h, cols: w, ps: 0.3, pos: null, ori: null,
    extra: [[0x0028, 0x0002, 'US', [3]], [0x0028, 0x0004, 'CS', 'RGB'], [0x0028, 0x0006, 'US', [0]], [0x0028, 0x0100, 'US', [8]], [0x0028, 0x0101, 'US', [8]],
      [0x0028, 0x0102, 'US', [7]], [0x0028, 0x0103, 'US', [0]], ...patient(false), [0x7fe0, 0x0010, 'OB', px]],
  });
  return { bytes: part10(el, { sopClass: US_IMAGE, sopInstance: sop }), px };
}

/** A JPEG 2000 file: valid tags, a dummy compressed fragment. The viewer must show the tags and a clear message. */
function j2kFile() {
  const sop = uid('j2k');
  const el = imageElements({
    sopClass: SC_IMAGE, sopInstance: sop, modality: 'OT', seriesUid: uid('j2k-series'), studyUid: uid('j2k-study'), seriesNumber: 9, desc: 'JPEG 2000 sample (not decodable here)', instance: 1,
    rows: 64, cols: 64, ps: 1, pos: null, ori: null,
    extra: [[0x0028, 0x0002, 'US', [1]], [0x0028, 0x0004, 'CS', 'MONOCHROME2'], [0x0028, 0x0100, 'US', [16]], [0x0028, 0x0101, 'US', [12]], [0x0028, 0x0102, 'US', [11]], [0x0028, 0x0103, 'US', [0]], ...patient(false)],
  });
  const fake = new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0, 0x29, 0, 0, 0, 0, 0, 0x40, 0, 0, 0, 0x40]);
  return part10(el, { ts: TS.j2k, sopClass: SC_IMAGE, sopInstance: sop, pixelFragments: [fake] });
}

// ---- NIfTI-1 writer ----
function niftiFile({ dims, pix, datatype, bitpix, values, slope = 1, inter = 0, srow, descrip = '', calMin = 0, calMax = 0, littleEndian = true }) {
  const h = Buffer.alloc(352);
  const w16 = (v, o) => (littleEndian ? h.writeInt16LE(v, o) : h.writeInt16BE(v, o));
  const w32 = (v, o) => (littleEndian ? h.writeInt32LE(v, o) : h.writeInt32BE(v, o));
  const wf = (v, o) => (littleEndian ? h.writeFloatLE(v, o) : h.writeFloatBE(v, o));
  w32(348, 0);
  w16(dims.length, 40); dims.forEach((d, i) => w16(d, 42 + 2 * i));
  for (let i = dims.length + 1; i < 8; i++) w16(1, 40 + 2 * i);
  w16(datatype, 70); w16(bitpix, 72);
  wf(1, 76); pix.forEach((p, i) => wf(p, 80 + 4 * i));
  wf(352, 108); wf(slope, 112); wf(inter, 116); h.writeUInt8(10, 123); // xyzt_units: mm + sec
  wf(calMax, 124); wf(calMin, 128);
  h.write(descrip.slice(0, 79), 148, 'latin1');
  w16(0, 252); w16(srow ? 2 : 0, 254); // qform_code, sform_code
  if (srow) srow.flat().forEach((v, i) => wf(v, 280 + 4 * i));
  h.write('n+1\0', 344, 'latin1');
  const bpv = bitpix / 8; const data = Buffer.alloc(values.length * bpv);
  for (let i = 0; i < values.length; i++) {
    if (datatype === 4) littleEndian ? data.writeInt16LE(values[i], i * 2) : data.writeInt16BE(values[i], i * 2);
    else if (datatype === 16) littleEndian ? data.writeFloatLE(values[i], i * 4) : data.writeFloatBE(values[i], i * 4);
    else if (datatype === 2) data[i] = values[i];
  }
  return Buffer.concat([h, data]);
}

/** T1-like brain phantom, int16 with a scale factor, LAS sform (x axis runs to the patient's right in voxel order). */
function brainNifti({ nx = 128, ny = 150, nz = 110, vox = 1.4 } = {}) {
  const r = rand(3); const v = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // RAS mm, then LPS for the phantom function
    const xr = -(i - (nx - 1) / 2) * vox; const ya = (j - (ny - 1) / 2) * vox; const zs = (k - (nz - 1) / 2) * vox;
    const s = mrBrain(-xr, -ya, zs * 1.2);
    v[i + nx * (j + ny * k)] = s ? Math.round((s + (r() - 0.5) * 50) * 2) : 0; // stored x2, slope 0.5
  }
  const srow = [[-vox, 0, 0, (nx - 1) / 2 * vox], [0, vox, 0, -(ny - 1) / 2 * vox], [0, 0, vox, -(nz - 1) / 2 * vox]];
  return { buf: niftiFile({ dims: [nx, ny, nz], pix: [vox, vox, vox], datatype: 4, bitpix: 16, values: v, slope: 0.5, inter: 0, srow, descrip: 'Zovo synthetic brain phantom', calMin: 0, calMax: 1000 }), stored: v, dims: [nx, ny, nz] };
}

/** Small 4D float32 file without orientation (3 volumes). */
function fourD({ nx = 48, ny = 48, nz = 24, nt = 3 } = {}) {
  const v = new Float32Array(nx * ny * nz * nt);
  for (let t = 0; t < nt; t++) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const d = Math.hypot(i - nx / 2, j - ny / 2, (k - nz / 2) * 2);
    v[i + nx * (j + ny * (k + nz * t))] = d < 18 ? 100 + t * 50 + 0.25 : 0;
  }
  return niftiFile({ dims: [nx, ny, nz, nt], pix: [2, 2, 2, 1], datatype: 16, bitpix: 32, values: v, descrip: '4D float phantom' });
}

const MAX_SAMPLE = 5 * 1024 * 1024;
function writeAll(out) {
  const w = (rel, bytes) => {
    if (bytes.length > MAX_SAMPLE) throw new Error(`${rel} would be ${bytes.length} bytes, over the 5 MB sample limit.`);
    const p = path.join(out, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return [rel, bytes.length];
  };
  const list = [];
  const chest = chestSeries();
  for (const f of chest.files) list.push(w(path.join('chest-ct', ...f.id), f.bytes));
  list.push(w(path.join('chest-ct', 'DICOMDIR'), chest.dicomdir));
  for (const f of headCt()) list.push(w(path.join('head-ct', f.name), f.bytes));
  list.push(w('head-ct-with-name.dcm', headCt({ named: true, ts: TS.implicit, seriesSeed: 'named', only: 16 })[0].bytes));
  list.push(w('head-ct-big-endian.dcm', headCt({ ts: TS.big, seriesSeed: 'be', only: 16 })[0].bytes));
  list.push(w('head-ct-deflated.dcm', headCt({ ts: TS.deflated, seriesSeed: 'defl', only: 16 })[0].bytes));
  list.push(w('mr-brain-rle-multiframe.dcm', mrRle().bytes));
  list.push(w('us-rgb.dcm', rgbUs().bytes));
  list.push(w('jpeg2000-not-supported.dcm', j2kFile()));
  list.push(w('brain-phantom.nii.gz', Buffer.from(gzipSync(brainNifti().buf, { level: 6 }))));
  list.push(w('sphere-4d.nii', fourD()));
  return list;
}

module.exports = { TS, uid, part10, encodeElements, pixelBytes, chestSeries, headCt, mrRle, rgbUs, j2kFile, niftiFile, brainNifti, fourD, chestHU, headHU, writeAll };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || 'samples');
  const list = writeAll(out);
  const total = list.reduce((a, [, n]) => a + n, 0);
  console.log(`wrote ${list.length} files, ${(total / 1048576).toFixed(1)} MB, to ${out}`);
}

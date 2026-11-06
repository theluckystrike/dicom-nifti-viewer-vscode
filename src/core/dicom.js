'use strict';
// Reads one DICOM file with dicom-parser: the tag table, the image facts and the decoded frames.
const dicomParser = require('dicom-parser');
const { inflateSync } = require('fflate');
const { lookup, tagLabel, DICT } = require('./dicomdict');
const { decodeRleFrame } = require('./rle');

const TS = {
  '1.2.840.10008.1.2': { name: 'Implicit VR Little Endian', ok: true },
  '1.2.840.10008.1.2.1': { name: 'Explicit VR Little Endian', ok: true },
  '1.2.840.10008.1.2.1.99': { name: 'Deflated Explicit VR Little Endian', ok: true },
  '1.2.840.10008.1.2.2': { name: 'Explicit VR Big Endian', ok: true },
  '1.2.840.10008.1.2.5': { name: 'RLE Lossless', ok: true },
  '1.2.840.10008.1.2.4.50': { name: 'JPEG Baseline (8-bit)', ok: false },
  '1.2.840.10008.1.2.4.51': { name: 'JPEG Extended (12-bit)', ok: false },
  '1.2.840.10008.1.2.4.57': { name: 'JPEG Lossless', ok: false },
  '1.2.840.10008.1.2.4.70': { name: 'JPEG Lossless SV1', ok: false },
  '1.2.840.10008.1.2.4.80': { name: 'JPEG-LS Lossless', ok: false },
  '1.2.840.10008.1.2.4.81': { name: 'JPEG-LS Near-Lossless', ok: false },
  '1.2.840.10008.1.2.4.90': { name: 'JPEG 2000 Lossless', ok: false },
  '1.2.840.10008.1.2.4.91': { name: 'JPEG 2000', ok: false },
  '1.2.840.10008.1.2.4.201': { name: 'HTJ2K Lossless', ok: false },
  '1.2.840.10008.1.2.4.202': { name: 'HTJ2K Lossless RPCL', ok: false },
  '1.2.840.10008.1.2.4.203': { name: 'HTJ2K', ok: false },
  '1.2.840.10008.1.2.4.100': { name: 'MPEG-2 video', ok: false },
  '1.2.840.10008.1.2.4.102': { name: 'MPEG-4 AVC/H.264 video', ok: false },
  '1.2.840.10008.1.2.4.103': { name: 'MPEG-4 AVC/H.264 BD video', ok: false },
  '1.2.840.10008.1.2.4.107': { name: 'HEVC/H.265 video', ok: false },
};
const UNSUPPORTED_LIST = 'JPEG Baseline, JPEG Extended, JPEG Lossless, JPEG-LS, JPEG 2000, HTJ2K and MPEG/HEVC video';

function tsInfo(uid) {
  const t = TS[uid];
  if (t) return { uid, ...t };
  return { uid, name: uid ? 'Unknown transfer syntax' : 'Not stated (read as Implicit VR Little Endian)', ok: !uid };
}

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const IDENTIFYING = [
  ['x00100030', "Patient's Birth Date"], ['x00101040', "Patient's Address"], ['x00102154', "Patient's Telephone Numbers"],
  ['x00101000', 'Other Patient IDs'], ['x00101001', 'Other Patient Names'], ['x00080050', 'Accession Number'],
  ['x00080080', 'Institution Name'], ['x00080090', "Referring Physician's Name"],
];
const MAX_ROWS = 5000;
const MAX_VALUE = 240;

function inflater(byteArray, position) {
  const inflated = inflateSync(byteArray.subarray(position));
  const out = new Uint8Array(position + inflated.length);
  out.set(byteArray.subarray(0, position));
  out.set(inflated, position);
  return out;
}

const vrCallback = (tag) => { const d = DICT[tag.replace(/^x/, '').toUpperCase()]; return d ? d[0] : undefined; };

/** True when the bytes look like DICOM Part 10 ("DICM" at offset 128). */
function isDicom(bytes) {
  return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

function makeText(ds, utf8Flag) {
  const cs = (ds.string('x00080005') || '').toUpperCase();
  const utf8 = utf8Flag === undefined ? cs.includes('ISO_IR 192') : utf8Flag;
  const dec = utf8 && typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const fn = (tag) => {
    const el = ds.elements[tag];
    if (!el) return undefined;
    if (!dec) return ds.string(tag);
    return dec.decode(ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length)).replace(/[\0 ]+$/, '');
  };
  fn.utf8 = utf8;
  return fn;
}

function cut(s) { return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}... (${s.length} characters)` : s; }

function valueOf(ds, key, el, vr, text) {
  if (key === 'x7fe00010') {
    if (el.encapsulatedPixelData) return `Pixel data, ${el.fragments ? el.fragments.length : 0} compressed fragments`;
    return `Pixel data, ${el.length.toLocaleString('en-US')} bytes`;
  }
  if (el.items) return `Sequence with ${el.items.length} item${el.items.length === 1 ? '' : 's'}`;
  const len = el.length;
  if (len === 0) return '';
  if (STRING_VRS.has(vr)) return cut(text(key) || '');
  const many = (n, size, fn) => { const k = Math.min(Math.floor(len / size), 16); const v = []; for (let i = 0; i < k; i++) v.push(fn(i)); return v.join('\\') + (len / size > 16 ? ` ... (${len / size} values)` : ''); };
  switch (vr) {
    case 'US': return many(len, 2, (i) => ds.uint16(key, i));
    case 'SS': return many(len, 2, (i) => ds.int16(key, i));
    case 'UL': return many(len, 4, (i) => ds.uint32(key, i));
    case 'SL': return many(len, 4, (i) => ds.int32(key, i));
    case 'FL': return many(len, 4, (i) => +ds.float(key, i).toPrecision(7));
    case 'FD': return many(len, 8, (i) => ds.double(key, i));
    case 'AT': return many(len, 4, (i) => tagLabel('x' + ((ds.uint16(key, i * 2) << 16) >>> 0 | ds.uint16(key, i * 2 + 1)).toString(16).padStart(8, '0')));
    default: {
      const b = ds.byteArray.subarray(el.dataOffset, el.dataOffset + Math.min(len, MAX_VALUE));
      let printable = true;
      for (const c of b) if (c !== 0 && (c < 9 || (c > 13 && c < 32) || c > 126)) { printable = false; break; }
      if (printable && b.length) return cut(String.fromCharCode(...b).replace(/[\0 ]+$/, ''));
      const hex = Array.from(b.subarray(0, 16), (c) => c.toString(16).padStart(2, '0')).join(' ');
      return `${len.toLocaleString('en-US')} bytes: ${hex}${len > 16 ? ' ...' : ''}`;
    }
  }
}

/** Flat tag rows [label, vr, name, value, depth] in file order, items of sequences indented. */
function tagRows(ds, text, depth = 0, rows = []) {
  for (const key of Object.keys(ds.elements)) {
    if (rows.length >= MAX_ROWS) break;
    const el = ds.elements[key];
    const info = lookup(key);
    const vr = el.vr || info.vr || (el.items ? 'SQ' : '');
    let value;
    try { value = valueOf(ds, key, el, vr, text); } catch { value = `${el.length} bytes (could not be read)`; }
    rows.push([tagLabel(key), vr || '--', info.name, value, depth]);
    if (el.items && depth < 4) {
      el.items.forEach((item, n) => {
        if (rows.length >= MAX_ROWS) return;
        rows.push(['', '', `Item ${n + 1}`, '', depth + 1]);
        if (item.dataSet) tagRows(item.dataSet, makeText(item.dataSet, text.utf8), depth + 2, rows);
      });
    }
  }
  return rows;
}

const nums = (ds, tag, n) => { const out = []; for (let i = 0; i < n; i++) { const v = ds.floatString(tag, i); if (v === undefined || !Number.isFinite(v)) return null; out.push(v); } return out; };

function anonymityCheck(text) {
  const name = (text('x00100010') || '').trim();
  const id = (text('x00100020') || '').trim();
  const others = IDENTIFYING.filter(([t]) => (text(t) || '').trim()).map(([, n]) => n);
  const removed = (text('x00120062') || '').trim().toUpperCase() === 'YES';
  return { patientName: name, patientId: id, others, identityRemovedFlag: removed, clean: !name && !id };
}

/**
 * Parse one DICOM file.
 * @returns {{tags:Array, info:Object, frames:Array<Float32Array|Uint8Array>|null, pixelNote:string|null, anon:Object}}
 */
function parseDicomFile(bytes, opts = {}) {
  let ds;
  let damaged = null;
  try {
    ds = dicomParser.parseDicom(bytes, { inflater, vrCallback });
  } catch (e) {
    const msg = e && e.exception ? e.exception : (e && e.message) || String(e);
    // dicom-parser hands back what it read before the damage; show those tags.
    if (isDicom(bytes) && e && e.dataSet && Object.keys(e.dataSet.elements).length > 3) { ds = e.dataSet; damaged = msg; }
  }
  if (!ds) {
    let msg = '';
    try { dicomParser.parseDicom(bytes, { inflater, vrCallback }); } catch (e) { msg = e && e.exception ? e.exception : (e && e.message) || String(e); }
    if (!isDicom(bytes)) throw new Error(`This is not a DICOM file (no "DICM" marker at byte 128, and it could not be read as a raw data set: ${msg}).`);
    throw new Error(`The DICOM file could not be read: ${msg}`);
  }
  const text = makeText(ds);
  const tsUid = (ds.string('x00020010') || '').replace(/\0/g, '').trim();
  const ts = tsInfo(tsUid);
  const s = (t) => (text(t) || '').trim();
  const rows = ds.uint16('x00280010') || 0;
  const cols = ds.uint16('x00280011') || 0;
  const info = {
    transferSyntax: ts,
    sopClass: s('x00080016'), modality: s('x00080060'), seriesUid: s('x0020000e'), seriesNumber: ds.intString('x00200011'),
    seriesDescription: s('x0008103e'), studyDescription: s('x00081030'), instanceNumber: ds.intString('x00200013'),
    rows, cols, samples: ds.uint16('x00280002') || 1, photometric: s('x00280004') || 'MONOCHROME2',
    planar: ds.uint16('x00280006') || 0, bitsAllocated: ds.uint16('x00280100') || 0, bitsStored: ds.uint16('x00280101') || 0,
    pixelRepresentation: ds.uint16('x00280103') || 0, frames: Math.max(1, ds.intString('x00280008') || 1),
    slope: ds.floatString('x00281053'), intercept: ds.floatString('x00281052'),
    windowCenter: ds.floatString('x00281050'), windowWidth: ds.floatString('x00281051'),
    pixelSpacing: nums(ds, 'x00280030', 2), sliceThickness: ds.floatString('x00180050'), spacingBetween: ds.floatString('x00180088'),
    position: nums(ds, 'x00200032', 3), orientation: nums(ds, 'x00200037', 6), sliceLocation: ds.floatString('x00201041'),
    referencedFiles: null,
  };
  if (!Number.isFinite(info.slope) || info.slope === 0) info.slope = 1;
  if (!Number.isFinite(info.intercept)) info.intercept = 0;
  const dirSeq = ds.elements.x00041220;
  if (dirSeq && dirSeq.items) {
    info.referencedFiles = [];
    for (const it of dirSeq.items) {
      const id = it.dataSet && it.dataSet.string('x00041500');
      if (id) info.referencedFiles.push(id.trim().split('\\').filter(Boolean));
    }
  }
  const out = { tags: tagRows(ds, text), info, frames: null, pixelNote: null, anon: anonymityCheck(text) };
  if (damaged) { out.pixelNote = `The file is cut short or damaged (${damaged.replace(/^dicomParser[.:]\w+: /, '')}). The tags before the damage are shown.`; return out; }
  if (opts.tagsOnly) return out;
  const pix = ds.elements.x7fe00010;
  if (!pix) { out.pixelNote = info.referencedFiles ? null : 'This file has no image (no Pixel Data element).'; return out; }
  if (!ts.ok) {
    out.pixelNote = `The image uses ${ts.name} compression (${ts.uid}), which DICOM Viewer can't decode. It reads uncompressed and RLE Lossless images. ${UNSUPPORTED_LIST} are not supported yet. The tags are shown.`;
    return out;
  }
  try { out.frames = decodePixels(ds, pix, info); } catch (e) { out.pixelNote = `The image could not be decoded: ${e.message}`; }
  return out;
}

function decodePixels(ds, pix, info) {
  const { rows, cols, samples, bitsAllocated, frames } = info;
  if (!rows || !cols) throw new Error('Rows or Columns is missing.');
  if (![8, 16, 32].includes(bitsAllocated)) throw new Error(`${bitsAllocated}-bit pixels are not supported (8, 16 and 32 are).`);
  const photo = info.photometric.toUpperCase();
  const color = samples === 3;
  if (samples !== 1 && samples !== 3) throw new Error(`${samples} samples per pixel are not supported.`);
  if (color && !['RGB', 'YBR_FULL'].includes(photo)) throw new Error(`Photometric Interpretation ${photo} is not supported (MONOCHROME1, MONOCHROME2, RGB and YBR_FULL are).`);
  if (!color && !/^MONOCHROME[12]$/.test(photo)) throw new Error(`Photometric Interpretation ${photo} is not supported (MONOCHROME1, MONOCHROME2, RGB and YBR_FULL are).`);
  const bps = bitsAllocated / 8;
  const frameBytes = rows * cols * samples * bps;
  const big = info.transferSyntax.uid === '1.2.840.10008.1.2.2';
  const rle = info.transferSyntax.uid === '1.2.840.10008.1.2.5';
  const list = [];
  for (let f = 0; f < frames; f++) {
    let raw; let interleaved = true;
    if (rle) {
      if (!pix.encapsulatedPixelData || !pix.fragments || !pix.fragments[f]) throw new Error(`RLE frame ${f + 1} is missing.`);
      const frag = pix.fragments[f];
      raw = decodeRleFrame(ds.byteArray.subarray(frag.position, frag.position + frag.length), rows, cols, samples, bitsAllocated);
    } else {
      const start = pix.dataOffset + f * frameBytes;
      if (start + frameBytes > ds.byteArray.length) throw new Error(`The pixel data ends before frame ${f + 1} (file cut short?).`);
      raw = ds.byteArray.subarray(start, start + frameBytes);
      interleaved = !(color && info.planar === 1);
    }
    list.push(color ? toRgb(raw, rows * cols, interleaved, bitsAllocated, photo) : toGray(raw, rows * cols, info, big));
  }
  return list;
}

function toGray(raw, n, info, bigEndian) {
  const { bitsAllocated, pixelRepresentation, slope, intercept } = info;
  const bitsStored = info.bitsStored && info.bitsStored <= bitsAllocated ? info.bitsStored : bitsAllocated;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const le = !bigEndian;
  const out = new Float32Array(n);
  const signed = pixelRepresentation === 1;
  const mask = bitsStored >= 32 ? 0xffffffff : (2 ** bitsStored) - 1;
  const signBit = 2 ** (bitsStored - 1);
  for (let p = 0; p < n; p++) {
    let v;
    if (bitsAllocated === 8) v = raw[p];
    else if (bitsAllocated === 16) v = dv.getUint16(p * 2, le);
    else v = dv.getUint32(p * 4, le);
    if (bitsStored < 32) v = (v & mask) >>> 0;
    if (signed && v >= signBit) v -= 2 * signBit;
    out[p] = v * slope + intercept;
  }
  return out;
}

function toRgb(raw, n, interleaved, bitsAllocated, photo) {
  if (bitsAllocated !== 8) throw new Error('Colour images need 8 bits per sample.');
  const out = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    let r; let g; let b;
    if (interleaved) { r = raw[p * 3]; g = raw[p * 3 + 1]; b = raw[p * 3 + 2]; } else { r = raw[p]; g = raw[n + p]; b = raw[2 * n + p]; }
    if (photo === 'YBR_FULL') {
      const y = r; const cb = g - 128; const cr = b - 128;
      r = y + 1.402 * cr; g = y - 0.344136 * cb - 0.714136 * cr; b = y + 1.772 * cb;
    }
    out[p * 3] = Math.max(0, Math.min(255, Math.round(r)));
    out[p * 3 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out[p * 3 + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
  return out;
}

module.exports = { parseDicomFile, isDicom, tsInfo, TS, UNSUPPORTED_LIST, decodePixels };

'use strict';
// Reads NIfTI-1 and NIfTI-2 (.nii, .nii.gz) with nifti-reader-js and fflate.
const nifti = require('./nifti-lib.mjs');
const { gunzipSync } = require('fflate');
const { axesFromDirections, acquiredPlane, stats, compact, IDENTITY_AXES } = require('./volume');

const DT = {
  2: ['uint8', 1], 4: ['int16', 2], 8: ['int32', 4], 16: ['float32', 4], 64: ['float64', 8], 128: ['rgb24', 3],
  256: ['int8', 1], 512: ['uint16', 2], 768: ['uint32', 4], 1024: ['int64', 8], 1280: ['uint64', 8], 2304: ['rgba32', 4],
  32: ['complex64', 8], 1792: ['complex128', 16], 1536: ['float128', 16],
};
const XFORM = { 0: 'unknown', 1: 'scanner', 2: 'aligned', 3: 'Talairach', 4: 'MNI 152', 5: 'template' };

function isGzip(b) { return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b; }

/** Uncompressed size a .gz says it holds (last 4 bytes, modulo 4 GB). */
function gzipSize(b) { return b.length >= 18 ? (b[b.length - 4] | (b[b.length - 3] << 8) | (b[b.length - 2] << 16) | (b[b.length - 1] << 24)) >>> 0 : 0; }

function toArrayBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
}

/**
 * @param {Uint8Array} bytes the file
 * @param {{maxBytes?:number, volumeIndex?:number}} opts
 */
function parseNifti(bytes, opts = {}) {
  const notes = [];
  const maxBytes = opts.maxBytes || 2048 * 1024 * 1024;
  let raw = bytes;
  const gz = isGzip(bytes);
  if (gz) {
    const size = gzipSize(bytes);
    // Deflate can't shrink data more than about 1032 times, so a bigger claim means the end of the file is damaged.
    if (size > maxBytes && size <= bytes.length * 1032) throw Object.assign(new Error(`The file unpacks to ${(size / 1048576).toFixed(0)} MB, more than the ${(maxBytes / 1048576).toFixed(0)} MB limit (setting dicomViewer.maxFileMB).`), { tooBig: true });
    try { raw = gunzipSync(bytes); } catch (e) { throw new Error(`The .gz file could not be unpacked: ${e.message}`); }
  }
  const ab = toArrayBuffer(raw);
  if (!nifti.isNIFTI(ab)) throw new Error('This is not a NIfTI file (the header size is not 348 or 540, or the magic "n+1"/"n+2" is missing).');
  const h = nifti.readHeader(ab);
  if (!h) throw new Error('The NIfTI header could not be read.');
  const dt = DT[h.datatypeCode];
  if (!dt) throw new Error(`NIfTI datatype ${h.datatypeCode} is not known.`);
  if (['int64', 'uint64', 'complex64', 'complex128', 'float128'].includes(dt[0])) throw new Error(`NIfTI datatype ${dt[0]} is not supported. It reads uint8, int8, int16, uint16, int32, uint32, float32, float64, RGB24 and RGBA32.`);
  const nd = h.dims[0];
  const nx = Math.max(1, h.dims[1]); const ny = nd >= 2 ? Math.max(1, h.dims[2]) : 1; const nz = nd >= 3 ? Math.max(1, h.dims[3]) : 1;
  let nt = 1; for (let d = 4; d <= Math.min(nd, 7); d++) nt *= Math.max(1, h.dims[d]);
  const t = Math.max(0, Math.min(nt - 1, opts.volumeIndex | 0));
  const n = nx * ny * nz;
  const bpv = dt[1];
  const off = Math.round(h.vox_offset) + t * n * bpv;
  if (off + n * bpv > ab.byteLength) throw new Error(`The image data is cut short: ${(n * bpv).toLocaleString('en-US')} bytes needed at byte ${off}, the file has ${ab.byteLength.toLocaleString('en-US')}.`);
  const dv = new DataView(ab, off, n * bpv);
  const le = h.littleEndian;
  const slope = Number.isFinite(h.scl_slope) && h.scl_slope !== 0 ? h.scl_slope : 1;
  const inter = Number.isFinite(h.scl_inter) && h.scl_slope !== 0 ? h.scl_inter : 0;
  const rgb = dt[0] === 'rgb24' || dt[0] === 'rgba32';
  let data;
  if (rgb) {
    // NIfTI stores RGB voxel by voxel (RGBRGB...) in one volume.
    data = new Uint8Array(n * 3);
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) data[p * 3 + c] = dv.getUint8(p * bpv + c);
  } else {
    const f = new Float32Array(n);
    const get = {
      uint8: (p) => dv.getUint8(p), int8: (p) => dv.getInt8(p), int16: (p) => dv.getInt16(p * 2, le), uint16: (p) => dv.getUint16(p * 2, le),
      int32: (p) => dv.getInt32(p * 4, le), uint32: (p) => dv.getUint32(p * 4, le), float32: (p) => dv.getFloat32(p * 4, le), float64: (p) => dv.getFloat64(p * 8, le),
    }[dt[0]];
    let nonFinite = 0;
    for (let p = 0; p < n; p++) { let v = get(p) * slope + inter; if (!Number.isFinite(v)) { v = 0; nonFinite++; } f[p] = v; }
    data = compact(f);
    if (nonFinite) notes.push(`${nonFinite.toLocaleString('en-US')} NaN or infinite voxels are shown as 0.`);
  }
  // Orientation: sform when set, else qform (nifti-reader-js builds h.affine from either). NIfTI is RAS, we use LPS.
  let axes = IDENTITY_AXES; let xform = 'none';
  if ((h.sform_code > 0 || h.qform_code > 0) && h.affine) {
    const A = h.affine;
    const dirs = [0, 1, 2].map((c) => [-A[0][c], -A[1][c], A[2][c]]);
    if (dirs.every((d) => Math.hypot(...d) > 0)) { axes = axesFromDirections(dirs); xform = h.sform_code > 0 ? `sform (${XFORM[h.sform_code] || h.sform_code})` : `qform (${XFORM[h.qform_code] || h.qform_code})`; }
  } else notes.push('The file has no qform or sform. Views follow the voxel grid.');
  if (nt > 1) notes.push(`This file holds ${nt} volumes. Volume ${t + 1} is shown.`);
  const units = ['', 'm', 'mm', 'µm'][h.xyzt_units & 7] || '';
  const pix = h.pixDims || [];
  const spacing = [Math.abs(pix[1]) || 1, Math.abs(pix[2]) || 1, Math.abs(pix[3]) || 1];
  const header = [
    ['Format', h.dims && h.sizeof_hdr === 540 ? 'NIfTI-2' : 'NIfTI-1', ''],
    ['Compressed', gz ? 'yes (.gz)' : 'no', ''],
    ['Dimensions', h.dims.slice(1, nd + 1).join(' x '), 'dim'],
    ['Voxel size', pix.slice(1, Math.min(nd, 3) + 1).map((v) => +(+v).toPrecision(6)).join(' x ') + (units ? ` ${units}` : ''), 'pixdim'],
    ['Datatype', `${dt[0]} (code ${h.datatypeCode}, ${h.numBitsPerVoxel} bits)`, 'datatype'],
    ['Byte order', le ? 'little endian' : 'big endian', ''],
    ['Scaling', `slope ${h.scl_slope}, intercept ${h.scl_inter}`, 'scl_slope / scl_inter'],
    ['Display range', `${h.cal_min} to ${h.cal_max}`, 'cal_min / cal_max'],
    ['qform code', `${h.qform_code} (${XFORM[h.qform_code] || '?'})`, 'qform_code'],
    ['sform code', `${h.sform_code} (${XFORM[h.sform_code] || '?'})`, 'sform_code'],
    ['Orientation used', xform, ''],
    ['Description', String(h.description || '').replace(/\0/g, '').trim(), 'descrip'],
    ['Intent', `${h.intent_code}${h.intent_name ? ` ${String(h.intent_name).replace(/\0/g, '')}` : ''}`, 'intent_code / intent_name'],
    ['Data offset', String(h.vox_offset), 'vox_offset'],
  ];
  if (h.affine) h.affine.slice(0, 3).forEach((r, i) => header.push([`Affine row ${i + 1}`, r.map((v) => +(+v).toPrecision(6)).join('  '), h.sform_code > 0 ? `srow_${'xyz'[i]}` : 'from quatern']));
  const st = rgb ? null : stats(data);
  const cal = h.cal_max > h.cal_min ? { center: (h.cal_max + h.cal_min) / 2, width: h.cal_max - h.cal_min } : null;
  return {
    volume: { dims: [nx, ny, nz], spacing, axes, oriented: xform !== 'none', plane: acquiredPlane(axes), rgb, data, invert: false, modality: '', units: '', slope: 1, intercept: 0, window: cal, stats: st, rawSlope: slope, rawIntercept: inter },
    header, notes, volumes: nt, volumeIndex: t, gz,
  };
}

module.exports = { parseNifti, isGzip, gzipSize, DT };

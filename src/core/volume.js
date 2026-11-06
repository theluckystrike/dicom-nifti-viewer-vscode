'use strict';
// Volume layout, orientation and slicing. Shared by the worker, the webview and the tests (no Node or DOM APIs).
// Voxel (i, j, k) is at data[i + nx * (j + ny * k)]. Patient axes are DICOM LPS: +x left, +y posterior, +z head.

const VIEWS = ['axial', 'coronal', 'sagittal'];
// Screen axes per view, as patient axes: [horizontal, vertical]
const VIEW_AXES = { axial: [0, 1], coronal: [0, 2], sagittal: [1, 2] };

const PRESETS = [
  { id: 'brain', label: 'CT brain', width: 80, center: 40 },
  { id: 'soft', label: 'CT soft tissue', width: 400, center: 40 },
  { id: 'lung', label: 'CT lung', width: 1500, center: -600 },
  { id: 'bone', label: 'CT bone', width: 1800, center: 400 },
];

/**
 * axes[a] = { patient: 0|1|2, sign: 1|-1 } for volume axis a (0 = i, 1 = j, 2 = k).
 * dirs are the three direction vectors of i, j and k in LPS.
 */
function axesFromDirections(dirs) {
  const used = new Set(); const axes = [];
  // Assign the strongest component first so two axes never map to the same patient axis.
  const order = [0, 1, 2].sort((a, b) => Math.max(...dirs[b].map(Math.abs)) - Math.max(...dirs[a].map(Math.abs)));
  for (const a of order) {
    const d = dirs[a];
    let best = -1;
    for (let p = 0; p < 3; p++) if (!used.has(p) && (best < 0 || Math.abs(d[p]) > Math.abs(d[best]))) best = p;
    used.add(best);
    axes[a] = { patient: best, sign: d[best] < 0 ? -1 : 1 };
  }
  return axes;
}

const IDENTITY_AXES = [{ patient: 0, sign: 1 }, { patient: 1, sign: 1 }, { patient: 2, sign: 1 }];

/** Which plane the stored slices (fixed k) are in. */
function acquiredPlane(axes) {
  const p = axes[2].patient;
  return p === 2 ? 'axial' : p === 1 ? 'coronal' : 'sagittal';
}

/** Geometry of a view: which volume axis is fixed, which run across and down, and the flips. */
function viewGeometry(vol, view) {
  const [ph, pv] = VIEW_AXES[view] || VIEW_AXES.axial;
  const axes = vol.axes || IDENTITY_AXES;
  const find = (p) => axes.findIndex((a) => a.patient === p);
  const hAxis = find(ph); const vAxis = find(pv);
  const fixed = 3 - hAxis - vAxis;
  const dims = vol.dims;
  // Screen x grows to the patient's left (+x) in axial and coronal, and to posterior (+y) in sagittal.
  const flipH = axes[hAxis].sign < 0;
  // Screen y grows posterior (+y) in axial; in coronal and sagittal the head (+z) is at the top.
  const flipV = pv === 1 ? axes[vAxis].sign < 0 : axes[vAxis].sign > 0;
  // The slice index runs toward +x, +y or +z of the patient
  const flipD = axes[fixed].sign < 0;
  return {
    fixed, hAxis, vAxis, flipH, flipV, flipD,
    w: dims[hAxis], h: dims[vAxis], depth: dims[fixed],
    pxW: vol.spacing[hAxis] || 1, pxH: vol.spacing[vAxis] || 1,
  };
}

/** Volume index (i, j, k) of a screen pixel (x, y) at slice index s in a view. */
function voxelIndex(vol, g, s, x, y) {
  const ijk = [0, 0, 0];
  ijk[g.hAxis] = g.flipH ? g.w - 1 - x : x;
  ijk[g.vAxis] = g.flipV ? g.h - 1 - y : y;
  ijk[g.fixed] = g.flipD ? g.depth - 1 - s : s;
  return ijk;
}

/**
 * Copies one slice into display order. Gray volumes give values (Float32Array), RGB volumes give w*h*3 bytes.
 */
function extractSlice(vol, view, s) {
  const g = viewGeometry(vol, view);
  const [nx, ny] = vol.dims;
  const stride = [1, nx, nx * ny];
  const ch = vol.rgb ? 3 : 1;
  const out = vol.rgb ? new Uint8Array(g.w * g.h * 3) : new Float32Array(g.w * g.h);
  const sIdx = Math.max(0, Math.min(g.depth - 1, s | 0));
  const fixedPos = (g.flipD ? g.depth - 1 - sIdx : sIdx) * stride[g.fixed];
  const hs = stride[g.hAxis]; const vs = stride[g.vAxis];
  const d = vol.data;
  let o = 0;
  for (let y = 0; y < g.h; y++) {
    const vy = (g.flipV ? g.h - 1 - y : y) * vs + fixedPos;
    for (let x = 0; x < g.w; x++) {
      const idx = vy + (g.flipH ? g.w - 1 - x : x) * hs;
      if (ch === 1) out[o++] = d[idx];
      else { out[o++] = d[idx * 3]; out[o++] = d[idx * 3 + 1]; out[o++] = d[idx * 3 + 2]; }
    }
  }
  return { pixels: out, width: g.w, height: g.h, geometry: g, index: sIdx };
}

/** Window/level to 8-bit gray. invert for MONOCHROME1. */
function windowToBytes(values, center, width, invert, out) {
  const w = Math.max(width, 1e-6);
  const lo = center - w / 2;
  const res = out || new Uint8ClampedArray(values.length * 4);
  for (let p = 0, o = 0; p < values.length; p++, o += 4) {
    let v = ((values[p] - lo) / w) * 255;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    res[o] = res[o + 1] = res[o + 2] = v; res[o + 3] = 255;
  }
  return res;
}

/** Min, max and the 1st/99th percentile from a sample of up to 200k voxels. */
function stats(data) {
  const n = data.length;
  if (!n) return { min: 0, max: 0, p1: 0, p99: 0 };
  const step = Math.max(1, Math.floor(n / 200000));
  const sample = [];
  let min = Infinity; let max = -Infinity;
  for (let i = 0; i < n; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
  for (let i = 0; i < n; i += step) { const v = data[i]; if (Number.isFinite(v)) sample.push(v); }
  sample.sort((a, b) => a - b);
  const q = (f) => sample[Math.min(sample.length - 1, Math.floor(f * (sample.length - 1)))];
  return { min, max, p1: q(0.01), p99: q(0.99) };
}

/** Int16Array when every value is a whole number in range, else Float32Array. Halves memory for CT and most MR. */
function compact(values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== Math.round(v) || v < -32768 || v > 32767) return values;
  }
  return Int16Array.from(values);
}

module.exports = { VIEWS, VIEW_AXES, PRESETS, axesFromDirections, IDENTITY_AXES, acquiredPlane, viewGeometry, voxelIndex, extractSlice, windowToBytes, stats, compact };

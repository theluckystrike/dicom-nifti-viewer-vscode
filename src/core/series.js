'use strict';
// Groups parsed DICOM files into series and stacks one series into a volume.
const { axesFromDirections, acquiredPlane, stats, compact, IDENTITY_AXES } = require('./volume');

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** files: [{name, parsed}] with parsed from parseDicomFile. Returns series sorted by image count. */
function groupSeries(files) {
  const map = new Map();
  files.forEach((f, idx) => {
    if (!f.parsed) return;
    const uid = f.parsed.info.seriesUid || '(no Series Instance UID)';
    if (!map.has(uid)) map.set(uid, { uid, files: [], images: 0, info: f.parsed.info });
    const s = map.get(uid);
    s.files.push(idx);
    if (f.parsed.frames) s.images += f.parsed.frames.length;
  });
  return [...map.values()].sort((a, b) => b.images - a.images || b.files.length - a.files.length);
}

function seriesLabel(s) {
  const i = s.info;
  const parts = [];
  if (Number.isFinite(i.seriesNumber)) parts.push(`#${i.seriesNumber}`);
  if (i.modality) parts.push(i.modality);
  if (i.seriesDescription) parts.push(i.seriesDescription);
  parts.push(`${s.images} image${s.images === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Stack the images of one series. Returns { volume, slices: [{file, frame}], notes }.
 * Single-frame files are sorted along the slice normal from Image Position (Patient), else by Instance Number.
 */
function stackSeries(files, series) {
  const notes = [];
  const slices = [];
  for (const idx of series.files) {
    const p = files[idx].parsed;
    if (!p.frames) continue;
    p.frames.forEach((px, fr) => slices.push({ file: idx, frame: fr, px, info: p.info }));
  }
  if (!slices.length) return { volume: null, slices: [], notes };
  const first = slices[0].info;
  const rgb = first.samples === 3;
  const same = slices.filter((s) => s.info.rows === first.rows && s.info.cols === first.cols && (s.info.samples === 3) === rgb);
  if (same.length < slices.length) notes.push(`${slices.length - same.length} image(s) with another size were left out of the stack.`);
  const ori = first.orientation;
  let normal = null;
  if (ori) normal = cross(ori.slice(0, 3), ori.slice(3, 6));
  const allPos = normal && same.every((s) => s.info.position && s.info.frames === 1);
  let sorted;
  if (allPos) {
    sorted = same.map((s) => ({ ...s, key: dot(s.info.position, normal) })).sort((a, b) => a.key - b.key);
  } else {
    sorted = same.slice().sort((a, b) => (a.info.instanceNumber ?? 0) - (b.info.instanceNumber ?? 0) || a.file - b.file || a.frame - b.frame);
    if (same.length > 1 && !allPos) notes.push('Slices are ordered by Instance Number and frame, because Image Position (Patient) is missing or the file is multi-frame.');
  }
  const nx = first.cols; const ny = first.rows; const nz = sorted.length;
  const ps = first.pixelSpacing || [1, 1];
  let dz = first.spacingBetween || first.sliceThickness || 1;
  if (allPos && nz > 1) {
    const diffs = [];
    for (let k = 1; k < nz; k++) diffs.push(sorted[k].key - sorted[k - 1].key);
    diffs.sort((a, b) => a - b);
    const med = diffs[Math.floor(diffs.length / 2)];
    if (med > 1e-6) dz = med;
    if (diffs[0] < med * 0.5 || diffs[diffs.length - 1] > med * 1.5) notes.push('The slice gaps are uneven. Reformatted views use the median gap.');
    if (diffs[0] < 1e-6) notes.push('Some slices share the same position.');
  }
  if (!first.pixelSpacing) notes.push('Pixel Spacing is missing, so 1 mm is assumed.');
  const n = nx * ny;
  let data;
  if (rgb) {
    data = new Uint8Array(n * nz * 3);
    sorted.forEach((s, k) => data.set(s.px, k * n * 3));
  } else {
    const f = new Float32Array(n * nz);
    sorted.forEach((s, k) => f.set(s.px, k * n));
    data = compact(f);
  }
  const axes = ori ? axesFromDirections([ori.slice(0, 3), ori.slice(3, 6), normal]) : IDENTITY_AXES;
  if (!ori) notes.push('Image Orientation (Patient) is missing. Views follow the stored rows and columns.');
  const st = rgb ? null : stats(data);
  const volume = {
    dims: [nx, ny, nz], spacing: [ps[1], ps[0], dz], axes, plane: acquiredPlane(axes), rgb, data,
    oriented: !!ori, invert: first.photometric === 'MONOCHROME1', modality: first.modality,
    units: first.modality === 'CT' ? 'HU' : '', slope: first.slope, intercept: first.intercept,
    window: Number.isFinite(first.windowCenter) && Number.isFinite(first.windowWidth) && first.windowWidth > 0 ? { center: first.windowCenter, width: first.windowWidth } : null,
    stats: st,
  };
  return { volume, slices: sorted.map((s) => ({ file: s.file, frame: s.frame })), notes };
}

module.exports = { groupSeries, stackSeries, seriesLabel };

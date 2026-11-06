'use strict';
// Readers, checked against numbers from pydicom 2.4.4 and nibabel 5.3.3 (scripts/crosscheck.py -> fixtures/reference.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { read, sampleDir, cleanup, reference, core, samples } = require('./helpers');

test.after(cleanup);
const C = core();
const ref = reference();
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
const one = (rel) => C.loadModel({ files: [{ name: path.basename(rel), bytes: read(rel) }] });
const values = (m) => (m.dtype === 'int16' ? new Int16Array(m.data.buffer, m.data.byteOffset, m.data.byteLength / 2) : m.dtype === 'float32' ? new Float32Array(m.data.buffer, m.data.byteOffset, m.data.byteLength / 4) : m.data);

test('uncompressed syntaxes (implicit LE, explicit BE, deflated, explicit LE) give the same HU as pydicom', () => {
  for (const rel of ['head-ct-with-name.dcm', 'head-ct-big-endian.dcm', 'head-ct-deflated.dcm', 'head-ct/head-017.dcm']) {
    const { model } = one(rel);
    const r = ref[rel];
    assert.equal(model.format, 'DICOM');
    assert.deepEqual([model.dims[1], model.dims[0]], r.shape, rel);
    const v = values(model);
    assert.equal(sum(v), r.sum, rel);
    assert.equal(model.stats.min, r.min); assert.equal(model.stats.max, r.max);
    assert.equal(v[96 * 192 + 96], r.center, rel);
    assert.equal(model.units, 'HU');
  }
  assert.match(one('head-ct-big-endian.dcm').model.formatLabel, /Big Endian/);
  assert.match(one('head-ct-deflated.dcm').model.formatLabel, /Deflated/);
});

test('RLE Lossless multi-frame decodes to pydicom values; our encoder round-trips', () => {
  const { model } = one('mr-brain-rle-multiframe.dcm');
  const r = ref['mr-brain-rle-multiframe.dcm'];
  assert.deepEqual([model.dims[2], model.dims[1], model.dims[0]], r.shape);
  assert.equal(sum(values(model)), r.sum);
  assert.equal(model.formatLabel, 'RLE Lossless');
  assert.equal(model.sliceNames.length, 24);
  assert.match(model.sliceNames[3], /frame 4/);
  const px = new Uint8Array(4 * 3 * 3 * 2); for (let i = 0; i < px.length; i++) px[i] = i % 5 === 0 ? 7 : (i * 37) & 255;
  assert.deepEqual(C.decodeRleFrame(C.encodeRleFrame(px, 4, 3, 3, 16), 4, 3, 3, 16), px);
  assert.throws(() => C.decodeRleFrame(new Uint8Array(10), 2, 2, 1, 8), /shorter than its 64-byte header/);
});

test('RGB image and JPEG 2000 file: colour kept, unsupported syntax named with tags still shown', () => {
  const rgb = one('us-rgb.dcm');
  assert.equal(rgb.model.rgb, true);
  assert.equal(sum(rgb.model.data), ref['us-rgb.dcm'].sum);
  const j = one('jpeg2000-not-supported.dcm');
  assert.equal(j.model.hasImage, false);
  assert.match(j.model.pixelNote, /JPEG 2000 Lossless compression \(1\.2\.840\.10008\.1\.2\.4\.90\), which DICOM Viewer can't decode/);
  assert.match(j.model.pixelNote, /JPEG-LS, JPEG 2000, HTJ2K/);
  assert.ok(j.tagsByFile[0].some((t) => t[2] === 'Transfer Syntax UID' && t[3] === '1.2.840.10008.1.2.4.90'));
  assert.ok(j.tagsByFile[0].length >= ref['jpeg2000-not-supported.dcm'].elements);
});

test('series: slices sorted by position (instance numbers run backwards), spacing, DICOMDIR references', () => {
  const dir = path.join(sampleDir(), 'chest-ct', 'CT');
  const names = fs.readdirSync(dir).sort().reverse();
  const r = C.loadModel({ files: names.map((n) => ({ name: n, bytes: new Uint8Array(fs.readFileSync(path.join(dir, n))) })) });
  const m = r.model;
  assert.deepEqual(m.dims, [256, 256, 48]);
  assert.deepEqual(m.spacing, [1.25, 1.25, 5]);
  assert.equal(m.plane, 'axial');
  const v = values(m);
  const n = 256 * 256;
  ref.chest.sum_by_z.forEach((s, k) => assert.equal(sum(v.subarray(k * n, (k + 1) * n)), s, `slice ${k}`));
  assert.equal(m.sliceNames[0], 'IM000001'); // z = -117.5 is IM000001, instance 48
  assert.equal(r.sliceFile.length, 48); assert.equal(r.tagsByFile.length, 48);
  const dd = C.parseDicomFile(read('chest-ct/DICOMDIR'), { tagsOnly: true });
  assert.equal(dd.info.referencedFiles.length, ref.DICOMDIR.records);
  assert.deepEqual(dd.info.referencedFiles[0], ref.DICOMDIR.first);
});

test('two series in one folder: biggest first, the other one by index', () => {
  const head = samples.headCt({ slices: 6, size: 64 }).map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }));
  const rle = { name: 'mr.dcm', bytes: new Uint8Array(samples.mrRle(3, 32).bytes) };
  const a = C.loadModel({ files: [rle, ...head] });
  assert.equal(a.model.series.length, 2);
  assert.match(a.model.series[0].label, /CT · Head phantom · 6 images/);
  const b = C.loadModel({ files: [rle, ...head], series: 1 });
  assert.equal(b.model.modality, 'MR'); assert.deepEqual(b.model.dims, [32, 32, 3]);
});

test('anonymity check: name and ID found, empty ones pass, other identifying tags listed', () => {
  const named = one('head-ct-with-name.dcm').model.anon;
  assert.equal(named.clean, false);
  assert.equal(named.patientName, ref['head-ct-with-name.dcm'].patientName);
  assert.equal(named.patientId, ref['head-ct-with-name.dcm'].patientId);
  assert.deepEqual(named.others, ["Patient's Birth Date"]);
  const clean = one('head-ct-big-endian.dcm').model.anon;
  assert.equal(clean.clean, true); assert.equal(clean.identityRemovedFlag, true);
});

test('tag table: names, VRs, values, implicit VR uses the dictionary', () => {
  const t = one('head-ct-with-name.dcm').tagsByFile[0];
  const row = (tag) => t.find((r) => r[0] === tag);
  assert.deepEqual(row('(0010,0010)').slice(1, 4), ['PN', "Patient's Name", 'PHANTOM^DEMO']);
  assert.deepEqual(row('(0028,0010)').slice(1, 4), ['US', 'Rows', '192']);
  assert.equal(row('(0028,1052)')[3], '0');
  assert.match(row('(7FE0,0010)')[3], /^Pixel data, 73,728 bytes$/);
  const dd = C.parseDicomFile(read('chest-ct/DICOMDIR'), { tagsOnly: true }).tags;
  assert.ok(dd.some((r) => r[2] === 'Item 1' && r[4] === 1));
  assert.ok(dd.some((r) => r[2] === 'Referenced File ID' && r[3] === 'CT\\IM000001' && r[4] === 2));
});

test('NIfTI: gzip, scale factor, LAS sform and 4D match nibabel', () => {
  const b = one('brain-phantom.nii.gz').model;
  const r = ref['brain-phantom.nii.gz'];
  assert.deepEqual(b.dims, r.shape);
  const v = values(b);
  assert.ok(Math.abs(sum(v) - r.sum) < 1e-6 * Math.abs(r.sum));
  assert.equal(v[64 + 128 * (75 + 150 * 55)], r.v_64_75_55);
  assert.deepEqual(r.axcodes, ['L', 'A', 'S']);
  // LAS in RAS terms: i runs to patient left (+x LPS), j anterior (-y LPS), k head (+z)
  assert.deepEqual(b.axes, [{ patient: 0, sign: 1 }, { patient: 1, sign: -1 }, { patient: 2, sign: 1 }]);
  assert.equal(b.oriented, true);
  assert.ok(b.header.some(([k, val]) => k === 'Scaling' && /slope 0\.5/.test(val)));
  const f = one('sphere-4d.nii').model;
  assert.deepEqual([...f.dims, f.volumes], ref['sphere-4d.nii'].shape);
  assert.ok(Math.abs(sum(values(f)) - ref['sphere-4d.nii'].sum_t0) < 0.01);
  assert.ok(f.notes.some((n) => /3 volumes\. Volume 1 is shown/.test(n)));
  const t2 = C.loadModel({ files: [{ name: 'sphere-4d.nii', bytes: read('sphere-4d.nii') }], volumeIndex: 2 }).model;
  assert.ok(Math.abs(sum(values(t2)) - ref['sphere-4d.nii'].sum_t2) < 0.01);
  assert.equal(f.oriented, false);
});

test('views: coronal and sagittal put the head at the top, axial puts anterior at the top', () => {
  const vol = { dims: [4, 5, 6], spacing: [1, 2, 3], axes: C.IDENTITY_AXES, data: new Float32Array(120).map((_, i) => i) };
  const cor = C.extractSlice(vol, 'coronal', 2);
  assert.equal(cor.width, 4); assert.equal(cor.height, 6);
  assert.equal(cor.pixels[0], 0 + 4 * (2 + 5 * 5)); // top-left = highest k (head)
  const sag = C.extractSlice(vol, 'sagittal', 1);
  assert.equal(sag.width, 5); assert.equal(sag.height, 6); assert.equal(sag.geometry.pxW, 2); assert.equal(sag.geometry.pxH, 3);
  const ax = C.extractSlice(vol, 'axial', 3);
  assert.equal(ax.pixels[0], 4 * 5 * 3);
  // LAS volume: axial view flips j so anterior stays at the top
  const las = { ...vol, axes: [{ patient: 0, sign: 1 }, { patient: 1, sign: -1 }, { patient: 2, sign: 1 }] };
  const g = C.viewGeometry(las, 'axial');
  assert.equal(g.flipV, true);
  assert.deepEqual(C.voxelIndex(las, g, 0, 0, 0), [0, 4, 0]);
  const bytes = C.windowToBytes(new Float32Array([-1000, 40, 1000]), 40, 400, false);
  assert.deepEqual([bytes[0], bytes[4], bytes[8]], [0, 128, 255]);
  assert.equal(C.windowToBytes(new Float32Array([-1000]), 40, 400, true)[0], 255);
});

test('damaged and wrong files give plain messages', () => {
  assert.throws(() => C.loadModel({ files: [{ name: 'x.dcm', bytes: new TextEncoder().encode('hello, this is a text file and not an image at all '.repeat(10)) }] }), /not a DICOM file/);
  const good = read('head-ct/head-001.dcm');
  const cut = good.subarray(0, good.length - 5000);
  const r = C.loadModel({ files: [{ name: 'cut.dcm', bytes: cut }] });
  assert.equal(r.model.hasImage, false);
  assert.match(r.model.pixelNote, /cut short or damaged \(buffer overrun\)\. The tags before the damage are shown/);
  assert.throws(() => C.loadModel({ files: [{ name: 'a.nii', bytes: new Uint8Array(400) }] }), /not a NIfTI file/);
  const gz = read('brain-phantom.nii.gz');
  assert.throws(() => C.parseNifti(gz, { maxBytes: 1024 * 1024 }), /unpacks to 4 MB, more than the 1 MB limit/);
  assert.throws(() => C.parseNifti(gz.subarray(0, 5000)), /could not be unpacked|cut short/);
  const mixed = C.loadModel({ files: [{ name: 'notes.txt', bytes: new Uint8Array(300) }, { name: 'a.dcm', bytes: good }] });
  assert.match(mixed.model.notes[0], /1 of 2 files could not be read as DICOM/);
});

test('speed: a 256 x 256 x 48 series stacks in under 2 s', () => {
  const dir = path.join(sampleDir(), 'chest-ct', 'CT');
  const files = fs.readdirSync(dir).map((n) => ({ name: n, bytes: new Uint8Array(fs.readFileSync(path.join(dir, n))) }));
  const t0 = Date.now(); C.loadModel({ files }); const ms = Date.now() - t0;
  assert.ok(ms < 2000, `${ms} ms`);
});

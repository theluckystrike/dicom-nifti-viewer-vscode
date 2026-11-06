'use strict';
// Turns file bytes into the model the webview draws. Runs in the worker thread.
const { parseDicomFile, isDicom } = require('./dicom');
const { groupSeries, stackSeries, seriesLabel } = require('./series');
const { parseNifti, isGzip } = require('./nifti');

const MAX_VOLUME_BYTES = 1024 * 1024 * 1024;

function dtypeOf(data) {
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Float32Array) return 'float32';
  return 'uint8';
}

function looksNifti(name, bytes) {
  if (/\.nii(\.gz)?$/i.test(name)) return true;
  if (isGzip(bytes)) return true;
  if (bytes.length >= 348) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const h = dv.getInt32(0, true);
    if (h === 348 || h === 540 || dv.getInt32(0, false) === 348 || dv.getInt32(0, false) === 540) return true;
  }
  return false;
}

function finishVolume(model, volume) {
  const bytes = volume.data.byteLength;
  if (bytes > MAX_VOLUME_BYTES) throw new Error(`The image volume needs ${(bytes / 1048576).toFixed(0)} MB, more than the 1024 MB a viewer tab can hold.`);
  const { data, ...rest } = volume;
  Object.assign(model, rest, { dtype: dtypeOf(data), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), hasImage: true });
  return model;
}

/**
 * @param {{files:Array<{name:string, bytes:Uint8Array}>, series?:number, volumeIndex?:number, maxBytes?:number}} input
 * @returns {{model:Object, tagsByFile:Array, sliceFile:Array<number>}}
 */
function loadModel(input) {
  const files = input.files || [];
  if (!files.length) throw new Error('No files to read.');
  if (files.length === 1 && looksNifti(files[0].name, files[0].bytes) && !isDicom(files[0].bytes)) {
    const r = parseNifti(files[0].bytes, { maxBytes: input.maxBytes, volumeIndex: input.volumeIndex });
    const model = { format: 'NIfTI', formatLabel: r.header[0][1] + (r.gz ? ' (gzip)' : ''), notes: r.notes, header: r.header, volumes: r.volumes, volumeIndex: r.volumeIndex, series: [], seriesIndex: 0, anon: null, sliceNames: [] };
    finishVolume(model, r.volume);
    return { model, tagsByFile: [], sliceFile: [] };
  }
  const parsed = [];
  const errors = [];
  for (const f of files) {
    try { parsed.push({ name: f.name, parsed: parseDicomFile(f.bytes) }); } catch (e) { parsed.push({ name: f.name, parsed: null }); errors.push(`${f.name}: ${e.message}`); }
  }
  const good = parsed.filter((p) => p.parsed);
  if (!good.length) throw new Error(files.length === 1 ? errors[0].replace(/^[^:]+: /, '') : `None of the ${files.length} files could be read as DICOM. First problem: ${errors[0]}`);
  const series = groupSeries(parsed);
  const si = Math.max(0, Math.min(series.length - 1, input.series | 0));
  const chosen = series[si];
  const { volume, slices, notes } = stackSeries(parsed, chosen);
  if (errors.length) notes.unshift(`${errors.length} of ${files.length} files could not be read as DICOM and were skipped (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '; ...' : ''}).`);
  const pixelNotes = [...new Set(chosen.files.map((i) => parsed[i].parsed.pixelNote).filter(Boolean))];
  const ts = [...new Set(chosen.files.map((i) => parsed[i].parsed.info.transferSyntax.name))];
  // Anonymity across the files of the series
  const withName = chosen.files.filter((i) => !parsed[i].parsed.anon.clean);
  const firstAnon = (withName.length ? parsed[withName[0]] : parsed[chosen.files[0]]).parsed.anon;
  const others = [...new Set(chosen.files.flatMap((i) => parsed[i].parsed.anon.others))];
  const model = {
    format: 'DICOM', formatLabel: ts.join(', '), notes, series: series.map((s) => ({ label: seriesLabel(s) })), seriesIndex: si,
    anon: { clean: withName.length === 0, filesWithIdentity: withName.length, files: chosen.files.length, patientName: firstAnon.patientName, patientId: firstAnon.patientId, others, identityRemovedFlag: firstAnon.identityRemovedFlag },
    pixelNote: volume ? (pixelNotes.length ? `${pixelNotes.length} file(s) without a usable image were skipped: ${pixelNotes[0]}` : null) : (pixelNotes[0] || 'No image could be shown.'),
    sliceNames: slices.map((s) => parsed[s.file].name + (parsed[s.file].parsed.frames.length > 1 ? ` (frame ${s.frame + 1})` : '')),
    hasImage: false, modality: chosen.info.modality, header: null, volumes: 1, volumeIndex: 0,
  };
  const fileList = volume ? slices.map((s) => s.file) : chosen.files.slice(0, 1);
  const uniq = [...new Set(fileList)];
  const pos = new Map(uniq.map((f, k) => [f, k]));
  const tagsByFile = uniq.map((i) => parsed[i].parsed.tags);
  if (volume) finishVolume(model, volume);
  return { model, tagsByFile, sliceFile: fileList.map((f) => pos.get(f)) };
}

module.exports = { loadModel, looksNifti, MAX_VOLUME_BYTES };

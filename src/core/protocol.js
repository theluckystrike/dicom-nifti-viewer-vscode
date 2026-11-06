'use strict';
// Shared by the extension host, the worker and the tests. No vscode import here.

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 1024;
const MAX_FOLDER_FILES = 4000;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

function limitOf(maxFileMB) {
  return Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 4096) : DEFAULT_MAX_MB;
}

/** Files (or folders) over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB, what = 'This file') {
  const limitMB = limitOf(maxFileMB);
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `${what} is ${fmtSize(size)}. DICOM Viewer opens up to ${limitMB} MB so VS Code stays responsive (setting dicomViewer.maxFileMB). Nothing was read.`,
    };
  }
  if (size === 0) return { load: false, limitMB, message: 'The file is empty. There is no image to show.' };
  return { load: true, limitMB };
}

/** Folder scan: keep likely DICOM files (.dcm, .dicom, .ima, or no extension), skip the DICOMDIR itself. */
function isCandidate(name) {
  if (/^DICOMDIR$/i.test(name) || name.startsWith('.')) return false;
  if (/\.(dcm|dicom|ima)$/i.test(name)) return true;
  // No extension, or a numeric one as in UID file names (1.2.840.113619.2.55.3)
  return !/\.[A-Za-z0-9]{1,5}$/.test(name) || /^[0-9.]+$/.test(name);
}

const str = (v, max) => typeof v === 'string' && v.length <= max;
const MAX_EXPORT = 128 * MB;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'rendered':
    case 'reload':
    case 'reopenWith':
      return { ok: true, msg: { type: m.type } };
    case 'tags':
      if (!int(m.index, 0, 1e6)) return { ok: false };
      return { ok: true, msg: { type: 'tags', index: m.index } };
    case 'series':
      if (!int(m.index, 0, 10000)) return { ok: false };
      return { ok: true, msg: { type: 'series', index: m.index } };
    case 'volume':
      if (!int(m.index, 0, 1e6)) return { ok: false };
      return { ok: true, msg: { type: 'volume', index: m.index } };
    case 'export': {
      if (m.format !== 'png' || !str(m.data, MAX_EXPORT)) return { ok: false };
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(m.data.slice(0, 64) + m.data.slice(-8))) return { ok: false };
      if (!str(m.suggested, 200) || /[\\/:*?"<>|]/.test(m.suggested) || !/\.png$/i.test(m.suggested)) return { ok: false };
      return { ok: true, msg: { type: 'export', format: 'png', data: m.data, suggested: m.suggested } };
    }
    case 'copy':
      if (!str(m.text, 100000)) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    default:
      return { ok: false };
  }
}

/** Messages the worker may send back to the host. */
function validateWorkerMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'model') return !!m.model && typeof m.model === 'object' && Array.isArray(m.tagsByFile) && Array.isArray(m.sliceFile);
  if (m.type === 'error') return typeof m.message === 'string';
  return false;
}

/** Export name next to the image: scan.dcm, slice 12 axial -> scan-axial-012.png. Never the image itself. */
function exportName(fileName, view, index) {
  const base = String(fileName).replace(/\.(dcm|dicom|ima|nii\.gz|nii|gz)$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'image';
  return `${base}-${view}-${String(index + 1).padStart(3, '0')}.png`;
}

module.exports = { MB, DEFAULT_MAX_MB, MAX_FOLDER_FILES, fmtSize, sizePlan, isCandidate, validateWebviewMessage, validateWorkerMessage, exportName, MAX_EXPORT, limitOf };

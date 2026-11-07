'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sizePlan, validateWebviewMessage, validateWorkerMessage, exportName, isCandidate, fmtSize, MB } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('size plan: 1024 MB default with a clear message, setting clamps, empty file, folder wording', () => {
  assert.equal(sizePlan(10 * MB).load, true);
  const big = sizePlan(1500 * MB);
  assert.equal(big.load, false);
  assert.equal(big.message, 'This file is 1.5 GB. DICOM Viewer opens up to 1024 MB so VS Code stays responsive (setting dicomViewer.maxFileMB). Nothing was read.');
  assert.equal(sizePlan(1500 * MB, 2000).load, true);
  assert.equal(sizePlan(9000 * MB, 99999).limitMB, 4096);
  assert.equal(sizePlan(1, -5).limitMB, 1024);
  assert.match(sizePlan(0).message, /empty/);
  assert.match(sizePlan(30 * MB, 10, 'This folder holds 300 files and').message, /^This folder holds 300 files and is 30\.0 MB\./);
  assert.equal(fmtSize(1536), '1.5 KB');
});

test('folder scan keeps likely DICOM names only', () => {
  for (const n of ['IM000001', 'a.dcm', 'B.DCM', 'x.dicom', 'scan.IMA', '1.2.840.113619.2.55.3']) assert.equal(isCandidate(n), true, n);
  for (const n of ['DICOMDIR', 'notes.txt', 'brain.nii', '.DS_Store', 'report.pdf']) assert.equal(isCandidate(n), false, n);
});

test('webview messages: only known types with checked fields pass', () => {
  for (const t of ['ready', 'rendered', 'reload', 'reopenWith']) assert.deepEqual(validateWebviewMessage({ type: t, extra: 1 }), { ok: true, msg: { type: t } });
  assert.deepEqual(validateWebviewMessage({ type: 'tags', index: 3, x: 1 }), { ok: true, msg: { type: 'tags', index: 3 } });
  assert.equal(validateWebviewMessage({ type: 'tags', index: -1 }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'tags', index: 1.5 }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'series', index: '1' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'volume', index: 2 }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'eval', code: '1' }).ok, false);
  assert.equal(validateWebviewMessage(null).ok, false);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: png, suggested: 'a-axial-001.png' }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: 'data:text/html;base64,AAAA', suggested: 'a.png' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: png, suggested: '../../etc/a.png' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: png, suggested: 'a.dcm' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'svg', data: '<svg/>', suggested: 'a.svg' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'copy', text: '(0010,0010)\tName' }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'copy', text: 'x'.repeat(200001) }).ok, false);
  assert.equal(validateWorkerMessage({ type: 'model', model: {}, tagsByFile: [], sliceFile: [] }), true);
  assert.equal(validateWorkerMessage({ type: 'model', model: {} }), false);
  assert.equal(validateWorkerMessage({ type: 'error', message: 'x' }), true);
});

test('export names never point at the scan', () => {
  assert.equal(exportName('chest.dcm', 'axial', 0), 'chest-axial-001.png');
  assert.equal(exportName('brain.nii.gz', 'coronal', 74), 'brain-coronal-075.png');
  assert.equal(exportName('DICOMDIR', 'sagittal', 9), 'DICOMDIR-sagittal-010.png');
  assert.equal(exportName('.dcm', 'axial', 0), 'image-axial-001.png');
});

test('HTML: strict CSP, nonce script, escaped title, footer can be hidden', () => {
  const h = buildHtml({ cspSource: 'https://x', scriptUri: 'https://x/w.js', styleUri: 'https://x/s.css', title: '<img src=x onerror=alert(1)>.dcm', nonce: 'abc' });
  assert.match(h, /default-src 'none'/);
  assert.match(h, /script-src 'nonce-abc'/);
  assert.doesNotMatch(h, /unsafe-inline|unsafe-eval|connect-src/);
  // The only remote URL is the footer's Rate link to this listing's Marketplace review page (a plain link).
  assert.doesNotMatch(h.replace(/https:\/\/x/g, '').replace(/https:\/\/marketplace\.visualstudio\.com\/items\?itemName=zovo\.dicom-nifti-viewer[^"]*/g, ''), /https?:\/\//);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;\.dcm/);
  assert.match(h, /command:dicomViewer\.supportDeveloper/);
  assert.doesNotMatch(buildHtml({ cspSource: 'x', scriptUri: 'y', styleUri: 'z', title: 't', showSupportLinks: false }), /zovo-support/);
});

test('webview code: no innerHTML, eval, fetch or remote URLs; every posted type passes validation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
  const types = [...src.matchAll(/postMessage\(\{ type: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(types.length >= 7);
  for (const t of new Set(types)) assert.notEqual(validateWebviewMessage({ type: t, index: 0, text: 'x', format: 'png', data: 'data:image/png;base64,' + 'A'.repeat(100), suggested: 'a.png' }).ok, false, t);
});

test('host code: no network modules and one write (the export the user picks)', () => {
  const src = ['extension.js', 'worker.js', 'core/load.js', 'core/dicom.js', 'core/nifti.js', 'core/series.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /require\('(https?|net|tls|dgram|child_process)'\)|fetch\(/);
  assert.equal((src.match(/writeFile\(/g) || []).length, 1);
});

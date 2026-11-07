'use strict';
// The extension host on a mocked VS Code API, with the real worker thread from dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { tmpDir, sampleDir, cleanup } = require('./helpers');

test.after(cleanup);
const root = path.join(__dirname, '..');
const S = sampleDir();
const out = tmpDir('dicom-ext-');

const state = { config: { maxFileMB: 1024, askForRating: true, showSupportLinks: true }, clipboard: '', sizeOverride: null, reads: 0, saveTo: null, writes: [], commands: [], panels: [] };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: (s) => ({ toString: () => s }) },
  FileType: { File: 1, Directory: 2 },
  ViewColumn: { Active: -1 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: {
      stat: async (u) => { const st = fs.statSync(u.fsPath); return { size: state.sizeOverride ?? st.size }; },
      readFile: async (u) => { state.reads++; return fs.readFileSync(u.fsPath); },
      readDirectory: async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]),
      writeFile: async (u, b) => { state.writes.push([u.fsPath, b.length]); fs.writeFileSync(u.fsPath, b); },
    },
  },
  window: {
    registered: [],
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    createWebviewPanel(type, title) { const f = fakePanel(); f.panel.title = title; state.panels.push(f); return f.panel; },
    showInformationMessage: async () => undefined,
    showSaveDialog: async (o) => { state.lastDialog = o; return state.saveTo ? uriOf(state.saveTo) : undefined; },
    showOpenDialog: async () => undefined,
  },
  commands: { list: new Map(), registerCommand(id, fn) { this.list.set(id, fn); return { dispose() {} }; }, executeCommand: async (...a) => { state.commands.push(a); } },
  env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, sessionId: 's1', openExternal: async (u) => { state.opened = String(u); return true; } },
  extensions: { getExtension: () => undefined },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: {
      options: null, html: '', cspSource: 'https://csp', asWebviewUri: (u) => 'https://res' + u.path,
      postMessage: async (m) => { sent.push(m); return true; }, onDidReceiveMessage: (h) => { handler = h; },
    },
    onDidDispose: (h) => { dispose = h; },
  };
  return { panel, sent, send: (m) => handler(m), close: () => dispose() };
}
const ctxOf = () => ({ extensionUri: uriOf(root), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } });
async function open(file) {
  const prov = new ext.DicomEditorProvider(ctxOf());
  const f = fakePanel();
  prov.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return f;
}
const last = (f, type) => [...f.sent].reverse().find((m) => m.type === type);

test('activate registers the editor and commands; manifest matches', () => {
  ext.activate(ctxOf());
  assert.deepEqual(vscodeMock.window.registered.map((r) => r[0]), ['dicomViewer.preview']);
  assert.deepEqual([...vscodeMock.commands.list.keys()].sort(), ['dicomViewer.moreViewers', 'dicomViewer.openFolder', 'dicomViewer.openWalkthrough', 'dicomViewer.openWith', 'dicomViewer.supportDeveloper']);
  const pkg = require('../package.json');
  assert.equal(`${pkg.publisher}.${pkg.name}`, ext.EXT_ID);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/); // monetize.py rollouts bump it
  assert.ok(pkg.displayName.length <= 45 && pkg.displayName.toLowerCase().startsWith('dicom viewer'));
  assert.ok(pkg.keywords.length <= 30);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map((s) => s.filenamePattern), ['*.dcm', '*.dicom', '*.nii', '*.nii.gz', 'DICOMDIR']);
  assert.equal(pkg.contributes.configuration.properties['dicomViewer.showSupportLinks'].default, true);
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.ok(Object.keys(pkg.devDependencies).length === 4 && !pkg.dependencies);
});

test('single file: init, model with pixel bytes, tags of the slice; roots are dist and media', async () => {
  const f = await open(path.join(S, 'head-ct-with-name.dcm'));
  assert.deepEqual(f.panel.webview.options.localResourceRoots.map((u) => path.basename(u.path)), ['dist', 'media']);
  assert.deepEqual(f.panel.webview.options.enableCommandUris, ['dicomViewer.supportDeveloper', 'dicomViewer.moreViewers', 'workbench.action.openSettings']);
  await f.send({ type: 'ready' });
  assert.equal(f.sent[0].type, 'init');
  const m = last(f, 'model').model;
  assert.equal(m.format, 'DICOM'); assert.deepEqual(m.dims, [192, 192, 1]); assert.equal(m.dtype, 'int16');
  assert.ok(m.data instanceof Uint8Array && m.data.byteLength === 192 * 192 * 2);
  assert.equal(m.anon.clean, false);
  const tags = last(f, 'tags');
  assert.ok(tags.rows.some((r) => r[2] === "Patient's Name" && r[3] === 'PHANTOM^DEMO'));
});

test('DICOMDIR opens the 48 referenced files; tags follow the slice asked for; progress is posted', async () => {
  const f = await open(path.join(S, 'chest-ct', 'DICOMDIR'));
  await f.send({ type: 'ready' });
  assert.equal(f.sent[0].files, 48);
  assert.ok(f.sent.some((m) => m.type === 'progress' && m.done === 48));
  const m = last(f, 'model').model;
  assert.deepEqual(m.dims, [256, 256, 48]); assert.equal(m.units, 'HU');
  await f.send({ type: 'tags', index: 47 });
  const t = last(f, 'tags');
  assert.equal(t.index, 47);
  assert.ok(t.rows.some((r) => r[2] === 'Image Position (Patient)' && /\\117\.5$/.test(r[3])));
  await f.send({ type: 'tags', index: -3 });
  assert.equal(last(f, 'tags').index, 47); // invalid index dropped
});

test('folder command: scans .dcm files and opens a panel', async () => {
  await vscodeMock.commands.list.get('dicomViewer.openFolder')(uriOf(path.join(S, 'head-ct')));
  const f = state.panels.at(-1);
  assert.match(f.panel.title, /head-ct \(DICOM\)/);
  await f.send({ type: 'ready' });
  const m = last(f, 'model').model;
  assert.deepEqual(m.dims, [192, 192, 32]);
  assert.equal(m.anon.clean, true);
});

test('NIfTI, 4D volume switch, and the JPEG 2000 notice', async () => {
  const f = await open(path.join(S, 'sphere-4d.nii'));
  await f.send({ type: 'ready' });
  assert.equal(last(f, 'model').model.volumes, 3);
  await f.send({ type: 'volume', index: 2 });
  assert.equal(last(f, 'model').model.volumeIndex, 2);
  const j = await open(path.join(S, 'jpeg2000-not-supported.dcm'));
  await j.send({ type: 'ready' });
  const jm = last(j, 'model').model;
  assert.equal(jm.hasImage, false); assert.match(jm.pixelNote, /JPEG 2000/);
  assert.ok(last(j, 'tags').rows.length > 20);
});

test('over the size limit: message, file never read; broken file: error message', async () => {
  state.config.maxFileMB = 1; state.reads = 0;
  const f = await open(path.join(S, 'brain-phantom.nii.gz'));
  await f.send({ type: 'ready' });
  assert.equal(f.sent[0].plan.load, false); assert.match(f.sent[0].plan.message, /1\.4 MB\. DICOM Viewer opens up to 1 MB/);
  assert.equal(state.reads, 0);
  state.config.maxFileMB = 1024;
  const bad = path.join(out, 'broken.dcm'); fs.writeFileSync(bad, 'not an image');
  const b = await open(bad);
  await b.send({ type: 'ready' });
  assert.match(last(b, 'error').message, /not a DICOM file/);
});

test('export: PNG written where the user picks, a .dcm target refused, cancel writes nothing', async () => {
  const f = await open(path.join(S, 'us-rgb.dcm'));
  await f.send({ type: 'ready' });
  const png = 'data:image/png;base64,' + Buffer.from('\x89PNG fake', 'latin1').toString('base64');
  state.saveTo = path.join(out, 'slice.png');
  await f.send({ type: 'export', format: 'png', data: png, suggested: 'us-rgb-axial-001.png' });
  assert.equal(last(f, 'exported').bytes, 9);
  assert.match(state.lastDialog.defaultUri.path, /us-rgb-axial-001\.png$/);
  state.saveTo = path.join(out, 'x.dcm');
  await f.send({ type: 'export', format: 'png', data: png, suggested: 'a.png' });
  assert.match(last(f, 'exported').error, /never writes to image files/);
  state.saveTo = null;
  await f.send({ type: 'export', format: 'png', data: png, suggested: 'a.png' });
  assert.equal(last(f, 'exported').cancelled, true);
  assert.equal(state.writes.length, 1);
});

test('rating counted once per tab; copy; unknown messages dropped; nothing posted after close', async () => {
  const f = await open(path.join(S, 'head-ct-deflated.dcm'));
  await f.send({ type: 'ready' });
  const ctx = ctxOf();
  ext.activate(ctx);
  await f.send({ type: 'copy', text: '(0010,0010)\tName' });
  assert.equal(state.clipboard, '(0010,0010)\tName');
  const n = f.sent.length;
  await f.send({ type: 'eval', code: 'x' });
  assert.equal(f.sent.length, n);
  f.close();
  await f.send({ type: 'reload' });
  assert.equal(f.sent.length, n);
});

test('support: Sponsor opens GitHub Sponsors, the footer hides with the setting', async () => {
  await vscodeMock.commands.list.get('dicomViewer.supportDeveloper')();
  assert.match(state.opened, /github\.com\/sponsors\/theluckystrike/);
  const shown = await open(path.join(S, 'us-rgb.dcm'));
  assert.match(shown.panel.webview.html, /More free viewers/);
  state.config.showSupportLinks = false;
  const hidden = await open(path.join(S, 'us-rgb.dcm'));
  assert.doesNotMatch(hidden.panel.webview.html, /zovo-support/);
  state.config.showSupportLinks = true;
});

test('worker timeout stops a slow read', async () => {
  const job = ext.parseInWorker(path.join(root, 'dist', 'worker.js'), { files: [{ name: 'a.dcm', bytes: new Uint8Array(fs.readFileSync(path.join(S, 'mr-brain-rle-multiframe.dcm'))) }] }, { timeoutMs: 1 });
  await assert.rejects(job.promise, /longer than 0 seconds|stopped/);
});

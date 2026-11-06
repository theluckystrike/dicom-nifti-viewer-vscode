'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage, validateWorkerMessage, sizePlan, fmtSize, exportName, isCandidate, MAX_FOLDER_FILES, MB, limitOf } = require('./core/protocol');
const { parseDicomFile } = require('./core/dicom');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'dicomViewer.preview';
const PANEL_TYPE = 'dicomViewer.folder';
const EXT_ID = 'zovo.dicom-nifti-viewer';
const TIMEOUT_MS = 180000;
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('dicomViewer');
  return { maxFileMB: c.get('maxFileMB', 1024), defaultView: c.get('defaultView', 'auto'), smooth: c.get('smoothing', false) };
}

/** Parse in a worker thread so a big series never blocks the extension host. */
function parseInWorker(workerPath, input, opts = {}) {
  let worker;
  let timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: opts.heapMB || 6144 } });
    const ms = opts.timeoutMs || TIMEOUT_MS;
    timer = setTimeout(() => { worker.terminate(); reject(new Error(`Reading the images took longer than ${Math.round(ms / 1000)} seconds and was stopped.`)); }, ms);
    worker.once('message', (m) => {
      clearTimeout(timer); worker.terminate();
      if (!validateWorkerMessage(m)) return reject(new Error('The image reader sent an unexpected reply.'));
      if (m.type === 'error') return reject(new Error(m.message));
      resolve(m);
    });
    worker.once('error', (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(/memory/i.test(String(e && e.message)) ? 'The images do not fit in memory.' : String((e && e.message) || e))); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`The image reader stopped (exit code ${code}).`)); });
    const transfer = [];
    const files = input.files.map((f) => {
      const ab = f.bytes.byteOffset === 0 && f.bytes.byteLength === f.bytes.buffer.byteLength ? f.bytes.buffer : Uint8Array.prototype.slice.call(f.bytes).buffer;
      if (!transfer.includes(ab)) transfer.push(ab);
      return { name: f.name, bytes: new Uint8Array(ab) };
    });
    worker.postMessage({ ...input, files }, transfer);
  });
  return { promise, cancel: () => { clearTimeout(timer); if (worker) worker.terminate(); } };
}

const baseName = (uri) => path.posix.basename(uri.path);

/** Lists likely DICOM files under a folder, breadth first, up to depth 4 and MAX_FOLDER_FILES. */
async function scanFolder(folder) {
  const out = [];
  const queue = [[folder, 0]];
  while (queue.length && out.length < MAX_FOLDER_FILES) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { continue; }
    entries.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
    for (const [name, type] of entries) {
      const u = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) { if (depth < 4 && !name.startsWith('.') && name !== 'node_modules') queue.push([u, depth + 1]); } else if (isCandidate(name)) out.push(u);
      if (out.length >= MAX_FOLDER_FILES) break;
    }
  }
  return out;
}

/** Files named by a DICOMDIR (Referenced File ID), relative to its folder. Falls back to a folder scan. */
async function dicomdirFiles(uri) {
  const dir = vscode.Uri.joinPath(uri, '..');
  const notes = [];
  try {
    const parsed = parseDicomFile(await vscode.workspace.fs.readFile(uri), { tagsOnly: true });
    const refs = parsed.info.referencedFiles || [];
    const found = [];
    for (const parts of refs.slice(0, MAX_FOLDER_FILES)) {
      const exact = vscode.Uri.joinPath(dir, ...parts);
      try { await vscode.workspace.fs.stat(exact); found.push(exact); continue; } catch { /* try lower case */ }
      const lower = vscode.Uri.joinPath(dir, ...parts.map((p) => p.toLowerCase()));
      try { await vscode.workspace.fs.stat(lower); found.push(lower); } catch { /* missing */ }
    }
    if (refs.length && found.length < refs.length) notes.push(`${refs.length - found.length} of ${refs.length} files listed in the DICOMDIR are missing.`);
    if (found.length) return { files: found, notes, title: 'DICOMDIR' };
    notes.push('The DICOMDIR lists no image files, so the folder was scanned instead.');
  } catch (e) {
    notes.push(`The DICOMDIR could not be read (${e.message}), so the folder was scanned instead.`);
  }
  return { files: await scanFolder(dir), notes, title: 'DICOMDIR' };
}

/** One viewer tab: a custom editor for a file or DICOMDIR, or a panel for a folder. */
class Session {
  constructor(context, panel, source) {
    this.context = context; this.panel = panel; this.source = source;
    this.disposed = false; this.counted = false; this.job = null; this.tags = []; this.sliceFile = []; this.series = 0; this.volumeIndex = 0;
    this.title = source.kind === 'folder' ? `${baseName(source.uri)}/` : baseName(source.uri);
    const ctx = context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('dicomViewer') };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: this.title,
      showSupportLinks: showLinks(vscode, 'dicomViewer'),
    });
    panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    panel.onDidDispose(() => { this.disposed = true; if (this.job) this.job.cancel(); });
  }

  post(m) { return this.disposed ? Promise.resolve(false) : this.panel.webview.postMessage(m); }

  async listFiles() {
    const { kind, uri } = this.source;
    if (kind === 'folder') return { files: await scanFolder(uri), notes: [] };
    if (kind === 'file' && /^DICOMDIR$/i.test(baseName(uri))) return dicomdirFiles(uri);
    return { files: [uri], notes: [] };
  }

  async load() {
    if (this.job) this.job.cancel();
    const s = settings();
    const { files, notes } = await this.listFiles();
    let total = 0;
    for (const f of files) { try { total += (await vscode.workspace.fs.stat(f)).size; } catch { /* counted as 0 */ } }
    const many = files.length > 1 || this.source.kind === 'folder';
    const base = { type: 'init', name: this.title, size: total, sizeText: fmtSize(total), files: files.length, defaultView: s.defaultView, smooth: s.smooth };
    if (!files.length) { await this.post({ ...base, plan: { load: false, message: 'No DICOM files were found here (looked for .dcm, .dicom, .ima and files without an extension, 4 folders deep).' } }); return; }
    const plan = sizePlan(total, s.maxFileMB, many ? `This folder holds ${files.length} files and` : 'This file');
    await this.post({ ...base, plan });
    if (!plan.load) return;
    const t0 = Date.now();
    const list = [];
    for (let i = 0; i < files.length; i++) {
      if (this.disposed) return;
      try { list.push({ name: baseName(files[i]), bytes: await vscode.workspace.fs.readFile(files[i]) }); } catch (e) { notes.push(`${baseName(files[i])} could not be read: ${e.message}`); }
      if (many && (i % 25 === 24 || i === files.length - 1)) await this.post({ type: 'progress', done: i + 1, total: files.length });
    }
    if (!list.length) { await this.post({ type: 'error', message: 'None of the files could be read.' }); return; }
    this.job = parseInWorker(path.join(this.context.extensionUri.fsPath, 'dist', 'worker.js'),
      { files: list, series: this.series, volumeIndex: this.volumeIndex, maxBytes: limitOf(s.maxFileMB) * MB });
    try {
      const r = await this.job.promise;
      this.tags = r.tagsByFile; this.sliceFile = r.sliceFile;
      r.model.notes = notes.concat(r.model.notes || []);
      await this.post({ type: 'model', model: r.model, name: this.title, sizeText: fmtSize(total), ms: Date.now() - t0 });
      if (r.model.format === 'DICOM') await this.sendTags(0);
    } catch (e) {
      await this.post({ type: 'error', message: e.message });
    } finally { this.job = null; }
  }

  async sendTags(index) {
    const f = this.sliceFile.length ? this.sliceFile[Math.min(index, this.sliceFile.length - 1)] : 0;
    const rows = this.tags[f] || [];
    await this.post({ type: 'tags', index, file: f, rows });
  }

  async doExport(msg) {
    const target = vscode.Uri.joinPath(this.source.kind === 'folder' ? this.source.uri : vscode.Uri.joinPath(this.source.uri, '..'), msg.suggested);
    const picked = await vscode.window.showSaveDialog({ defaultUri: target, title: 'Export slice as PNG', filters: { 'PNG image': ['png'] } });
    if (!picked) return this.post({ type: 'exported', cancelled: true });
    if (!/\.png$/i.test(picked.path) || picked.toString() === this.source.uri.toString()) {
      return this.post({ type: 'exported', error: 'Pick a .png file name. DICOM Viewer never writes to image files.' });
    }
    const bytes = Buffer.from(msg.data.slice(msg.data.indexOf(',') + 1), 'base64');
    await vscode.workspace.fs.writeFile(picked, bytes);
    return this.post({ type: 'exported', path: picked.fsPath || picked.path, bytes: bytes.length });
  }

  async onMessage(raw) {
    const v = validateWebviewMessage(raw);
    if (!v.ok) return;
    const msg = v.msg;
    try {
      if (msg.type === 'ready' || msg.type === 'reload') { await this.load(); return; }
      if (msg.type === 'series') { this.series = msg.index; this.volumeIndex = 0; await this.load(); return; }
      if (msg.type === 'volume') { this.volumeIndex = msg.index; await this.load(); return; }
      if (msg.type === 'tags') { await this.sendTags(msg.index); return; }
      if (msg.type === 'rendered') { if (!this.counted) { this.counted = true; rating.success(); } return; }
      if (msg.type === 'export') { await this.doExport(msg); return; }
      if (msg.type === 'reopenWith') { await vscode.commands.executeCommand('workbench.action.reopenWithEditor'); return; }
      if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await this.post({ type: 'copied', chars: msg.text.length }); }
    } catch (e) {
      await this.post({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
  }
}

class DicomEditorProvider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) { return new Session(this.context, panel, { kind: 'file', uri: document.uri }); }
}

function openFolder(context, uri) {
  const panel = vscode.window.createWebviewPanel(PANEL_TYPE, `${baseName(uri)} (DICOM)`, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
  return new Session(context, panel, { kind: 'folder', uri });
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'dicomViewer', message: (n) => `DICOM Viewer has opened ${n} scans for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'dicomViewer', selfId: EXT_ID });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DicomEditorProvider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('dicomViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#dicomViewer.start`, false)),
    vscode.commands.registerCommand('dicomViewer.openWith', async (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('dicomViewer.openFolder', async (uri) => {
      let target = uri;
      if (!target) {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open DICOM folder' });
        target = picked && picked[0];
      }
      if (target) openFolder(context, target);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, DicomEditorProvider, Session, parseInWorker, scanFolder, VIEW_TYPE, EXT_ID };

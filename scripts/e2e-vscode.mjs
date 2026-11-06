// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated phantoms,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(ws)) if (fs.statSync(f).size < 50e6) R.hashes[path.relative(ws, f)] = hash(f);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom' });
const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `dicom-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = (expr) => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.dicomViewerProbe ? window.dicomViewerProbe() : null)`));
const getWv = async (title) => vs.waitFor(async () => (await vs.webviews()).find((w) => w.title === title && w.w > 0), 20000);
const open = async (rel, title) => { const t0 = Date.now(); vs.open(path.join(ws, rel)); await sleep(800); wv = await getWv(title || path.basename(rel)); if (!wv) throw new Error('no webview for ' + rel); return Date.now() - t0; };
const loaded = async (needImage = true) => {
  const ok = await vs.waitFor(async () => { const p = await probe(); return p?.loaded && (!needImage || p.draws > 0); }, 30000, 200);
  if (!ok) throw new Error('not loaded: ' + await E(`document.body.innerText.slice(0, 400)`));
  await sleep(400); return probe();
};
const text = (sel) => E(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const key = async (k, code) => { await vs.key(k, code); await sleep(250); };
const canvasBox = async () => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('#view').getBoundingClientRect())`)); return { x: off.x + b.x, y: off.y + b.y, w: b.width, h: b.height }; };
const mouse = (type, x, y, extra = {}) => vs.s.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, vs.wb);
const imageCenter = async () => { const p = await probe(); const b = await canvasBox(); return [b.x + p.layout.dx + p.layout.dw / 2, b.y + p.layout.dy + p.layout.dh / 2, p, b]; };
const pickFromDialog = async (target) => {
  const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); return i && i.offsetParent ? i.value : null; })()`), 8000, 150);
  if (dlg === null) throw new Error('dialog did not open');
  await vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); i.focus(); i.select(); })()`);
  await vs.type(target); await sleep(600); await vs.key('Enter', 'Enter');
  return dlg;
};

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('Open Folder as DICOM Series from the command palette', async () => {
    await vs.command('DICOM Viewer: Open Folder as DICOM Series');
    await pickFromDialog(path.join(ws, 'head-ct') + '/');
    await sleep(500);
    wv = await getWv('head-ct/'); if (!wv) throw new Error('no folder webview');
    const p = await loaded();
    if (p.dims.join() !== '192,192,32') throw new Error(JSON.stringify(p));
    await shot('folder-head-ct');
    return { dims: p.dims };
  });
  await step('DICOMDIR opens by default: 48 referenced slices, axial, soft tissue window from the file, tags of the slice', async () => {
    const ms = await open('chest-ct/DICOMDIR'); const p = await loaded();
    const anon = await text('#anon');
    if (p.format !== 'DICOM' || p.dims.join() !== '256,256,48' || p.depth !== 48 || p.view !== 'axial' || p.preset !== 'file' || p.width !== 400 || !/Patient's Name and Patient ID are empty/.test(anon) || p.tagRows < 30) throw new Error(JSON.stringify({ p, anon }));
    return { openMs: ms, slices: p.depth, tagRows: p.tagRows, anon };
  });
  await step('lung preset by key 3, wheel scrolls 6 slices, tag table follows the slice', async () => {
    const [cx, cy] = await imageCenter();
    await mouse('mouseMoved', cx, cy);
    await E(`document.querySelector('#view').focus()`);
    await key('3', 'Digit3');
    const p0 = await probe();
    for (let i = 0; i < 6; i++) { await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: 120 }); await sleep(90); }
    await sleep(500); const p1 = await probe();
    const info = await text('.taginfo');
    if (p0.preset !== 'lung' || p0.width !== 1500 || p0.center !== -600 || p1.slice !== p0.slice + 6 || p1.tagIndex !== p1.slice) throw new Error(JSON.stringify({ p0, p1, info }));
    await shot('chest-lung-window');
    return { slice: p1.slice, tagFile: info };
  });
  await step('HU under the cursor: air outside the body is about -1000, lung about -860', async () => {
    const [cx, cy, p, b] = await imageCenter();
    const air = [b.x + p.layout.dx + 4, b.y + p.layout.dy + 4];
    await mouse('mouseMoved', air[0], air[1]); await sleep(200);
    const tAir = await text('#cursor');
    // right lung of the phantom sits at x = -72 mm, screen left of centre
    const lung = [cx - p.layout.dw * (72 / 320), cy];
    await mouse('mouseMoved', lung[0], lung[1]); await sleep(200);
    const tLung = await text('#cursor');
    const hu = (t) => +(/(-?[\d.]+) HU/.exec(t) || [])[1];
    if (!(hu(tAir) <= -990) || !(hu(tLung) < -700 && hu(tLung) > -950) || !/stored/.test(tLung)) throw new Error(JSON.stringify({ tAir, tLung }));
    return { air: tAir, lung: tLung };
  });
  await step('drag sets window and level (custom), bone preset, coronal view by a real click', async () => {
    const [cx, cy] = await imageCenter();
    const p0 = await probe();
    await mouse('mousePressed', cx, cy, { button: 'left', clickCount: 1 });
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', cx + k * 15, cy - k * 8, { button: 'left' }); await sleep(25); }
    await mouse('mouseReleased', cx + 120, cy - 64, { button: 'left', clickCount: 1 }); await sleep(300);
    const p1 = await probe();
    await E(`document.querySelector('#view').focus()`); await key('4', 'Digit4');
    await vs.wvClick(wv, `document.querySelector('button[data-view="coronal"]')`); await sleep(500);
    const p2 = await probe();
    if (p1.preset !== 'custom' || !(p1.width > p0.width) || !(p1.center < p0.center) || p2.view !== 'coronal' || p2.depth !== 256 || p2.preset !== 'bone') throw new Error(JSON.stringify({ p0, p1, p2 }));
    const marks = await E(`[...document.querySelectorAll('.mk')].map(m => m.textContent).join('')`);
    await shot('coronal-bone');
    if (marks !== 'RLSI') throw new Error('marks ' + marks);
    return { dragged: { width: p1.width, center: p1.center }, coronalDepth: p2.depth, marks };
  });
  await step('zoom with Ctrl+wheel at the cursor and fit with F', async () => {
    const [cx, cy] = await imageCenter();
    for (let i = 0; i < 4; i++) { await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: -200, modifiers: 2 }); await sleep(80); }
    await sleep(300); const p1 = await probe();
    await E(`document.querySelector('#view').focus()`); await key('f', 'KeyF'); const p2 = await probe();
    if (!(p1.zoom > 2) || p2.zoom !== 1) throw new Error(JSON.stringify({ p1: p1.zoom, p2: p2.zoom }));
    return { zoom: p1.zoom };
  });
  await step('export PNG through the save dialog', async () => {
    await vs.wvClick(wv, `document.querySelector('#export')`);
    const target = path.join(ws, 'exports', 'chest-coronal.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const suggested = await pickFromDialog(target);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 10000);
    if (!ok) throw new Error('no file; dialog said ' + suggested);
    const b = fs.readFileSync(target);
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    fs.copyFileSync(target, path.join(shotDir, 'export-chest-coronal.png'));
    if (!/DICOMDIR-coronal-\d{3}\.png$/.test(suggested) || w !== 256 || h !== 192) throw new Error(JSON.stringify({ suggested, w, h }));
    return { suggested, bytes: b.length, size: `${w} x ${h}` };
  });
  await step('tag search filters rows', async () => {
    await vs.wvClick(wv, `document.querySelector('#tagSearch')`); await vs.type('spacing'); await sleep(400);
    const rows = await E(`[...document.querySelectorAll('#tags tbody tr')].map(r => r.cells[2].textContent).join(' | ')`);
    if (!/Pixel Spacing/.test(rows) || rows.split('|').length > 4) throw new Error(rows);
    return { rows };
  });
  await step('a file with a (made-up) patient name and ID shows the warning bar and marked rows', async () => {
    await open('head-ct-with-name.dcm'); const p = await loaded();
    const warn = await text('#anon');
    await vs.wvClick(wv, `document.querySelector('#tagSearch')`); await vs.type('patient'); await sleep(400);
    const marked = await E(`document.querySelectorAll('#tags tr.phi').length`);
    await shot('anonymity-warning');
    if (!/Not anonymized: Patient's Name "PHANTOM\^DEMO" and Patient ID "SYN-0001"/.test(warn) || marked !== 2 || p.preset !== 'file' || p.width !== 80) throw new Error(JSON.stringify({ warn, marked, p }));
    return { warn };
  });
  await step('NIfTI .nii.gz: LAS volume, sagittal view, header table', async () => {
    await open('brain-phantom.nii.gz'); const p0 = await loaded();
    await E(`document.querySelector('#view').focus()`); await key('s', 'KeyS'); const p = await probe();
    const marks = await E(`[...document.querySelectorAll('.mk')].map(m => m.textContent).join('')`);
    const head = await E(`[...document.querySelectorAll('#tags tbody tr')].map(r => r.cells[0].textContent + '=' + r.cells[1].textContent).join(' | ')`);
    await key('0', 'Digit0');
    await shot('nifti-sagittal');
    if (p0.format !== 'NIfTI' || p0.dims.join() !== '128,150,110' || p.view !== 'sagittal' || p.depth !== 128 || marks !== 'APSI' || !/Orientation used=sform/.test(head)) throw new Error(JSON.stringify({ p, marks, head }));
    return { dims: p0.dims, marks, header: head.slice(0, 200) };
  });
  await step('RLE multi-frame MR and RGB ultrasound', async () => {
    await open('mr-brain-rle-multiframe.dcm'); const p = await loaded();
    const info = await text('.toolbar .info');
    await open('us-rgb.dcm'); const q = await loaded();
    const cur = await (async () => { const [cx, cy] = await imageCenter(); await mouse('mouseMoved', cx, cy); await sleep(200); return text('#cursor'); })();
    if (p.depth !== 24 || !/RLE Lossless/.test(info) || q.dims.join() !== '160,120,1' || !/RGB \d+, \d+, \d+/.test(cur)) throw new Error(JSON.stringify({ p, info, q, cur }));
    return { mr: info, rgbCursor: cur };
  });
  await step('JPEG 2000 file: tags shown, the transfer syntax named as not supported', async () => {
    await open('jpeg2000-not-supported.dcm'); await loaded(false);
    const t = await text('.noimage');
    const rows = await E(`document.querySelectorAll('#tags tbody tr').length`);
    await shot('jpeg2000-message');
    if (!/JPEG 2000 Lossless compression \(1\.2\.840\.10008\.1\.2\.4\.90\), which DICOM Viewer can't decode/.test(t) || rows < 20) throw new Error(JSON.stringify({ t, rows }));
    return { message: t.slice(0, 160), rows };
  });
  await step('over the size limit (sparse 1.2 GB .nii): message, nothing read', async () => {
    await open('huge.nii');
    await vs.waitFor(async () => /Nothing was read/.test(await E(`document.body.innerText`)), 15000);
    const t = await E(`document.body.innerText`);
    await shot('over-limit-message');
    if (!/1\.2 GB\. DICOM Viewer opens up to 1024 MB/.test(t)) throw new Error(t.slice(0, 300));
    return { message: t.slice(0, 200) };
  });
  await step('broken file: plain error and Try again', async () => {
    await open('broken.dcm');
    const ok = await vs.waitFor(async () => /could not be opened/.test(await E(`document.body.innerText`)), 15000);
    const t = await E(`document.body.innerText`);
    if (!ok || !/not a DICOM file/.test(t) || !/Try again/.test(t)) throw new Error(t.slice(0, 300));
    return { message: t.slice(0, 200) };
  });
} finally {
  R.console = vs.console.filter((c) => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /dicom|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ pass: R.steps.filter((s) => s.ok).length, total: R.steps.length, console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}

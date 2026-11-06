'use strict';
// DICOM and NIfTI viewer webview. All file text goes into the page with textContent. No network.
const { PRESETS, VIEWS, viewGeometry, voxelIndex, extractSlice, windowToBytes } = require('../core/volume');
const { exportName } = require('../core/protocol');

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined && v !== null) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
};

const S = {
  model: null, vol: null, view: 'axial', slice: { axial: 0, coronal: 0, sagittal: 0 }, center: 40, width: 400, invert: false,
  preset: 'file', zoom: 1, panX: 0, panY: 0, tagsOpen: true, tagRows: [], tagFilter: '', tagIndex: -1, name: '', smooth: false, rendered: false, defaultView: 'auto',
};
let ui = {};

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (Number.isInteger(v) || a >= 1000) return String(Math.round(v * 100) / 100);
  return String(+v.toPrecision(5));
}

function message(title, text, buttons = []) {
  app.textContent = '';
  const box = el('div', { class: 'message' }, el('h2', { text: title }), el('p', { text }));
  if (buttons.length) box.append(el('div', { class: 'buttons' }, ...buttons));
  app.append(box);
}
const btn = (label, onclick, attrs = {}) => el('button', { type: 'button', onclick, ...attrs, text: label });

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'init':
      S.name = m.name; S.smooth = !!m.smooth; S.defaultView = m.defaultView || 'auto';
      if (!m.plan.load) message(m.files > 1 ? 'Folder not opened' : 'File not opened', m.plan.message);
      else message('Reading...', `${m.name} · ${m.sizeText}${m.files > 1 ? ` · ${m.files} files` : ''}`);
      break;
    case 'progress':
      message('Reading files...', `${m.done} of ${m.total} files read`);
      break;
    case 'model': showModel(m); break;
    case 'tags': if (S.model && S.model.format !== 'DICOM') break; S.tagRows = m.rows; S.tagIndex = m.index; renderTags(); break;
    case 'error':
      message('The image could not be opened', m.message, [btn('Try again', () => vscode.postMessage({ type: 'reload' })), btn('Reopen with another editor', () => vscode.postMessage({ type: 'reopenWith' }))]);
      break;
    case 'exported':
      toast(m.cancelled ? 'Export cancelled' : m.error ? m.error : `Saved ${m.path}`);
      break;
    case 'copied': toast('Copied'); break;
    default: break;
  }
});

function toast(text) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(t.timer); t.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function typed(model) {
  const u8 = model.data instanceof Uint8Array ? model.data : new Uint8Array(model.data);
  const buf = u8.byteOffset % 4 === 0 ? u8.buffer : u8.slice().buffer;
  const off = u8.byteOffset % 4 === 0 ? u8.byteOffset : 0;
  if (model.dtype === 'int16') return new Int16Array(buf, off, u8.byteLength / 2);
  if (model.dtype === 'float32') return new Float32Array(buf, off, u8.byteLength / 4);
  return new Uint8Array(buf, off, u8.byteLength);
}

function defaultWindow(m) {
  if (m.rgb) return null;
  if (m.window) return { ...m.window, preset: 'file' };
  if (m.units === 'HU') return { center: 40, width: 400, preset: 'soft' };
  const st = m.stats || { p1: 0, p99: 1 };
  return { center: (st.p1 + st.p99) / 2, width: Math.max(st.p99 - st.p1, 1e-3), preset: 'auto' };
}

function showModel(msg) {
  const m = msg.model;
  S.model = m; S.name = msg.name;
  S.vol = m.hasImage ? { dims: m.dims, spacing: m.spacing, axes: m.axes, rgb: m.rgb, data: typed(m) } : null;
  if (S.vol) {
    const want = S.defaultView !== 'auto' ? S.defaultView : (m.plane || 'axial');
    S.view = VIEWS.includes(want) ? want : 'axial';
    for (const v of VIEWS) S.slice[v] = Math.floor(viewGeometry(S.vol, v).depth / 2);
    const w = defaultWindow(m);
    if (w) { S.center = w.center; S.width = w.width; S.preset = w.preset; }
    S.invert = !!m.invert; S.zoom = 1; S.panX = 0; S.panY = 0;
  }
  buildUi(msg);
  if (S.vol) { draw(); requestTagsForSlice(); }
  if (!S.rendered && S.vol) { S.rendered = true; vscode.postMessage({ type: 'rendered' }); }
}

function buildUi(msg) {
  const m = S.model;
  app.textContent = '';
  const info = [m.format, m.formatLabel !== m.format ? m.formatLabel : '', msg.sizeText, m.hasImage ? `${m.dims.join(' x ')}${m.rgb ? ' RGB' : ''}` : '', m.modality || ''].filter(Boolean).join(' · ');
  const viewBtns = VIEWS.map((v) => btn(v[0].toUpperCase() + v.slice(1), () => setView(v), { 'data-view': v, title: `${v} view (${v[0].toUpperCase()})`, disabled: !S.vol || S.vol.rgb && v !== 'axial' }));
  const presetSel = el('select', { id: 'preset', title: 'Window presets (keys 1 to 4, 0 for auto)', disabled: !S.vol || S.vol.rgb, onchange: (e) => applyPreset(e.target.value) },
    el('option', { value: 'file', text: 'From file', disabled: !m.window }),
    el('option', { value: 'auto', text: 'Auto (1% to 99%)' }),
    el('option', { value: 'full', text: 'Full range' }),
    ...PRESETS.map((p, i) => el('option', { value: p.id, text: `${p.label} (W ${p.width} L ${p.center}) [${i + 1}]` })),
    el('option', { value: 'custom', text: 'Custom', disabled: true }));
  const wIn = el('input', { id: 'ww', type: 'number', step: 'any', title: 'Window width', disabled: !S.vol || S.vol.rgb, onchange: (e) => { S.width = Math.max(1e-3, +e.target.value || 1); S.preset = 'custom'; draw(); } });
  const lIn = el('input', { id: 'wl', type: 'number', step: 'any', title: 'Window level (center)', disabled: !S.vol || S.vol.rgb, onchange: (e) => { S.center = +e.target.value || 0; S.preset = 'custom'; draw(); } });
  const toolbar = el('div', { class: 'toolbar' },
    el('span', { class: 'title', title: S.name, text: S.name }), el('span', { class: 'info', text: info }),
    el('span', { class: 'group' }, ...viewBtns),
    el('label', { class: 'group' }, el('span', { text: 'Window' }), presetSel),
    el('label', { class: 'num' }, el('span', { text: 'W' }), wIn), el('label', { class: 'num' }, el('span', { text: 'L' }), lIn),
    btn('Invert', () => { S.invert = !S.invert; draw(); }, { id: 'invert', title: 'Invert gray (I)', disabled: !S.vol || S.vol.rgb }),
    btn('Fit', () => { S.zoom = 1; S.panX = 0; S.panY = 0; draw(); }, { title: 'Fit to the window (F or double-click)', disabled: !S.vol }),
    btn('Tags', () => { S.tagsOpen = !S.tagsOpen; ui.side.hidden = !S.tagsOpen; if (S.tagsOpen) requestTagsForSlice(); draw(); }, { id: 'tagsBtn', title: 'Show or hide the tag table (T)' }),
    btn('Export PNG', exportPng, { id: 'export', title: 'Save the current slice as a PNG image', disabled: !S.vol }));
  if (m.series && m.series.length > 1) {
    toolbar.append(el('label', { class: 'group' }, el('span', { text: 'Series' }), el('select', { id: 'series', onchange: (e) => { message('Reading...', 'Loading the series'); vscode.postMessage({ type: 'series', index: +e.target.value }); } },
      ...m.series.map((s, i) => el('option', { value: i, text: s.label, selected: i === m.seriesIndex })))));
  }
  if (m.volumes > 1) {
    toolbar.append(el('label', { class: 'group' }, el('span', { text: 'Volume' }), el('select', { id: 'volume', onchange: (e) => { message('Reading...', 'Loading the volume'); vscode.postMessage({ type: 'volume', index: +e.target.value }); } },
      ...Array.from({ length: Math.min(m.volumes, 2000) }, (_, i) => el('option', { value: i, text: `${i + 1} of ${m.volumes}`, selected: i === m.volumeIndex })))));
  }
  app.append(toolbar);
  if (m.anon) {
    if (!m.anon.clean) {
      const parts = [];
      if (m.anon.patientName) parts.push(`Patient's Name "${m.anon.patientName}"`);
      if (m.anon.patientId) parts.push(`Patient ID "${m.anon.patientId}"`);
      const where = m.anon.files > 1 ? ` in ${m.anon.filesWithIdentity} of ${m.anon.files} files` : '';
      const others = m.anon.others.length ? ` Also filled: ${m.anon.others.join(', ')}.` : '';
      app.append(el('div', { class: 'warn', id: 'anon', role: 'alert', text: `Not anonymized: ${parts.join(' and ')}${where}. Remove them before you share or commit this data.${others}` }));
    } else {
      app.append(el('div', { class: 'ok', id: 'anon', text: `Anonymity check: Patient's Name and Patient ID are empty${m.anon.others.length ? `, but these are filled: ${m.anon.others.join(', ')}` : ''}.` }));
    }
  }
  const notes = [m.pixelNote, ...(m.notes || [])].filter(Boolean);
  if (notes.length) app.append(el('div', { class: 'notes', id: 'notes' }, ...notes.map((n) => el('div', { text: n }))));

  const canvas = el('canvas', { id: 'view', tabindex: '0', 'aria-label': 'Image slice' });
  const overlay = { tl: el('div', { class: 'ov tl' }), bl: el('div', { class: 'ov bl' }), tr: el('div', { class: 'ov tr' }), br: el('div', { class: 'ov br' }) };
  const marks = { l: el('div', { class: 'mk ml' }), r: el('div', { class: 'mk mr' }), t: el('div', { class: 'mk mt' }), b: el('div', { class: 'mk mb' }) };
  const stage = el('div', { class: 'stage' }, canvas, ...Object.values(overlay), ...Object.values(marks));
  if (!S.vol) stage.append(el('div', { class: 'noimage', text: m.pixelNote || 'No image to show.' }));
  const search = el('input', { id: 'tagSearch', type: 'search', placeholder: m.format === 'NIfTI' ? 'Search the header' : 'Search tags, names and values', oninput: (e) => { S.tagFilter = e.target.value; renderTags(); } });
  const tagInfo = el('div', { class: 'taginfo' });
  const table = el('table', { id: 'tags' });
  const side = el('div', { class: 'side', hidden: !S.tagsOpen }, search, tagInfo, el('div', { class: 'tablewrap' }, table));
  const main = el('div', { class: 'main' }, stage, side);
  const slider = el('input', { id: 'slice', type: 'range', min: 0, max: 0, value: 0, disabled: !S.vol, oninput: (e) => setSlice(+e.target.value) });
  const sliceLabel = el('span', { class: 'slicelabel' });
  const cursor = el('span', { class: 'cursor', id: 'cursor', text: S.vol ? 'Move the mouse over the image for values' : '' });
  const bar = el('div', { class: 'bar' }, sliceLabel, slider, cursor);
  app.append(main, bar);
  const footer = document.getElementById('zovo-support');
  if (footer) bar.append(footer);
  ui = { canvas, stage, overlay, marks, side, table, tagInfo, slider, sliceLabel, cursor, presetSel, wIn, lIn };
  if (m.format === 'NIfTI') { S.tagRows = (m.header || []).map(([k, v, key]) => [key || '', '', k, v, 0]); renderTags(); }
  bindCanvas();
}

function geometry() { return viewGeometry(S.vol, S.view); }

function setView(v) {
  if (!S.vol || (S.vol.rgb && v !== 'axial')) return;
  S.view = v; S.zoom = 1; S.panX = 0; S.panY = 0; draw(); requestTagsForSlice();
}

function setSlice(i) {
  const g = geometry();
  S.slice[S.view] = Math.max(0, Math.min(g.depth - 1, i | 0));
  draw(); requestTagsForSlice();
}

let tagTimer = 0;
function requestTagsForSlice() {
  if (!S.vol || S.model.format !== 'DICOM' || !S.tagsOpen) return;
  const g = geometry();
  // Tags belong to stored slices; in a reformatted view the tags of the middle stored slice are shown.
  const k = S.view === S.model.plane ? (g.flipD ? g.depth - 1 - S.slice[S.view] : S.slice[S.view]) : Math.floor(S.vol.dims[2] / 2);
  if (k === S.tagIndex) return;
  clearTimeout(tagTimer);
  tagTimer = setTimeout(() => vscode.postMessage({ type: 'tags', index: k }), 60);
}

function applyPreset(id) {
  const m = S.model;
  const st = m.stats || { min: 0, max: 1, p1: 0, p99: 1 };
  if (id === 'file' && m.window) { S.center = m.window.center; S.width = m.window.width; } else if (id === 'auto') { S.center = (st.p1 + st.p99) / 2; S.width = Math.max(st.p99 - st.p1, 1e-3); } else if (id === 'full') { S.center = (st.min + st.max) / 2; S.width = Math.max(st.max - st.min, 1e-3); } else {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    S.center = p.center; S.width = p.width;
  }
  S.preset = id; draw();
}

let off = null;
function draw() {
  if (!S.vol) return;
  const g = geometry();
  const s = S.slice[S.view];
  const sl = extractSlice(S.vol, S.view, s);
  if (!off || off.width !== g.w || off.height !== g.h) { off = document.createElement('canvas'); off.width = g.w; off.height = g.h; }
  const octx = off.getContext('2d');
  const img = octx.createImageData(g.w, g.h);
  if (S.vol.rgb) {
    for (let p = 0, o = 0; p < g.w * g.h; p++, o += 4) { img.data[o] = sl.pixels[p * 3]; img.data[o + 1] = sl.pixels[p * 3 + 1]; img.data[o + 2] = sl.pixels[p * 3 + 2]; img.data[o + 3] = 255; }
  } else windowToBytes(sl.pixels, S.center, S.width, S.invert, img.data);
  octx.putImageData(img, 0, 0);
  const c = ui.canvas;
  const rect = ui.stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.floor(rect.width)); const ch = Math.max(1, Math.floor(rect.height));
  if (c.width !== cw * dpr || c.height !== ch * dpr) { c.width = cw * dpr; c.height = ch * dpr; c.style.width = `${cw}px`; c.style.height = `${ch}px`; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
  const physW = g.w * g.pxW; const physH = g.h * g.pxH;
  const fit = Math.min(cw / physW, ch / physH) * 0.98;
  const scale = fit * S.zoom;
  const dw = physW * scale; const dh = physH * scale;
  const dx = (cw - dw) / 2 + S.panX; const dy = (ch - dh) / 2 + S.panY;
  ctx.imageSmoothingEnabled = S.smooth;
  ctx.drawImage(off, dx, dy, dw, dh);
  S.layout = { dx, dy, dw, dh, g };
  draws++;
  ui.slider.max = String(g.depth - 1); ui.slider.value = String(s);
  ui.sliceLabel.textContent = `${S.view[0].toUpperCase() + S.view.slice(1)} ${s + 1} / ${g.depth}`;
  ui.wIn.value = S.vol.rgb ? '' : fmt(S.width); ui.lIn.value = S.vol.rgb ? '' : fmt(S.center);
  if (ui.presetSel.querySelector(`option[value="${S.preset}"]`)) ui.presetSel.value = S.preset;
  for (const b of document.querySelectorAll('button[data-view]')) b.classList.toggle('on', b.dataset.view === S.view);
  const inv = document.getElementById('invert'); if (inv) inv.classList.toggle('on', S.invert);
  const m = S.model;
  ui.overlay.tl.textContent = [m.series && m.series[m.seriesIndex] ? m.series[m.seriesIndex].label : '', m.format === 'NIfTI' ? m.formatLabel : ''].filter(Boolean).join('\n');
  ui.overlay.bl.textContent = `${ui.sliceLabel.textContent}${S.view !== m.plane && m.dims[2] > 1 ? ' (reformatted)' : ''}${S.vol.rgb ? '' : `\nW ${fmt(S.width)}  L ${fmt(S.center)}${m.units ? ` ${m.units}` : ''}`}`;
  ui.overlay.tr.textContent = `${fmt(g.w * g.pxW)} x ${fmt(g.h * g.pxH)} mm\nZoom ${Math.round(S.zoom * 100)}%`;
  const known = !!m.oriented;
  const mk = { axial: ['R', 'L', 'A', 'P'], coronal: ['R', 'L', 'S', 'I'], sagittal: ['A', 'P', 'S', 'I'] }[S.view];
  ui.marks.l.textContent = known ? mk[0] : ''; ui.marks.r.textContent = known ? mk[1] : ''; ui.marks.t.textContent = known ? mk[2] : ''; ui.marks.b.textContent = known ? mk[3] : '';
}

function pick(ev) {
  if (!S.layout) return null;
  const r = ui.canvas.getBoundingClientRect();
  const { dx, dy, dw, dh, g } = S.layout;
  const x = Math.floor(((ev.clientX - r.left - dx) / dw) * g.w);
  const y = Math.floor(((ev.clientY - r.top - dy) / dh) * g.h);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
  const ijk = voxelIndex(S.vol, g, S.slice[S.view], x, y);
  const [nx, ny] = S.vol.dims;
  const idx = ijk[0] + nx * (ijk[1] + ny * ijk[2]);
  return { x, y, ijk, idx };
}

function describe(p) {
  const m = S.model;
  const pos = `i ${p.ijk[0]}  j ${p.ijk[1]}  k ${p.ijk[2]}`;
  if (S.vol.rgb) return `${pos}   RGB ${S.vol.data[p.idx * 3]}, ${S.vol.data[p.idx * 3 + 1]}, ${S.vol.data[p.idx * 3 + 2]}`;
  const v = S.vol.data[p.idx];
  if (m.units === 'HU') {
    const stored = (v - m.intercept) / (m.slope || 1);
    return `${pos}   ${fmt(v)} HU   (stored ${fmt(stored)})`;
  }
  if (m.format === 'NIfTI' && m.rawSlope !== undefined && (m.rawSlope !== 1 || m.rawIntercept !== 0)) return `${pos}   value ${fmt(v)}   (stored ${fmt((v - m.rawIntercept) / m.rawSlope)})`;
  if (m.format === 'DICOM' && (m.slope !== 1 || m.intercept !== 0)) return `${pos}   value ${fmt(v)}   (stored ${fmt((v - m.intercept) / m.slope)})`;
  return `${pos}   value ${fmt(v)}`;
}

function bindCanvas() {
  const c = ui.canvas;
  if (!S.vol) return;
  let drag = null;
  c.addEventListener('mousemove', (ev) => {
    if (drag) {
      const ddx = ev.clientX - drag.x; const ddy = ev.clientY - drag.y;
      if (drag.mode === 'pan') { S.panX = drag.panX + ddx; S.panY = drag.panY + ddy; } else if (!S.vol.rgb) {
        const k = Math.max(S.width, 1) / 300;
        S.width = Math.max(1e-3, drag.width + ddx * k); S.center = drag.center + ddy * k; S.preset = 'custom';
      }
      draw();
    }
    const p = pick(ev);
    ui.cursor.textContent = p ? describe(p) : '';
  });
  c.addEventListener('mousedown', (ev) => {
    c.focus();
    drag = { x: ev.clientX, y: ev.clientY, mode: ev.button === 1 || ev.button === 2 || ev.shiftKey ? 'pan' : 'wl', panX: S.panX, panY: S.panY, width: S.width, center: S.center };
    ev.preventDefault();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  c.addEventListener('mouseleave', () => { ui.cursor.textContent = ''; });
  c.addEventListener('dblclick', () => { S.zoom = 1; S.panX = 0; S.panY = 0; draw(); });
  c.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const r = c.getBoundingClientRect();
      const mx = ev.clientX - r.left - r.width / 2 - S.panX; const my = ev.clientY - r.top - r.height / 2 - S.panY;
      const f = Math.exp(-ev.deltaY * 0.0025);
      const z = Math.max(0.25, Math.min(32, S.zoom * f));
      const ratio = z / S.zoom;
      S.panX -= mx * (ratio - 1); S.panY -= my * (ratio - 1); S.zoom = z;
      draw();
    } else {
      const step = ev.deltaY > 0 ? 1 : ev.deltaY < 0 ? -1 : 0;
      if (step) setSlice(S.slice[S.view] + step);
    }
    const p = pick(ev); ui.cursor.textContent = p ? describe(p) : '';
  }, { passive: false });
}

window.addEventListener('keydown', (ev) => {
  if (!S.vol || ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
  const k = ev.key;
  const g = geometry();
  if (k === 'ArrowUp' || k === 'ArrowRight') setSlice(S.slice[S.view] + 1);
  else if (k === 'ArrowDown' || k === 'ArrowLeft') setSlice(S.slice[S.view] - 1);
  else if (k === 'PageUp') setSlice(S.slice[S.view] + 10);
  else if (k === 'PageDown') setSlice(S.slice[S.view] - 10);
  else if (k === 'Home') setSlice(0);
  else if (k === 'End') setSlice(g.depth - 1);
  else if (k >= '1' && k <= '4' && !S.vol.rgb) applyPreset(PRESETS[+k - 1].id);
  else if (k === '0' && !S.vol.rgb) applyPreset('auto');
  else if (k === 'a' || k === 'A') setView('axial');
  else if (k === 'c' || k === 'C') setView('coronal');
  else if (k === 's' || k === 'S') setView('sagittal');
  else if ((k === 'i' || k === 'I') && !S.vol.rgb) { S.invert = !S.invert; draw(); } else if (k === 'f' || k === 'F') { S.zoom = 1; S.panX = 0; S.panY = 0; draw(); } else if (k === 't' || k === 'T') document.getElementById('tagsBtn').click();
  else return;
  ev.preventDefault();
});

window.addEventListener('resize', () => { if (S.vol) draw(); });

function renderTags() {
  if (!ui.table) return;
  const m = S.model;
  const q = S.tagFilter.trim().toLowerCase();
  const t = ui.table;
  t.textContent = '';
  const nifti = m && m.format === 'NIfTI';
  t.append(el('thead', {}, el('tr', {}, ...(nifti ? ['Field', 'Value', 'Header key'] : ['Tag', 'VR', 'Name', 'Value']).map((h) => el('th', { text: h })))));
  const body = el('tbody');
  let shown = 0;
  for (const r of S.tagRows) {
    const [tag, vr, name, value, depth] = r;
    if (q && !`${tag} ${vr} ${name} ${value}`.toLowerCase().includes(q)) continue;
    if (shown >= 3000) break;
    shown++;
    const tr = el('tr', { title: 'Double-click to copy', ondblclick: () => vscode.postMessage({ type: 'copy', text: nifti ? `${name}\t${value}` : `${tag}\t${name}\t${value}` }) });
    if (/^\(0010,00(10|20)\)$/.test(tag) && String(value).trim()) tr.className = 'phi';
    if (nifti) tr.append(el('td', { text: name }), el('td', { class: 'val', text: value }), el('td', { class: 'mono', text: tag }));
    else {
      const nameTd = el('td', { text: name });
      nameTd.style.paddingLeft = `${4 + depth * 12}px`;
      tr.append(el('td', { class: 'mono', text: tag }), el('td', { class: 'mono', text: vr }), nameTd, el('td', { class: 'val', text: value }));
    }
    body.append(tr);
  }
  t.append(body);
  const total = S.tagRows.length;
  const which = m && m.format === 'DICOM' && m.sliceNames && m.sliceNames.length ? `${m.sliceNames[Math.max(0, S.tagIndex)] || ''} · ` : '';
  ui.tagInfo.textContent = `${which}${q ? `${shown} of ${total}` : total} ${nifti ? 'header fields' : 'elements'}`;
}

function exportPng() {
  if (!S.vol || !off) return;
  const g = geometry();
  const base = Math.min(g.pxW, g.pxH);
  let w = Math.round(g.w * g.pxW / base); let h = Math.round(g.h * g.pxH / base);
  const cap = 4096 / Math.max(w, h);
  if (cap < 1) { w = Math.round(w * cap); h = Math.round(h * cap); }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, w, h);
  vscode.postMessage({ type: 'export', format: 'png', data: c.toDataURL('image/png'), suggested: exportName(S.name.replace(/\/$/, ''), S.view, S.slice[S.view]) });
}

// Read-only state for the release check script (no file content beyond what is on screen).
let draws = 0;
window.dicomViewerProbe = () => ({
  loaded: !!S.model, hasImage: !!S.vol, draws, view: S.view, slice: S.vol ? S.slice[S.view] : 0, depth: S.vol ? geometry().depth : 0,
  center: S.center, width: S.width, preset: S.preset, invert: S.invert, zoom: S.zoom, layout: S.layout ? { dx: S.layout.dx, dy: S.layout.dy, dw: S.layout.dw, dh: S.layout.dh } : null,
  format: S.model && S.model.format, dims: S.model && S.model.dims, tagIndex: S.tagIndex, tagRows: S.tagRows.length,
});
vscode.postMessage({ type: 'ready' });

'use strict';
// Reads DICOM or NIfTI bytes off the extension host thread.
const { parentPort } = require('worker_threads');
const { loadModel } = require('./core/load');

parentPort.once('message', (input) => {
  try {
    const t0 = Date.now();
    const r = loadModel(input);
    r.model.parseMs = Date.now() - t0;
    const transfer = r.model.data ? [r.model.data.buffer] : [];
    parentPort.postMessage({ type: 'model', ...r }, transfer);
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
});

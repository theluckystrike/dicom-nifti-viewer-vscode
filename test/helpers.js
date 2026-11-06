'use strict';
// Writes the synthetic samples once per test file to a temp folder (11 MB, removed after the run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const samples = require('../scripts/make-samples');

const dirs = [];
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
let dir = null;
function sampleDir() {
  if (!dir) { dir = tmpDir('dicom-samples-'); samples.writeAll(dir); }
  return dir;
}
const read = (rel) => new Uint8Array(fs.readFileSync(path.join(sampleDir(), rel)));
function cleanup() { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
const reference = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reference.json'), 'utf8'));
const core = () => require('../test-build/core.js');
module.exports = { tmpDir, sampleDir, read, cleanup, reference, core, samples };

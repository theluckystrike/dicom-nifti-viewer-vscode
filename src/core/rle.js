'use strict';
// DICOM RLE Lossless (1.2.840.10008.1.2.5) decoder and encoder. The encoder is used by the sample script and the tests.

/**
 * Decodes one RLE frame into little-endian interleaved bytes (pixel by pixel, sample by sample).
 * @param {Uint8Array} frame fragment bytes: 64-byte header with up to 15 segment offsets, then PackBits segments
 */
function decodeRleFrame(frame, rows, cols, samples, bitsAllocated) {
  if (frame.length < 64) throw new Error('The RLE frame is shorter than its 64-byte header.');
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const nSeg = dv.getUint32(0, true);
  const bps = bitsAllocated / 8;
  if (!Number.isInteger(bps) || bps < 1 || bps > 4) throw new Error(`RLE with ${bitsAllocated} bits per sample is not supported.`);
  if (nSeg !== samples * bps) throw new Error(`The RLE frame has ${nSeg} segments, ${samples * bps} expected.`);
  const n = rows * cols;
  const out = new Uint8Array(n * samples * bps);
  for (let s = 0; s < nSeg; s++) {
    const start = dv.getUint32(4 + 4 * s, true);
    const end = s + 1 < nSeg ? dv.getUint32(4 + 4 * (s + 1), true) : frame.length;
    if (start < 64 || start > frame.length || end > frame.length || end < start) throw new Error('An RLE segment offset points outside the frame.');
    const sample = Math.floor(s / bps);
    const byteInSample = bps - 1 - (s % bps); // segment 0 holds the most significant bytes
    let p = 0; let i = start;
    const stride = samples * bps;
    let o = sample * bps + byteInSample;
    while (p < n && i < end) {
      const c = frame[i++];
      if (c < 128) {
        const len = c + 1;
        for (let k = 0; k < len && p < n && i < end; k++, p++, o += stride) out[o] = frame[i++];
      } else if (c > 128) {
        const len = 257 - c;
        const v = frame[i++];
        for (let k = 0; k < len && p < n; k++, p++, o += stride) out[o] = v;
      }
      // 128 is a no-op
    }
  }
  return out;
}

function packBits(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && run < 128 && bytes[i + run] === bytes[i]) run++;
    if (run >= 2) { out.push(257 - run, bytes[i]); i += run; continue; }
    let lit = 1;
    while (i + lit < bytes.length && lit < 128 && !(i + lit + 1 < bytes.length && bytes[i + lit] === bytes[i + lit + 1])) lit++;
    out.push(lit - 1); for (let k = 0; k < lit; k++) out.push(bytes[i + k]);
    i += lit;
  }
  if (out.length % 2) out.push(128); // segments are padded to an even length
  return out;
}

/** Encodes little-endian interleaved pixel bytes as one RLE frame. */
function encodeRleFrame(pixels, rows, cols, samples, bitsAllocated) {
  const bps = bitsAllocated / 8; const n = rows * cols; const segs = [];
  for (let s = 0; s < samples; s++) {
    for (let b = bps - 1; b >= 0; b--) {
      const seg = new Uint8Array(n);
      for (let p = 0; p < n; p++) seg[p] = pixels[(p * samples + s) * bps + b];
      segs.push(packBits(seg));
    }
  }
  const total = 64 + segs.reduce((a, s) => a + s.length, 0);
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  dv.setUint32(0, segs.length, true);
  let off = 64;
  segs.forEach((s, k) => { dv.setUint32(4 + 4 * k, off, true); out.set(s, off); off += s.length; });
  return out;
}

module.exports = { decodeRleFrame, encodeRleFrame };

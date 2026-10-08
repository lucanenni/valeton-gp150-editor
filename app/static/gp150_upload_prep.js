"use strict";
/*
 * Shared input preparation for the GP-150 library uploads (browser Captures page and MCP server):
 * name sanitising, WAV parsing and picking the one NAM model the pedal can use.
 * Browser global GP150UploadPrep; module.exports under node.
 */
(function (root) {
  // The pedal's names are 16 ASCII characters.
  function sanitizeName(name) {
    return Array.from(String(name).slice(0, 16), (c) => (c.charCodeAt(0) < 128 ? c : "_")).join("");
  }

  const u32be = (v, o) => v.getUint32(o, false);

  // Sample rate from a WAV header (0 when it isn't a plain RIFF/WAVE file).
  function wavSampleRate(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 28 || u32be(dv, 0) !== 0x52494646 || u32be(dv, 8) !== 0x57415645) return 0;
    for (let p = 12; p + 8 <= dv.byteLength; ) {
      const size = dv.getUint32(p + 4, true);
      if (u32be(dv, p) === 0x666d7420 && p + 16 <= dv.byteLength) return dv.getUint32(p + 12, true);
      p += 8 + size + (size & 1);
    }
    return 0;
  }

  // Parse a .wav file's raw PCM into signed 32-bit sample values (channel 0 only), sign-extended from the
  // file's own bit depth. No resampling, no bit-depth conversion: the IR upload sends these values verbatim.
  // `maxFrames` caps how many frames are read (the pedal keeps 2048).
  function decodeWavPcmSamples(arrayBuffer, { maxFrames = Infinity } = {}) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 12 || u32be(view, 0) !== 0x52494646 /* "RIFF" */ || u32be(view, 8) !== 0x57415645 /* "WAVE" */) {
      throw new Error("not a RIFF/WAVE file");
    }
    let fmt = null;
    let dataOffset = -1, dataLen = 0;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const id = u32be(view, offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === 0x666d7420 /* "fmt " */) {
        fmt = {
          formatTag: view.getUint16(body, true),
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bitsPerSample: view.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461 /* "data" */) {
        dataOffset = body;
        dataLen = Math.min(size, view.byteLength - body);
      }
      offset = body + size + (size % 2); // chunks are word-aligned
    }
    if (!fmt) throw new Error("no fmt chunk found");
    if (dataOffset < 0) throw new Error("no data chunk found");
    if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
      throw new Error(`unsupported bit depth: ${fmt.bitsPerSample}`);
    }
    if (fmt.formatTag === 3) throw new Error("floating-point WAV files are not supported for IR upload (use 16/24/32-bit PCM)");

    const bytesPerSample = fmt.bitsPerSample / 8;
    const frameBytes = bytesPerSample * fmt.channels;
    const numFrames = Math.floor(dataLen / frameBytes);
    const frames = Math.min(numFrames, maxFrames);
    const samples = new Array(frames);
    for (let i = 0; i < frames; i++) {
      const frameStart = dataOffset + i * frameBytes; // channel 0 only
      let v;
      if (bytesPerSample === 1) {
        v = view.getUint8(frameStart) - 128; // 8-bit WAV PCM is unsigned
      } else if (bytesPerSample === 2) {
        v = view.getInt16(frameStart, true);
      } else if (bytesPerSample === 3) {
        const b0 = view.getUint8(frameStart), b1 = view.getUint8(frameStart + 1), b2 = view.getUint8(frameStart + 2);
        v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
      } else {
        v = view.getInt32(frameStart, true);
      }
      samples[i] = v;
    }
    return { ...fmt, samples };
  }

  // Channel 0 of a WAV as floats in [-1, 1] at the file's own rate (PCM 8/16/24/32 or float 32/64).
  // The browser decodes with decodeAudioData instead; this is for Node.
  function decodeWavFloat(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const rate = wavSampleRate(arrayBuffer);
    if (!rate) throw new Error("not a RIFF/WAVE file");
    let fmt = null, dataOffset = -1, dataLen = 0;
    for (let p = 12; p + 8 <= view.byteLength; ) {
      const id = u32be(view, p), size = view.getUint32(p + 4, true), body = p + 8;
      if (id === 0x666d7420) fmt = { tag: view.getUint16(body, true), channels: view.getUint16(body + 2, true), bits: view.getUint16(body + 14, true) };
      else if (id === 0x64617461) { dataOffset = body; dataLen = Math.min(size, view.byteLength - body); }
      p = body + size + (size & 1);
    }
    if (!fmt || dataOffset < 0) throw new Error("incomplete WAV file");
    const bytes = fmt.bits / 8, frameBytes = bytes * fmt.channels, n = Math.floor(dataLen / frameBytes);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = dataOffset + i * frameBytes;
      let v;
      if (fmt.tag === 3 && fmt.bits === 32) v = view.getFloat32(o, true);
      else if (fmt.tag === 3 && fmt.bits === 64) v = view.getFloat64(o, true);
      else if (fmt.bits === 8) v = (view.getUint8(o) - 128) / 128;
      else if (fmt.bits === 16) v = view.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) { let t = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16); if (t & 0x800000) t -= 0x1000000; v = t / 8388608; }
      else if (fmt.bits === 32) v = view.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV format (tag ${fmt.tag}, ${fmt.bits} bits)`);
      out[i] = v;
    }
    return { samples: out, sampleRate: rate };
  }

  // Pick the one NAM/WaveNet model this pedal can actually use: either the file's own top-level model if it
  // is already a plain WaveNet with exactly `wantCount` weights, or the submodel of a `SlimmableContainer`
  // (NAM's trainer output, bundling a "lite" and a "full" model) that has exactly that many. Returns
  // {weights, loudness}: `loudness` is that SAME submodel's own metadata.loudness (the pedal's header embeds
  // it verbatim; undefined when absent). Throws with a clear reason instead of picking something close.
  function pickNamLiteModel(namJson, wantCount) {
    if (namJson.architecture === "WaveNet" && Array.isArray(namJson.weights) && namJson.weights.length === wantCount) {
      return { weights: namJson.weights, loudness: namJson.metadata && namJson.metadata.loudness };
    }
    const submodels = namJson.config && namJson.config.submodels;
    if (Array.isArray(submodels)) {
      const match = submodels.find(
        (s) => s && s.model && Array.isArray(s.model.weights) && s.model.weights.length === wantCount,
      );
      if (match) return { weights: match.model.weights, loudness: match.model.metadata && match.model.metadata.loudness };
    }
    throw new Error(
      `no ${wantCount}-weight "lite" WaveNet model found in this file -- this pedal only supports that `
      + `one architecture (see this file's SlimmableContainer submodels, or its own top-level weights, if any)`,
    );
  }

  // The model output is scaled by 0.31 and quantized to 16 bit before profiling, the way Suite's NAM converter
  // does (in place; returns the array).
  function quantizeNamOutput(modeled) {
    for (let i = 0; i < modeled.length; i++) {
      const q = Math.round(modeled[i] * 0.31 * 32768) / 32768;
      modeled[i] = q > 32767 / 32768 ? 32767 / 32768 : q < -1 ? -1 : q;
    }
    return modeled;
  }

  const API = { quantizeNamOutput, sanitizeName, wavSampleRate, decodeWavPcmSamples, decodeWavFloat, pickNamLiteModel };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.GP150UploadPrep = API;
})(typeof window !== "undefined" ? window : globalThis);

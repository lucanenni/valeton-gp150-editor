"use strict";
/*
 * GP150Zip: the smallest ZIP writer/reader the preset backup needs, no dependencies.
 *
 *   build([{name, data: Uint8Array}], {date})  -> Uint8Array  (method 0 "stored": .prst bodies are
 *                                                  1128 bytes of mostly float data, deflate buys little)
 *   parse(bytes)                               -> Promise<[{name, data}]>  (stored, and deflate through
 *                                                  DecompressionStream so a zip re-packed by an OS tool
 *                                                  still opens; directories skipped; CRC-32 checked)
 *
 * No zip64, no encryption, no multi-disk: archives of a few hundred small files.
 * Browser global GP150Zip; module.exports under node.
 */
(function (root) {
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder(), dec = new TextDecoder("utf-8");

  function dosTime(d) {
    const y = Math.max(1980, d.getFullYear());
    return [
      (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    ];
  }

  function build(files, { date = new Date() } = {}) {
    const [time, day] = dosTime(date);
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // utf-8 names
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, day, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, day, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot read compressed zip entries");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function parse(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip directory");
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (name.endsWith("/")) continue;
      if (flags & 1) throw new Error(`${name}: encrypted entries are not supported`);
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error("corrupt zip entry");
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = bytes.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error(`${name}: unsupported compression method ${method}`);
      if (data.length !== usize || crc32(data) !== crc) throw new Error(`${name}: CRC mismatch (damaged zip?)`);
      out.push({ name, data });
    }
    return out;
  }

  const API = { build, parse, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.GP150Zip = API;
})(typeof window !== "undefined" ? window : globalThis);

// Small, dependency-free archive support: write .zip (stored) and .tar.gz for
// export, and read .zip / .tar.gz / .tgz for import. Compression uses the
// browser's CompressionStream and DecompressionStream.
(function () {
  const SX = window.Scransible;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const toBytes = content => typeof content === 'string' ? encoder.encode(content) : content;

  function dosDateTime(date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  async function pipe(bytes, stream) {
    const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
  }

  SX.Archive = {
    // files: [{ path, content: string | Uint8Array }] -> Blob
    zip(files) {
      const { time, day } = dosDateTime();
      const parts = [];
      const central = [];
      let offset = 0;
      for (const file of files) {
        const name = encoder.encode(file.path);
        const data = toBytes(file.content);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);      // UTF-8 names
        local.setUint16(8, 0, true);           // stored
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        parts.push(local, name, data);
        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, 0x0800, true);
        entry.setUint16(12, time, true);
        entry.setUint16(14, day, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, data.length, true);
        entry.setUint16(28, name.length, true);
        entry.setUint32(38, (0o100644 << 16) >>> 0, true);
        entry.setUint32(42, offset, true);
        central.push(entry, name);
        offset += 30 + name.length + data.length;
      }
      const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, files.length, true);
      end.setUint16(10, files.length, true);
      end.setUint32(12, centralSize, true);
      end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end], { type: 'application/zip' });
    },

    async tarGz(files) {
      const blocks = [];
      const mtime = Math.floor(Date.now() / 1000);
      for (const file of files) {
        const data = toBytes(file.content);
        blocks.push(tarHeader(file.path, data.length, mtime), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) blocks.push(new Uint8Array(pad));
      }
      blocks.push(new Uint8Array(1024));
      const tar = new Uint8Array(await new Blob(blocks).arrayBuffer());
      if (typeof CompressionStream === 'undefined') throw new Error('this browser cannot gzip files');
      return new Blob([await pipe(tar, new CompressionStream('gzip'))], { type: 'application/gzip' });
    },

    // -> [{ path, bytes }] for regular files.
    async unzip(buffer) {
      const view = new DataView(buffer);
      let eocd = -1;
      for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('not a zip file');
      const count = view.getUint16(eocd + 10, true);
      let pos = view.getUint32(eocd + 16, true);
      const files = [];
      for (let n = 0; n < count; n++) {
        if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('damaged zip directory');
        const method = view.getUint16(pos + 10, true);
        const compressedSize = view.getUint32(pos + 20, true);
        const nameLength = view.getUint16(pos + 28, true);
        const extraLength = view.getUint16(pos + 30, true);
        const commentLength = view.getUint16(pos + 32, true);
        const localOffset = view.getUint32(pos + 42, true);
        const path = decoder.decode(new Uint8Array(buffer, pos + 46, nameLength));
        pos += 46 + nameLength + extraLength + commentLength;
        if (path.endsWith('/')) continue;
        const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const raw = new Uint8Array(buffer.slice(dataStart, dataStart + compressedSize));
        if (method === 0) files.push({ path, bytes: raw });
        else if (method === 8) files.push({ path, bytes: await pipe(raw, new DecompressionStream('deflate-raw')) });
        else throw new Error(`${path} uses an unsupported zip compression method`);
      }
      return files;
    },

    async untarGz(buffer) {
      let bytes = new Uint8Array(buffer);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await pipe(bytes, new DecompressionStream('gzip'));
      const files = [];
      let longName = null;
      for (let pos = 0; pos + 512 <= bytes.length;) {
        const header = bytes.subarray(pos, pos + 512);
        if (header.every(b => b === 0)) break;
        const field = (start, length) => decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        const prefix = field(345, 155);
        let path = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        longName = null;
        const data = bytes.subarray(pos + 512, pos + 512 + size);
        if (type === 'L') longName = decoder.decode(data).replace(/\0.*$/s, '');
        else if (type === 'x') {
          const match = decoder.decode(data).match(/\d+ path=([^\n]*)\n/);
          if (match) longName = match[1];
        } else if (type === '0' || type === '\0') {
          path = path.replace(/^\.\//, '');
          files.push({ path, bytes: data.slice() });
        }
        pos += 512 + Math.ceil(size / 512) * 512;
      }
      return files;
    },

    text: bytes => decoder.decode(bytes)
  };

  function tarHeader(path, size, mtime) {
    const header = new Uint8Array(512);
    const write = (text, start, length) => header.set(encoder.encode(text).subarray(0, length), start);
    let name = path;
    let prefix = '';
    if (encoder.encode(path).length > 100) {
      const cut = path.lastIndexOf('/', 155);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
    write(name, 0, 100);
    write('0000644\0', 100, 8);
    write('0000000\0', 108, 8);
    write('0000000\0', 116, 8);
    write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
    write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12);
    write('        ', 148, 8);
    header[156] = 48;                    // '0' regular file
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    write(prefix, 345, 155);
    const checksum = header.reduce((sum, b) => sum + b, 0);
    write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return header;
  }
})();

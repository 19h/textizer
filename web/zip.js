// Store-only ZIP writer. PNG pages are already deflated, so entries are stored
// as-is; a fixed DOS timestamp keeps archives byte-identical for identical input.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the format's epoch
const UTF8_NAMES = 0x0800;

// files: [{ name: string, bytes: Uint8Array }] -> Blob (application/zip)
export function zip(files) {
  if (files.length > 0xffff) throw new Error('zip holds at most 65535 entries');
  const encoder = new TextEncoder();
  const body = [];
  const directory = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const path = encoder.encode(name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, path.length, true);
    body.push(local, path, bytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_NAMES, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, path.length, true);
    central.setUint32(42, offset, true);
    directory.push(central, path);

    offset += 30 + path.length + bytes.length;
    if (offset > 0xffffffff) throw new Error('zip exceeds 4 GiB without zip64');
  }
  const size = directory.reduce((total, part) => total + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...directory, end], { type: 'application/zip' });
}

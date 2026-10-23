// All filesystem objects must be captured during the browser's paste/drop event.
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SET_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 512;
const MAX_ENTRIES = 10000;
const encoder = new TextEncoder();

export function cleanPath(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(p => p && p !== '.');
  if (!parts.length || parts.includes('..') || /[\r\n\0]/.test(path)) throw Error('invalid file path');
  return parts.join('/');
}

export function displayPath(path, prefix = '') {
  const base = prefix.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (base.length > 4096) throw Error('path prefix exceeds 4096 characters');
  if (/[\r\n\0]/.test(base)) throw Error('path prefix cannot contain line breaks');
  return base ? `${base}/${cleanPath(path)}` : cleanPath(path);
}

export function fileText(file, prefix = '') {
  return `# ${displayPath(file.path, prefix)}\n${file.text}`;
}

export function combinedText(files, prefix = '') {
  return files.map(file => fileText(file, prefix)).join('\n\n');
}

export function decodeText(bytes, file = {}) {
  const b = new Uint8Array(bytes);
  const mime = (file.type ?? '').toLowerCase().split(';')[0];
  if (/directory/.test(mime)) throw Error('folder contents were not exposed by the browser; use open folder');
  if (/^(image|audio|video|font)\//.test(mime) || /^(application\/(pdf|zip|gzip|wasm|x-executable|x-sharedlib))$/.test(mime))
    throw Error('binary media type');
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (magic.startsWith('%PDF-') || magic.startsWith('MZ') || /^PK[\x03\x05\x07][\x04\x06\x08]/.test(magic) || magic.startsWith('\x7fELF') ||
      magic.startsWith('\x00asm') || magic.startsWith('\x89PNG') || magic.startsWith('GIF8') ||
      (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x1f && b[1] === 0x8b)) throw Error('binary signature');
  let encoding = 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) encoding = 'utf-16le';
  else if (b[0] === 0xfe && b[1] === 0xff) encoding = 'utf-16be';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(b); }
  catch { throw Error('not valid UTF-8 or BOM-marked UTF-16 text'); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw Error('binary control characters');
  return text;
}

export function captureTransfer(transfer) {
  const items = Array.from(transfer?.items ?? []).filter(item => item.kind === 'file');
  const roots = items.map(item => {
    let entry = null, handle = null, file = null;
    try { entry = (item.getAsEntry ?? item.webkitGetAsEntry)?.call(item); } catch { /* fallback */ }
    try { handle = item.getAsFileSystemHandle?.(); } catch { /* fallback */ }
    try { file = item.getAsFile?.(); } catch { /* fallback */ }
    return { entry, handle: handle?.catch(() => null), file };
  });
  if (!roots.length) for (const file of Array.from(transfer?.files ?? [])) roots.push({ file });
  return { roots, hadFiles: roots.length > 0 || Array.from(transfer?.types ?? []).includes('Files') };
}

export function captureFiles(files) {
  return { roots: Array.from(files, file => ({ file })), hadFiles: files.length > 0 };
}

export async function collectTextFiles(capture) {
  const accepted = [], skipped = [];
  let seen = 0, total = 0;
  const paths = new Set();
  async function read(file, path) {
    try {
      path = cleanPath(path);
      if (paths.has(path)) throw Error('duplicate path');
      paths.add(path);
      if (file.size > MAX_FILE_BYTES) throw Error('file exceeds 4 MiB');
      if (accepted.length >= MAX_FILES) throw Error('set exceeds 512 text files');
      const text = decodeText(await file.arrayBuffer(), file);
      const bytes = encoder.encode(text).length;
      if (bytes > MAX_FILE_BYTES) throw Error('decoded text exceeds 4 MiB');
      if (total + bytes > MAX_SET_BYTES) throw Error('set exceeds 16 MiB of text');
      accepted.push({ path, text, bytes }); total += bytes;
    } catch (error) { skipped.push({ path: path || file.name, reason: String(error.message ?? error) }); }
  }
  async function walkEntry(entry, parent = '', depth = 0) {
    if (++seen > MAX_ENTRIES || depth > 64) throw Error('folder traversal limit reached');
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      try { await read(await new Promise((resolve, reject) => entry.file(resolve, reject)), path); }
      catch (error) { skipped.push({ path, reason: String(error.message ?? error) }); }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // Chromium returns directory entries in batches; an empty batch ends traversal.
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child, path, depth + 1);
      }
    }
  }
  async function walkHandle(handle, parent = '', depth = 0) {
    if (++seen > MAX_ENTRIES || depth > 64) throw Error('folder traversal limit reached');
    const path = parent ? `${parent}/${handle.name}` : handle.name;
    if (handle.kind === 'file') await read(await handle.getFile(), path);
    else for await (const child of handle.values()) await walkHandle(child, path, depth + 1);
  }
  for (const root of capture.roots) {
    try {
      const handle = await root.handle;
      if (root.entry) await walkEntry(root.entry);
      else if (handle) await walkHandle(handle);
      else if (root.file) {
        if (++seen > MAX_ENTRIES) throw Error('file traversal limit reached');
        await read(root.file, root.file.webkitRelativePath || root.file.name);
      }
    } catch (error) { skipped.push({ path: root.entry?.name ?? root.file?.name ?? 'folder', reason: String(error.message ?? error) }); }
  }
  accepted.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: accepted, skipped };
}

// Split only at Unicode scalar boundaries. Headers appear once in the stream.
export function chunks(text, budget = MAX_FILE_BYTES) {
  const result = []; let start = 0, bytes = 0, index = 0;
  for (const ch of text) {
    const size = ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4;
    if (bytes + size > budget) { result.push(text.slice(start, index)); start = index; bytes = 0; }
    bytes += size; index += ch.length;
  }
  if (index > start || !result.length) result.push(text.slice(start));
  return result;
}

export function renderInputs(text, files, separate, prefix) {
  if (!files?.length) return [{ text, path: null, fileIndex: null }];
  if (!separate) return chunks(combinedText(files, prefix)).map(text => ({ text, path: null, fileIndex: null }));
  return files.flatMap((file, fileIndex) => chunks(fileText(file, prefix)).map(text => ({ text, path: displayPath(file.path, prefix), fileIndex })));
}

// Render worker. Owns the WASM document so layout and PNG encoding never block
// the UI thread. Every request carries an id; page and rows requests also carry
// the layout seq they were issued for, so a replaced document is never read.
import init, { PackedText } from '../pkg/textizer.js?v=file-reflow-6';
import { renderInputs, displayPath } from './files.js?v=file-reflow-6';
import { createPlan } from './render-plan.js?v=file-reflow-6';

let doc = null;
let docSeq = 0;
let inputs = [], manifest = null, activeIndex = -1, options = null, generation = 0;
function activate(index) {
  if (activeIndex !== index) {
    doc?.free(); doc = null; activeIndex = -1;
    doc = new PackedText(inputs[index].text, JSON.stringify(options)); activeIndex = index;
  }
  return doc;
}

const describe = error => (error instanceof Error ? error.message : String(error));

const ready = init({ module_or_path: new URL('../pkg/textizer_bg.wasm?v=file-reflow-6', import.meta.url) }).then(
  () => self.postMessage({ type: 'ready' }),
  error => {
    self.postMessage({ type: 'fatal', message: describe(error) });
    throw error;
  },
);

self.onmessage = async ({ data }) => {
  const { id, type, seq } = data;
  try {
    await ready;
    if (type === 'layout') {
      const ticket = ++generation;
      doc?.free();
      doc = null;
      activeIndex = -1;
      const hasFiles = Boolean(data.files?.length);
      const nextInputs = renderInputs(data.text, data.files, data.separate, data.prefix, data.options.reflow);
      // File bodies have already been reflowed individually; native document
      // reflow would collapse the header and file boundaries as well.
      const nextOptions = hasFiles ? { ...data.options, reflow: false } : data.options;
      const nextManifest = createPlan(PackedText, nextInputs, nextOptions);
      nextManifest.options = { ...data.options };
      nextManifest.reflow_scope = hasFiles ? 'file_bodies' : 'document';
      const sourceBytes = new TextEncoder().encode(data.text);
      nextManifest.input_bytes = sourceBytes.length;
      const digest = await crypto.subtle.digest('SHA-256', sourceBytes);
      if (ticket !== generation) throw Error('document was replaced');
      inputs = nextInputs; options = nextOptions; manifest = nextManifest;
      manifest.source_sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
      manifest.file_mode = data.files?.length ? (data.separate ? 'per_file' : 'combined') : null;
      manifest.files = data.files?.map(file => ({ path: displayPath(file.path, data.prefix), bytes: file.bytes })) ?? [];
      docSeq = seq;
      self.postMessage({ type, id, manifest: JSON.stringify(manifest, null, 2) });
      return;
    }
    if (!manifest || seq !== docSeq) throw new Error('document was replaced');
    if (type === 'page') {
      const page = manifest.pages[data.index];
      if (!page) throw Error('page index out of range');
      const bytes = activate(page.source_index).pagePng(page.source_page_index);
      self.postMessage({ type, id, bytes }, [bytes.buffer]);
    } else if (type === 'rows') {
      // Same shape as the CLI's rows.json: one array of rows per page.
      const pages = [];
      for (const page of manifest.pages) pages.push(activate(page.source_index).pageRowsJson(page.source_page_index));
      self.postMessage({ type, id, json: `[${pages.join(',')}]` });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id, message: describe(error), trap: error instanceof WebAssembly.RuntimeError });
  }
};

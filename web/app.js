// Textizer web UI. Plain ES modules: layout and PNG encoding run in worker.js on
// the WASM package, history lives in IndexedDB via store.js.
import { openStore } from './store.js?v=file-reflow-6';
import { zip } from './zip.js';
import { captureTransfer, captureFiles, collectTextFiles, combinedText, displayPath, MAX_SET_BYTES, MAX_FILES } from './files.js?v=file-reflow-6';
import { DEFAULTS, RESOLUTIONS, capacity, normalizeOptions, optionProblem, resolutionName } from './options.js?v=file-reflow-6';

const MAX_INPUT_BYTES = 4 * 1024 * 1024; // the library limit, checked before anything is stored
const LARGE_TEXT = 256 * 1024; // above this many UTF-16 units, typing re-lays out less eagerly
const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');
const PASTE_KEYS = MAC ? '⌘v' : 'ctrl+v';
// WebKit may not dispatch paste without an editable focus; it gets a Clipboard API fallback.
const WEBKIT_ONLY = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(navigator.userAgent);
const NARROW = matchMedia('(max-width: 760px)');

const $ = id => document.getElementById(id);
const ui = {
  app: $('app'), sidebar: $('sidebar'), scrim: $('scrim'), drawer: $('drawer'),
  search: $('search'), newText: $('new'), newBar: $('new-bar'), history: $('history'), histCount: $('hist-count'),
  storeKind: $('store-kind'), clearHistory: $('clear-history'),
  title: $('title'), badge: $('badge'), paste: $('paste'), open: $('open'), file: $('file'),
  scroll: $('scroll'), inputMeta: $('input-meta'), crlf: $('crlf'), gutter: $('gutter'), text: $('text'),
  preset: $('opt-preset'), cols: $('opt-cols'), grid: $('opt-grid'), width: $('opt-width'), height: $('opt-height'),
  resolution: $('opt-resolution'), pageMode: $('opt-page-mode'), resolutionNote: $('resolution-note'),
  theme: $('opt-theme'), capacity: $('capacity'),
  crop: $('opt-crop'), cropSwitch: $('crop-switch'),
  fontSize: $('opt-font-size'), antialias: $('opt-antialias'), antialiasSwitch: $('antialias-switch'),
  reflow: $('opt-reflow'), reflowSwitch: $('reflow-switch'), optError: $('opt-error'), optReset: $('opt-reset'),
  pages: $('pages'), pagesCount: $('pages-count'), pagesMeta: $('pages-meta'), zip: $('zip'),
  mode: $('st-mode'), stState: $('st-state'), stLabel: $('st-state-label'), stFont: $('st-font'),
  stLayout: $('st-layout'), stBytes: $('st-bytes'), stSha: $('st-sha'), stStore: $('st-store'),
  toasts: $('toasts'), dropzone: $('dropzone'),
  clearDialog: $('clear-dialog'), clearLabel: $('clear-label'), keysDialog: $('keys-dialog'),
  charKeys: $('charkeys'), charKeysSwitch: $('charkeys-switch'), main: document.querySelector('.main'),
  folder: $('folder'), openFolder: $('open-folder'), fileSet: $('file-set'), fileList: $('file-list'),
  fileCount: $('file-count'), fileMode: $('file-mode'), pathPrefix: $('path-prefix'), clearFiles: $('clear-files'),
  skipped: $('skipped-files'), skippedSummary: $('skipped-summary'), skippedList: $('skipped-list'),
};

// ── small helpers ────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
}
const icon = name => h('span', { class: `ph-icon ph-icon--sm i-${name}`, 'aria-hidden': 'true' });
const message = error => (error instanceof Error ? error.message : String(error));

const fmt = n => n.toLocaleString('en-US');
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const fmtBytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function dayLabel(ts) {
  const day = isoDay(new Date(ts));
  const now = new Date();
  if (day === isoDay(now)) return 'today';
  now.setDate(now.getDate() - 1);
  return day === isoDay(now) ? 'yesterday' : day;
}

// Byte length as TextEncoder would produce it, without allocating the encoding.
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function countLines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

const collapse = s => s.replace(/\s+/g, ' ').trim();

function describe(text) {
  const head = text.slice(0, 4000);
  const first = head.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  return {
    title: collapse(first).slice(0, 80) || 'whitespace',
    preview: collapse(head).slice(0, 200),
    chars: text.length,
    bytes: utf8Length(text),
    lines: countLines(text),
  };
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) return null; // insecure origins: no duplicate detection
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Per-viewer conveniences only; history itself lives in IndexedDB.
const prefs = {
  get(key, fallback) {
    try { const value = localStorage.getItem(`textizer.${key}`); return value == null ? fallback : JSON.parse(value); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`textizer.${key}`, JSON.stringify(value)); } catch { /* storage blocked */ }
  },
};

// ── renderer: promise wrapper over the worker ────────────────

class Superseded extends Error {}

class Renderer {
  #worker = null;
  #pending = new Map();
  #nextId = 0;
  #generation = 0;
  #layouts = 0;
  ready;

  constructor() { this.ready = this.#spawn(); }

  #spawn() {
    this.#worker?.terminate();
    this.#generation++;
    for (const request of this.#pending.values()) request.reject(new Superseded('superseded'));
    this.#pending.clear();
    const worker = new Worker(new URL('./worker.js?v=file-reflow-6', import.meta.url), { type: 'module' });
    this.#worker = worker;
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') return resolve();
        if (data.type === 'fatal') return reject(new Error(data.message));
        const request = this.#pending.get(data.id);
        if (!request) return;
        this.#pending.delete(data.id);
        if (data.type !== 'error') return request.resolve(data);
        // A trap can leave the WASM heap inconsistent; later requests get a fresh instance.
        if (data.trap) this.ready = this.#spawn();
        request.reject(new Error(data.message));
      };
      worker.onerror = event => {
        event.preventDefault();
        reject(new Error(event.message || 'worker.js or ../pkg/textizer.js failed to load'));
      };
    });
    ready.catch(() => {}); // callers that await it report the failure
    return ready;
  }

  #call(request) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id });
    });
  }

  // Resolves to { manifest, json }; json is the library's own pretty manifest.
  async layout(seq, text, options, files = [], separate = false, prefix = '') {
    // A layout still running for stale text is abandoned; a fresh worker is cheaper than waiting.
    if (this.#layouts > 0) this.ready = this.#spawn();
    const generation = this.#generation;
    this.#layouts++;
    try {
      await this.ready;
      if (generation !== this.#generation) throw new Superseded('superseded');
      const { manifest: json } = await this.#call({ type: 'layout', seq, text, options, files, separate, prefix });
      return { manifest: JSON.parse(json), json };
    } finally {
      this.#layouts--;
    }
  }

  async page(seq, index) { await this.ready; return (await this.#call({ type: 'page', seq, index })).bytes; }

  async rows(seq) { await this.ready; return (await this.#call({ type: 'rows', seq })).json; }
}

// ── state ────────────────────────────────────────────────────

const state = {
  store: null,
  entries: [],     // metadata, newest first
  current: null,   // metadata of the open entry; null while the text is an unsaved draft
  text: '',        // source of truth: textarea.value normalizes CR and CRLF
  files: [], separate: false, pathPrefix: '', skippedFiles: [],
  dirty: false,
  options: normalizeOptions(prefs.get('options', DEFAULTS)),
  filter: '',
  zoom: prefs.get('zoom', 'fit') === 'actual' ? 'actual' : 'fit',
  doc: null,       // { seq, manifest, json, blobs, ready, figures }
  undo: null,      // the last delete while its notice is on screen
  charKeys: prefs.get('charKeys', true) !== false,
};
const timers = { render: 0, save: 0, paste: 0, meta: 0 };
const renderer = new Renderer();
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('textizer') : null;
const imageUrls = new WeakMap(); // img -> object URL it currently shows
let renderSeq = 0;
let openToken = 0;
let wasmReady = false;
let wasmFailed = false;

// ── toasts ───────────────────────────────────────────────────

const GLYPH = { ok: '[+]', warn: '[!]', err: '[-]', info: '[*]', cmd: '$' };
function toast(tone, title, body = '', action = null) {
  let timer = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, action ? 6000 : 3200); };
  const dismiss = () => {
    clearTimeout(timer);
    const hadFocus = node.contains(document.activeElement);
    node.remove();
    action?.onDismiss?.();
    if (hadFocus) (ui.history.querySelector('[aria-current="true"]') ?? ui.search).focus();
  };
  const node = h('div', { class: `ph-toast ph-toast--${tone}` },
    h('span', { class: 'ph-toast__glyph', style: `color:var(--sig-${tone})` }, GLYPH[tone]),
    h('div', { class: 'ph-toast__body' }, h('div', { class: 'ph-toast__title' }, title), body ? h('div', {}, body) : null),
    action ? h('button', { type: 'button', class: 'ph-btn ph-btn--ghost ph-btn--sm', onclick: () => { dismiss(); action.run(); } }, action.label) : null,
    h('button', { type: 'button', class: 'ph-tag__x', 'aria-label': 'dismiss', onclick: dismiss }, '×'));
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', arm);
  node.addEventListener('focusin', () => clearTimeout(timer));
  node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget)) arm(); });
  ui.toasts.append(node);
  while (ui.toasts.childElementCount > 4) ui.toasts.firstElementChild.remove();
  arm();
  return { dismiss };
}

// ── status bar ───────────────────────────────────────────────

function setActivity(tone, label, live = false) {
  ui.stState.className = `ph-status ph-status--${tone}${live ? ' ph-status--live' : ''}`;
  ui.stLabel.textContent = label;
}

function setMode() {
  ui.mode.textContent = document.activeElement === ui.text ? 'INSERT' : 'NORMAL';
}

function showDocStatus(manifest) {
  for (const item of [ui.stFont, ui.stLayout, ui.stBytes, ui.stSha]) item.hidden = !manifest;
  if (!manifest) return;
  ui.stFont.textContent = `${manifest.options.preset} ${manifest.font}`;
  ui.stLayout.textContent = `${manifest.columns} cols · ${plural(manifest.total_rows, 'row')} · ${plural(manifest.pages.length, 'page')}`;
  ui.stBytes.textContent = `${fmtBytes(manifest.input_bytes)} in · ${fmtBytes(manifest.escaped_bytes)} escaped`;
  ui.stSha.textContent = `sha256 ${manifest.source_sha256.slice(0, 12)}`;
  ui.stSha.title = manifest.source_sha256;
}

function showStoreStatus() {
  const memory = state.store?.kind === 'memory';
  ui.stStore.textContent = `${plural(state.entries.length, 'text')} · ${memory ? 'memory only' : 'indexeddb'}`;
  ui.storeKind.textContent = memory ? 'memory only · not kept' : 'stored in this browser';
  ui.storeKind.title = memory ? `indexeddb unavailable: ${state.store.reason}` : '';
  ui.storeKind.parentElement.classList.toggle('sidebar__foot--warn', memory);
}

// ── editor ───────────────────────────────────────────────────

let gutterLines = 0;
function updateEditorMeta() {
  const text = state.text;
  const lines = countLines(text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text);
  ui.inputMeta.textContent = text ? `${plural(text.length, 'char')} · ${plural(lines, 'line')} · ${fmtBytes(utf8Length(text))}` : '0 chars';
  ui.crlf.hidden = !text.includes('\r');
  if (state.files.length) {
    ui.gutter.textContent = 'files'; gutterLines = 0;
  } else if (lines !== gutterLines) {
    gutterLines = lines;
    ui.gutter.textContent = Array.from({ length: Math.min(lines, 10000) }, (_, i) => i + 1).join('\n');
    ui.gutter.parentElement.style.setProperty('--digits', String(Math.max(3, String(lines).length)));
  }
}

function setEditorText(text) {
  state.text = text;
  ui.text.value = state.files.length ? text.slice(0, 262144) : text;
  ui.text.readOnly = state.files.length > 0;
  ui.text.title = state.files.length ? 'Read-only file-set preview; images use the complete accepted files.' : '';
  ui.text.scrollTop = 0;
  ui.text.scrollLeft = 0;
  ui.gutter.scrollTop = 0;
  updateEditorMeta();
}

function fileBody() {
  return { text: state.text, files: state.files.map(f => ({ ...f })), separate: state.separate, pathPrefix: state.pathPrefix };
}

function showFiles() {
  ui.fileSet.hidden = !state.files.length && !state.skippedFiles.length;
  ui.fileCount.textContent = String(state.files.length);
  ui.fileMode.value = state.separate ? 'per_file' : 'combined';
  if (document.activeElement !== ui.pathPrefix) ui.pathPrefix.value = state.pathPrefix;
  ui.fileList.replaceChildren(...state.files.map(file => h('li', {},
    h('span', { class: 'file-path' }, displayPath(file.path, state.pathPrefix)),
    h('span', {}, fmtBytes(file.bytes)),
    h('button', { type: 'button', class: 'ph-btn ph-btn--ghost ph-btn--sm',
      'aria-label': `remove ${file.path}`, onclick: () => {
        state.files = state.files.filter(f => f !== file); refreshFileText();
      } }, 'remove'))));
  ui.skipped.hidden = !state.skippedFiles.length;
  ui.skippedSummary.textContent = `${state.skippedFiles.length} skipped files`;
  ui.skippedList.textContent = state.skippedFiles.map(f => `${f.path}: ${f.reason}`).join('\n');
}

function refreshFileText() {
  try {
    const text = state.files.length ? combinedText(state.files, state.pathPrefix) : '';
    showFiles(); setEditorText(text);
    if (state.current && state.files.length) state.current.name = `${state.files.length} files`;
    markDirty(); renderNow();
  } catch (error) { toast('err', 'invalid file set', message(error)); }
}

function syncOptionsUI() {
  const o = state.options;
  ui.preset.value = o.preset;
  ui.theme.value = o.theme;
  if (document.activeElement !== ui.fontSize) ui.fontSize.value = String(o.font_size);
  ui.fontSize.disabled = o.preset !== 'jetbrains_mono';
  ui.antialias.disabled = o.preset !== 'jetbrains_mono';
  ui.antialias.checked = o.antialias;
  ui.antialiasSwitch.classList.toggle('ph-switch--on', o.antialias && o.preset === 'jetbrains_mono');
  ui.crop.checked = o.crop;
  ui.cropSwitch.classList.toggle('ph-switch--on', o.crop);
  ui.resolution.value = resolutionName(o);
  ui.pageMode.value = o.page_mode;
  ui.grid.value = String(o.grid);
  ui.grid.disabled = o.page_mode === 'full';
  ui.resolutionNote.textContent = o.max_width > 1600 || o.max_height > 1600
    ? 'above the measured GPT-5.6 ceiling; Claude was measured to 1932 px. GPT-6 square limits are unknown.'
    : '1600 px shared working limit from the GPT-5.6 and Claude measurements. GPT-6 square limits are unknown.';
  for (const [input, value] of [[ui.cols, o.max_columns], [ui.width, o.max_width], [ui.height, o.max_height]]) {
    if (document.activeElement !== input) input.value = Number.isFinite(value) ? String(value) : '';
  }
  ui.reflow.checked = o.reflow;
  ui.reflowSwitch.classList.toggle('ph-switch--on', o.reflow);
  const cells = capacity(o);
  ui.capacity.textContent = Number.isFinite(cells.characters)
    ? `max capacity ${fmt(cells.characters)} chars/page (${cells.columns} cols x ${cells.rows} rows)` : '';
  ui.text.style.setProperty('--ruler', String(state.doc?.manifest.columns ?? cells.columns));
  showOptionProblem(optionProblem(o));
}

function showOptionProblem(problem) {
  for (const [field, input] of [['cols', ui.cols], ['width', ui.width], ['height', ui.height], ['grid', ui.grid], ['pageMode', ui.pageMode], ['theme', ui.theme], ['fontSize', ui.fontSize]]) {
    input.classList.toggle('ph-input--invalid', problem?.field === field);
    input.setAttribute('aria-invalid', String(problem?.field === field));
  }
  ui.optError.textContent = problem?.message ?? '';
}

function readOptionsUI() {
  const int = input => (input.value.trim() === '' ? NaN : Number(input.value));
  state.options = {
    preset: ui.preset.value,
    theme: ui.theme.value,
    font_size: int(ui.fontSize),
    antialias: ui.antialias.checked,
    crop: ui.crop.checked,
    max_width: int(ui.width),
    max_height: int(ui.height),
    max_columns: int(ui.cols),
    grid: Number(ui.grid.value),
    page_mode: ui.pageMode.value,
    reflow: ui.reflow.checked,
  };
  ui.reflowSwitch.classList.toggle('ph-switch--on', state.options.reflow);
  if (!optionProblem(state.options)) prefs.set('options', state.options);
}

// ── chrome: toolbar title and badge ──────────────────────────

const entryName = meta => meta.name ?? meta.title;

function renderChrome() {
  const meta = state.current;
  ui.title.textContent = meta ? entryName(meta) : 'new text';
  ui.title.title = ui.title.textContent;
  ui.badge.textContent = meta ? 'stored' : 'draft';
  ui.badge.className = `ph-badge ${meta ? 'ph-badge--ok' : 'ph-badge--neutral'}`;
  ui.badge.hidden = !meta && !state.text;
  document.title = meta ? `${entryName(meta)} · textizer` : 'textizer';
}

// ── sidebar ──────────────────────────────────────────────────

function sortEntries() { state.entries.sort((a, b) => b.updatedAt - a.updatedAt); }

function upsertEntry(meta) {
  if (!state.entries.includes(meta)) state.entries = [meta, ...state.entries.filter(e => e.id !== meta.id)];
  sortEntries();
}

function renderSidebar() {
  const query = state.filter.trim().toLowerCase();
  const list = query
    ? state.entries.filter(e => `${e.name ?? ''}\n${e.title}\n${e.preview}`.toLowerCase().includes(query))
    : state.entries;
  const items = [];
  let group = null;
  for (const meta of list) {
    const label = dayLabel(meta.updatedAt);
    if (label !== group) items.push(h('li', { class: 'hist__group', 'aria-hidden': 'true' }, (group = label)));
    const facts = [plural(meta.chars, 'char'), meta.pages ? plural(meta.pages, 'page') : null].filter(Boolean).join(' · ');
    items.push(h('li', { class: 'hist__row' },
      h('button', {
        type: 'button', class: 'hist__item', dataset: { id: meta.id }, title: meta.preview,
        'aria-current': meta.id === state.current?.id ? 'true' : null,
      },
        h('span', { class: 'hist__title' }, entryName(meta)),
        h('span', { class: 'hist__meta' }, `${facts} · `, h('span', { class: 'hist__ago', dataset: { ts: meta.updatedAt } }, ago(meta.updatedAt)))),
      h('button', {
        type: 'button', class: 'ph-iconbtn ph-iconbtn--ghost ph-iconbtn--sm hist__del', dataset: { del: meta.id },
        'aria-label': `delete ${entryName(meta)}`, title: 'delete',
      }, icon('trash-2'))));
  }
  if (!list.length) items.push(h('li', { class: 'hist__empty' }, query ? 'no text matches that filter' : 'nothing stored yet'));
  const focusedId = ui.history.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  ui.history.replaceChildren(...items);
  if (focusedId) ui.history.querySelector(`.hist__item[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  ui.histCount.textContent = query ? `${list.length}/${state.entries.length}` : String(state.entries.length);
  ui.clearHistory.disabled = !state.entries.length;
  showStoreStatus();
}

function refreshAges() {
  for (const node of ui.history.querySelectorAll('.hist__ago')) node.textContent = ago(Number(node.dataset.ts));
}

function toggleDrawer(open) {
  const focusLost = ui.sidebar.contains(document.activeElement) || document.activeElement === document.body;
  ui.app.classList.toggle('app--drawer', open);
  ui.drawer.setAttribute('aria-expanded', String(open));
  ui.main.inert = open && NARROW.matches;
  if (open) (ui.history.querySelector('[aria-current="true"]') ?? ui.search).focus();
  else if (focusLost && NARROW.matches) ui.drawer.focus();
}

// ── persistence: every write goes through one queue, in order ─

let writes = Promise.resolve();
const broadcast = () => channel?.postMessage('changed');

function queueWrite(task) {
  writes = writes.then(task).then(broadcast, error => toast('err', 'history write failed', message(error)));
  return writes;
}

// Metadata-only update; skipped if the entry left history before the write ran.
const queueMeta = meta => queueWrite(async () => { if (state.entries.includes(meta)) await state.store.put({ ...meta }); });

function markDirty(delay = 500) {
  state.dirty = true;
  clearTimeout(timers.save);
  timers.save = setTimeout(saveNow, delay);
  renderChrome();
}

function saveNow() {
  clearTimeout(timers.save);
  if (!state.dirty) return writes;
  state.dirty = false;
  const text = state.text;
  const body = fileBody();
  const meta = state.current;
  if (!text) {
    // An emptied entry leaves history; the editor stays open as a draft.
    if (meta) {
      state.current = null;
      state.entries = state.entries.filter(e => e !== meta);
      queueWrite(() => state.store.remove(meta.id));
      prefs.set('last', null);
    }
  } else {
    const entry = meta ?? (state.current = { id: makeId(), createdAt: Date.now(), name: null, pages: null, sha256: null });
    Object.assign(entry, describe(text), { options: { ...state.options }, updatedAt: Date.now() });
    upsertEntry(entry);
    prefs.set('last', entry.id);
    queueWrite(async () => {
      entry.sha256 = await sha256(text);
      await state.store.put({ ...entry }, body);
    });
  }
  renderSidebar();
  renderChrome();
  return writes;
}

function recordPages(meta, pages) {
  if (meta.pages === pages) return;
  meta.pages = pages;
  renderSidebar();
  queueMeta(meta);
}

async function reloadEntries() {
  await writes; // own pending writes land before the list is read back
  state.entries = await state.store.list();
  sortEntries();
  // Deleted in another tab: the text stays open as a draft.
  if (state.current) state.current = state.entries.find(e => e.id === state.current.id) ?? null;
  renderSidebar();
  renderChrome();
}

// ── navigation between texts ─────────────────────────────────

async function openEntry(id) {
  const token = ++openToken;
  await saveNow();
  const meta = state.entries.find(e => e.id === id);
  if (!meta || token !== openToken) return;
  let body;
  try { body = await state.store.document(id); }
  catch (error) { toast('err', 'history read failed', message(error)); return; }
  if (token !== openToken) return;
  state.current = meta;
  state.dirty = false;
  state.options = normalizeOptions(meta.options);
  state.files = body.files ?? []; state.separate = body.separate === true; state.pathPrefix = body.pathPrefix ?? ''; state.skippedFiles = [];
  showFiles(); setEditorText(body.text);
  syncOptionsUI();
  renderSidebar();
  renderChrome();
  prefs.set('last', id);
  ui.scroll.scrollTop = 0;
  renderNow();
}

async function newDraft({ focus = true } = {}) {
  ++openToken;
  await saveNow();
  state.current = null;
  state.dirty = false;
  state.files = []; state.skippedFiles = []; state.pathPrefix = ''; state.separate = false;
  showFiles();
  setEditorText('');
  renderSidebar();
  renderChrome();
  prefs.set('last', null);
  renderNow();
  if (focus) ui.text.focus();
}

async function step(delta) {
  const ids = Array.from(ui.history.querySelectorAll('.hist__item'), node => node.dataset.id);
  if (!ids.length) return;
  const at = ids.indexOf(state.current?.id);
  const next = ids[at === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta))];
  const keepFocus = ui.history.contains(document.activeElement);
  await openEntry(next);
  const active = ui.history.querySelector('[aria-current="true"]');
  active?.scrollIntoView({ block: 'nearest' });
  if (keepFocus) active?.focus();
}

async function deleteEntry(id) {
  const meta = state.entries.find(e => e.id === id);
  if (!meta) return;
  const isCurrent = state.current === meta;
  try {
    if (isCurrent) await saveNow();
    const text = isCurrent ? fileBody() : await state.store.document(id);
    state.entries = state.entries.filter(e => e !== meta);
    queueWrite(() => state.store.remove(id));
    if (isCurrent) await newDraft({ focus: false }); else renderSidebar();
    const undo = {
      label: 'undo',
      run: () => {
        upsertEntry(meta);
        renderSidebar();
        queueWrite(() => state.store.put({ ...meta }, text));
      },
      onDismiss: () => { if (state.undo === undo) state.undo = null; },
    };
    state.undo = undo;
    undo.dismiss = toast('info', 'text deleted', `${entryName(meta)}${state.charKeys ? ' · u undoes' : ''}`, undo).dismiss;
  } catch (error) {
    toast('err', 'delete failed', message(error));
  }
}

async function clearHistory() {
  const count = state.entries.length;
  clearTimeout(timers.save);
  state.dirty = false;
  state.current = null;
  state.entries = [];
  await queueWrite(() => state.store.clear());
  await newDraft({ focus: false });
  if (document.activeElement === document.body || ui.clearHistory.disabled) ui.search.focus();
  toast('ok', `${plural(count, 'text')} dropped`);
}

// ── intake: paste, drop, file picker ─────────────────────────

const acceptsText = el => el instanceof Element && (el.isContentEditable || el instanceof HTMLTextAreaElement
  || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type)));
const capturesKeys = el => acceptsText(el) || el instanceof HTMLSelectElement;
// Every intake path ends here: a non-empty text becomes the open entry.
async function ingest(text, { name = null, source = 'clipboard' } = {}) {
  if (!text) { toast('warn', `${source} holds no text`); return; }
  const bytes = utf8Length(text);
  if (bytes > MAX_INPUT_BYTES) { toast('err', `${name ?? 'text'} is ${fmtBytes(bytes)}`, 'the limit is 4 MiB of utf-8'); return; }
  const token = ++openToken;
  await saveNow();
  if (text === state.text && !state.files.length) { toast('info', 'already open'); return; }
  const digest = await sha256(text);
  if (token !== openToken) return;
  const existing = digest && state.entries.find(e => e.sha256 === digest && e.bytes === bytes);
  if (existing) {
    existing.updatedAt = Date.now();
    sortEntries();
    queueMeta(existing);
    await openEntry(existing.id);
    toast('info', 'already stored', 'opened the existing text');
    return;
  }
  state.current = { id: makeId(), createdAt: Date.now(), name, pages: null, sha256: null };
  state.files = []; state.skippedFiles = []; state.pathPrefix = ''; state.separate = false; showFiles();
  setEditorText(text);
  state.dirty = true;
  saveNow();
  prefs.set('last', state.current.id);
  ui.scroll.scrollTop = 0;
  renderNow();
  toast('ok', `${plural(text.length, 'char')} ${source === 'file' ? 'loaded' : 'pasted'}`, name ?? 'new text in history');
}

let intake = Promise.resolve();
function ingestFiles(captured) {
  intake = intake.then(async () => {
    const token = ++openToken;
    setActivity('info', 'reading files', true);
    const result = await collectTextFiles(captured);
    if (token !== openToken) return;
    if (!state.files.length && result.files.length) {
      await saveNow(); state.current = null; state.files = []; state.skippedFiles = [];
      if (token !== openToken) return;
    }
    let total = state.files.reduce((n,f) => n + f.bytes, 0);
    for (const file of result.files) {
      if (state.files.some(f => f.path === file.path)) result.skipped.push({ path: file.path, reason: 'already in set' });
      else if (state.files.length >= MAX_FILES || total + file.bytes > MAX_SET_BYTES)
        result.skipped.push({ path: file.path, reason: 'file-set limit reached' });
      else { state.files.push(file); total += file.bytes; }
    }
    state.skippedFiles.push(...result.skipped);
    state.files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (state.files.length) {
      state.current ??= { id: makeId(), createdAt: Date.now(), name: `${state.files.length} files`, pages: null, sha256: null };
      refreshFileText(); await saveNow();
    }
    else { showFiles(); setActivity('ok', 'ready'); }
    if (!state.files.length && captured.hadFiles && !result.files.length) {
      toast('warn', 'no readable text files received', 'If this was a Finder folder, use open folder to grant access.',
        { label: 'open folder', run: () => ui.folder.click() });
    } else toast('ok', `${result.files.length} text files read`, `${result.skipped.length} skipped`);
  }).catch(error => { toast('err', 'file intake failed', message(error)); setActivity('err','file intake failed'); });
  return intake;
}

async function pasteFromClipboardApi() {
  if (!navigator.clipboard?.readText) { toast('warn', 'clipboard read unsupported', `use ${PASTE_KEYS} outside the editor`); return; }
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (error) { toast('err', 'clipboard read blocked', `${message(error)} · ${PASTE_KEYS} outside the editor still works`); return; }
  if (text.startsWith('file://')) {
    toast('warn','folder permission needed','Use open folder to grant access to the referenced folder.',
      { label: 'open folder', run: () => ui.folder.click() }); return;
  }
  await ingest(text);
}

document.addEventListener('paste', event => {
  clearTimeout(timers.paste);
  if (document.querySelector('dialog[open]')) return;
  const data = event.clipboardData;
  if (!data) return;
  const captured = captureTransfer(data);
  // Text fields paste ordinary text normally, but a file/folder paste is intake.
  if (acceptsText(event.target) && !event.target.readOnly && !captured.hadFiles) return;
  event.preventDefault();
  const text = data.getData('text/plain');
  const files = Array.from(data.files); // must be read before the event returns
  (async () => {
    if (captured.hadFiles) return ingestFiles(captured);
    if (text.startsWith('file://') || data.getData('text/uri-list').startsWith('file://')) {
      toast('warn','folder permission needed','The clipboard contains a local path, not readable file contents.',
        { label: 'open folder', run: () => ui.folder.click() }); return;
    }
    if (text) return ingest(text);
    if (files.some(f => f.type.startsWith('image/'))) return toast('warn', 'clipboard holds an image', 'textizer packs text; copy text instead');
    return toast('warn', 'clipboard holds no text');
  })().catch(error => toast('err', message(error)));
});

let internalDrag = false;
let dragDepth = 0;
const droppable = dt => !internalDrag && dt && Array.from(dt.types).some(t => t === 'Files' || t === 'text/plain');
document.addEventListener('dragstart', () => { internalDrag = true; });
document.addEventListener('dragend', () => { internalDrag = false; });
window.addEventListener('dragenter', event => {
  if (!droppable(event.dataTransfer)) return;
  event.preventDefault();
  dragDepth++;
  ui.dropzone.hidden = false;
});
window.addEventListener('dragover', event => {
  if (!droppable(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) ui.dropzone.hidden = true;
});
window.addEventListener('drop', event => {
  const dt = event.dataTransfer;
  dragDepth = 0;
  ui.dropzone.hidden = true;
  if (!droppable(dt)) return;
  event.preventDefault();
  const captured = captureTransfer(dt);
  if (captured.hadFiles) ingestFiles(captured);
  else ingest(dt.getData('text/plain'), { source: 'drop' });
});

// ── rendering ────────────────────────────────────────────────

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) loadPage(Number(entry.target.dataset.index));
}, { root: ui.scroll, rootMargin: '1200px 0px' });

function scheduleRender() {
  clearTimeout(timers.render);
  timers.render = setTimeout(renderNow, state.text.length > LARGE_TEXT ? 600 : 160);
}

function terminal(lines, prompt = false) {
  return h('div', { class: 'ph-term' },
    lines.map(line => h('div', { class: `ph-term__line${line.tone === 'cmd' ? '' : ` ph-term__line--${line.tone}`}` },
      h('span', { class: 'ph-term__glyph' }, `${GLYPH[line.tone]} `), line.text)),
    prompt ? h('div', { class: 'ph-term__line' }, h('span', { class: 'ph-term__glyph' }, '$ '), h('span', { class: 'ph-term__cursor' })) : null);
}

function wasmFailureLines(error) {
  return [
    { tone: 'err', text: `webassembly did not load: ${message(error)}` },
    { tone: 'info', text: 'build the package, then serve the repository root over http' },
    { tone: 'cmd', text: 'sh scripts/build_wasm.sh' },
    { tone: 'cmd', text: 'python3 -m http.server 8000   # then open http://localhost:8000/web/' },
  ];
}

function setImageUrl(img, url) {
  const old = imageUrls.get(img);
  if (url) { img.src = url; imageUrls.set(img, url); } else { img.removeAttribute('src'); imageUrls.delete(img); }
  // The decoded old image stays on screen until the new one replaces it.
  if (old) URL.revokeObjectURL(old);
}

function dropFigure(figure) {
  observer.unobserve(figure);
  setImageUrl(figure.querySelector('img'), null);
}

function showMessage(lines, prompt = false) {
  for (const figure of state.doc?.figures ?? []) dropFigure(figure);
  state.doc = null;
  ui.pages.replaceChildren(terminal(lines, prompt));
  ui.pagesCount.textContent = '0';
  ui.pagesMeta.textContent = '';
  ui.zip.disabled = true;
  showDocStatus(null);
  syncOptionsUI();
}

function showEmpty() {
  showMessage([
    { tone: 'cmd', text: 'textizer --help' },
    { tone: 'info', text: `${PASTE_KEYS} anywhere outside the editor packs the clipboard as a new text` },
    { tone: 'info', text: 'drop files or folders on the window, or type in the editor above' },
    { tone: 'info', text: 'pages render locally in webassembly; texts stay in this browser' },
  ], true);
}

async function renderNow() {
  clearTimeout(timers.render);
  const seq = ++renderSeq;
  const text = state.text;
  const options = { ...state.options };
  const entry = state.current;
  const problem = optionProblem(options);
  showOptionProblem(problem);
  if (wasmFailed) return;
  if (problem) { showMessage([{ tone: 'err', text: problem.message }]); setActivity('err', 'invalid options'); return; }
  if (!text) { showEmpty(); setActivity(wasmReady ? 'ok' : 'idle', wasmReady ? 'ready' : 'loading wasm'); return; }
  setActivity('info', 'layout', true);
  try {
    const { manifest, json } = await renderer.layout(seq, text, options, state.files, state.separate, state.pathPrefix);
    if (seq !== renderSeq) return;
    showDoc({ seq, manifest, json });
    setActivity('ok', 'ready');
    if (entry && entry === state.current && text === state.text) recordPages(entry, manifest.pages.length);
  } catch (error) {
    if (seq !== renderSeq || error instanceof Superseded) return;
    if (!(await renderer.ready.then(() => true, () => false))) {
      wasmFailed = true;
      showMessage(wasmFailureLines(error));
      setActivity('err', 'wasm missing');
      return;
    }
    showMessage([{ tone: 'err', text: message(error) }]);
    setActivity('err', 'error');
  }
}

function showDoc({ seq, manifest, json }) {
  ui.pages.dataset.antialias = String(manifest.pixel_format.startsWith('8-bit'));
  // Figures are reused so pages keep their old pixels until the new PNG arrives: no flash while typing.
  const reusable = state.doc?.figures ?? [];
  for (const figure of reusable) observer.unobserve(figure);
  for (const figure of reusable.slice(manifest.pages.length)) dropFigure(figure);
  const doc = { seq, manifest, json, blobs: [], ready: [], figures: [] };
  state.doc = doc;
  doc.figures = manifest.pages.map((page, i) => pageFigure(doc, page, reusable[i]));
  ui.pages.replaceChildren(...doc.figures);
  for (const figure of doc.figures) observer.observe(figure);

  const sum = key => manifest.pages.reduce((total, page) => total + page[key], 0);
  ui.pagesCount.textContent = fmt(manifest.pages.length);
  ui.pagesMeta.textContent = `${manifest.font} · ${manifest.columns} cols · ${plural(manifest.total_rows, 'row')} · ${fmt(sum('patches_32'))} patches/32 · ${fmt(sum('patches_28'))}/28`;
  ui.zip.disabled = false;
  showDocStatus(manifest);
  syncOptionsUI();
}

function pageFigure(doc, page, reuse) {
  const figure = reuse ?? h('figure', { class: 'page' },
    h('figcaption', { class: 'page__head' },
      h('span', { class: 'page__name' }),
      h('span', { class: 'page__meta' }),
      h('span', { class: 'page__actions' },
        h('button', { type: 'button', class: 'ph-iconbtn ph-iconbtn--ghost ph-iconbtn--sm', dataset: { act: 'copy' }, title: 'copy png (y)' }, icon('copy')),
        h('button', { type: 'button', class: 'ph-iconbtn ph-iconbtn--ghost ph-iconbtn--sm', dataset: { act: 'download' }, title: 'download png' }, icon('download')))),
    h('div', { class: 'page__frame' }, h('img', { class: 'page__img', decoding: 'async' })));
  figure.dataset.index = String(page.index);
  delete figure.dataset.state;
  figure.querySelector('.page__err')?.remove();
  figure.querySelector('.page__name').textContent = page.file_path ? `${page.file_path} · ${page.filename}` : page.filename;
  figure.querySelector('.page__name').title = page.file_path ?? page.filename;
  figure.querySelector('.page__meta').textContent = `${page.width} × ${page.height} · ${plural(page.row_count, 'row')} · capacity ${fmt(page.capacity_characters)} chars`;
  figure.querySelector('[data-act="copy"]').setAttribute('aria-label', `copy ${page.filename} as png`);
  figure.querySelector('[data-act="download"]').setAttribute('aria-label', `download ${page.filename}`);
  const img = figure.querySelector('img');
  img.alt = `page ${page.index + 1} of ${doc.manifest.pages.length}: ${plural(page.row_count, 'row')} of packed text`;
  if (!imageUrls.has(img)) sizeImage(img, page);
  return figure;
}

function sizeImage(img, page) {
  img.width = page.width;
  img.height = page.height;
  img.style.width = `${page.width}px`;
  img.style.aspectRatio = `${page.width} / ${page.height}`;
}

function pageBlob(doc, index) {
  if (!doc.blobs[index]) {
    const promise = renderer.page(doc.seq, index).then(bytes => (doc.ready[index] = new Blob([bytes], { type: 'image/png' })));
    promise.catch(() => { if (doc.blobs[index] === promise) doc.blobs[index] = null; });
    doc.blobs[index] = promise;
  }
  return doc.blobs[index];
}

async function loadPage(index) {
  const doc = state.doc;
  const figure = doc?.figures[index];
  if (!figure || figure.dataset.state) return;
  figure.dataset.state = 'loading';
  try {
    const blob = await pageBlob(doc, index);
    if (doc !== state.doc) return;
    const page = doc.manifest.pages[index];
    const img = figure.querySelector('img');
    sizeImage(img, page);
    setImageUrl(img, URL.createObjectURL(blob));
    figure.querySelector('.page__meta').textContent = `${page.width} × ${page.height} · ${plural(page.row_count, 'row')} · capacity ${fmt(page.capacity_characters)} chars · ${fmtBytes(blob.size)}`;
    figure.dataset.state = 'ready';
    observer.unobserve(figure);
  } catch (error) {
    if (doc !== state.doc || error instanceof Superseded) return;
    figure.dataset.state = 'error';
    figure.querySelector('.page__err')?.remove();
    figure.append(h('div', { class: 'page__err' }, terminal([{ tone: 'err', text: `${doc.manifest.pages[index].filename}: ${message(error)}` }])));
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function copyPage(index) {
  const doc = state.doc;
  if (!doc) return;
  const { filename } = doc.manifest.pages[index];
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast('warn', 'image copy unsupported here', 'download the png instead');
    return;
  }
  try {
    // Handing over the pending promise keeps the user activation where it is required (Safari).
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': doc.ready[index] ?? pageBlob(doc, index) })]);
    toast('ok', `${filename} copied`, 'png on the clipboard');
  } catch (error) {
    toast('err', `${filename} copy failed`, message(error));
  }
}

async function downloadPage(index) {
  const doc = state.doc;
  if (!doc) return;
  try { saveBlob(await pageBlob(doc, index), doc.manifest.pages[index].filename); }
  catch (error) { if (!(error instanceof Superseded)) toast('err', 'download failed', message(error)); }
}

// Same files as the CLI: every page, rows.json and manifest.json.
let zipping = false;
async function downloadZip() {
  const doc = state.doc;
  if (!doc || zipping) return;
  zipping = true;
  const total = doc.manifest.pages.length;
  const encoder = new TextEncoder();
  try {
    const files = [];
    for (let i = 0; i < total; i++) {
      setActivity('info', `zip ${i + 1}/${total}`, true);
      const blob = await pageBlob(doc, i);
      if (doc !== state.doc) return;
      files.push({ name: doc.manifest.pages[i].filename, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const rows = await renderer.rows(doc.seq);
    files.push({ name: 'rows.json', bytes: encoder.encode(rows) }, { name: 'manifest.json', bytes: encoder.encode(doc.json) });
    const archive = zip(files);
    saveBlob(archive, `textizer-${doc.manifest.source_sha256.slice(0, 12)}.zip`);
    toast('ok', `${plural(total, 'page')} zipped`, `${fmtBytes(archive.size)} · with rows.json and manifest.json`);
  } catch (error) {
    if (!(error instanceof Superseded)) toast('err', 'zip failed', message(error));
  } finally {
    zipping = false;
    if (doc === state.doc) setActivity('ok', 'ready');
  }
}

function pageInView() {
  const top = ui.scroll.getBoundingClientRect().top + 48;
  return state.doc?.figures.findIndex(figure => figure.getBoundingClientRect().bottom > top) ?? -1;
}

function setZoom(zoom) {
  state.zoom = zoom;
  ui.pages.dataset.zoom = zoom;
  for (const button of document.querySelectorAll('[data-zoom]')) button.setAttribute('aria-pressed', String(button.dataset.zoom === zoom));
  prefs.set('zoom', zoom);
}

// ── wiring ───────────────────────────────────────────────────

ui.text.addEventListener('input', () => {
  state.text = ui.text.value;
  clearTimeout(timers.meta);
  timers.meta = setTimeout(updateEditorMeta, state.text.length > LARGE_TEXT ? 200 : 0);
  markDirty();
  scheduleRender();
});
ui.text.addEventListener('scroll', () => { ui.gutter.scrollTop = ui.text.scrollTop; });
ui.text.addEventListener('focus', setMode);
ui.text.addEventListener('blur', setMode);
ui.text.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); ui.text.blur(); }
});

for (const input of [ui.preset, ui.grid, ui.cols, ui.width, ui.height, ui.reflow, ui.pageMode, ui.theme, ui.crop, ui.fontSize, ui.antialias]) {
  input.addEventListener(input.type === 'number' ? 'input' : 'change', () => {
    if (input === ui.pageMode && input.value === 'full') ui.cols.value = '0';
    readOptionsUI();
    syncOptionsUI();
    markDirty();
    scheduleRender();
  });
}
ui.resolution.addEventListener('change', () => {
  const profile = RESOLUTIONS[ui.resolution.value];
  if (!profile) return;
  state.options = { ...state.options, ...profile };
  prefs.set('options', state.options);
  syncOptionsUI();
  markDirty();
  renderNow();
});
ui.optReset.addEventListener('click', () => {
  state.options = { ...DEFAULTS };
  prefs.set('options', state.options);
  syncOptionsUI();
  markDirty();
  renderNow();
});

ui.newText.addEventListener('click', () => newDraft());
ui.newBar.addEventListener('click', () => newDraft());
ui.paste.addEventListener('click', pasteFromClipboardApi);
ui.open.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => { const captured = captureFiles(ui.file.files); ui.file.value = ''; ingestFiles(captured); });
ui.openFolder.addEventListener('click', () => ui.folder.click());
ui.folder.addEventListener('change', () => { const captured = captureFiles(ui.folder.files); ui.folder.value = ''; ingestFiles(captured); });
ui.fileMode.addEventListener('change', () => { state.separate = ui.fileMode.value === 'per_file'; refreshFileText(); });
ui.pathPrefix.addEventListener('input', () => { state.pathPrefix = ui.pathPrefix.value; refreshFileText(); });
ui.clearFiles.addEventListener('click', () => { state.files = []; state.skippedFiles = []; refreshFileText(); });
ui.drawer.addEventListener('click', () => toggleDrawer(!ui.app.classList.contains('app--drawer')));
ui.scrim.addEventListener('click', () => toggleDrawer(false));
NARROW.addEventListener('change', () => toggleDrawer(false));

ui.search.addEventListener('input', () => { state.filter = ui.search.value; renderSidebar(); });
ui.search.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (ui.search.value) { ui.search.value = ''; state.filter = ''; renderSidebar(); }
    else { ui.search.blur(); toggleDrawer(false); }
  } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
    event.preventDefault();
    ui.history.querySelector('.hist__item')?.focus();
  }
});

ui.history.addEventListener('click', event => {
  const del = event.target.closest('[data-del]');
  if (del) { deleteWithFocus(del.dataset.del); return; }
  const item = event.target.closest('.hist__item');
  if (!item) return;
  if (NARROW.matches) toggleDrawer(false);
  openEntry(item.dataset.id);
});
ui.history.addEventListener('keydown', event => {
  if (!event.target.classList.contains('hist__item')) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const items = Array.from(ui.history.querySelectorAll('.hist__item'));
    items[items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteWithFocus(event.target.dataset.id);
  }
});

function deleteWithFocus(id) {
  const ids = Array.from(ui.history.querySelectorAll('.hist__item'), node => node.dataset.id);
  const at = ids.indexOf(id);
  const neighbour = ids[at + 1] ?? ids[at - 1];
  deleteEntry(id).then(() => {
    (ui.history.querySelector(`.hist__item[data-id="${CSS.escape(neighbour ?? '')}"]`) ?? ui.search).focus();
  });
}

ui.pages.addEventListener('click', event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const index = Number(button.closest('.page').dataset.index);
  if (button.dataset.act === 'copy') copyPage(index); else downloadPage(index);
});
for (const button of document.querySelectorAll('[data-zoom]')) button.addEventListener('click', () => setZoom(button.dataset.zoom));
ui.zip.addEventListener('click', downloadZip);

ui.clearHistory.addEventListener('click', () => {
  ui.clearLabel.textContent = `drop ${plural(state.entries.length, 'text')}`;
  ui.clearDialog.returnValue = '';
  ui.clearDialog.showModal();
});
ui.clearDialog.addEventListener('close', () => { if (ui.clearDialog.returnValue === 'confirm') clearHistory(); });
ui.charKeys.addEventListener('change', () => {
  state.charKeys = ui.charKeys.checked;
  ui.charKeysSwitch.classList.toggle('ph-switch--on', state.charKeys);
  prefs.set('charKeys', state.charKeys);
});

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target;
  if (event.key === 'Escape' && ui.app.classList.contains('app--drawer') && !document.querySelector('dialog[open]')) { toggleDrawer(false); return; }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v' && !acceptsText(target)) {
    // A paste event normally follows within the same task and cancels this fallback.
    clearTimeout(timers.paste);
    if (WEBKIT_ONLY) timers.paste = setTimeout(pasteFromClipboardApi, 120);
    return;
  }
  if (mod || event.altKey || capturesKeys(target) || document.querySelector('dialog[open]')) return;
  if (!state.charKeys && event.key !== '?') return;
  switch (event.key) {
    case 'i': ui.text.focus(); break;
    case 'n': newDraft(); break;
    case '/': if (NARROW.matches) toggleDrawer(true); ui.search.focus(); break;
    case 'j': step(1); break;
    case 'k': step(-1); break;
    case 'y': { const index = pageInView(); if (index >= 0) copyPage(index); break; }
    case 'z': setZoom(state.zoom === 'fit' ? 'actual' : 'fit'); break;
    case 'u': { const undo = state.undo; if (!undo) return; undo.dismiss(); undo.run(); break; }
    case '?': ui.keysDialog.showModal(); break;
    default: return;
  }
  event.preventDefault();
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', () => { saveNow(); });
if (channel) channel.onmessage = () => { reloadEntries().catch(() => {}); };
setInterval(refreshAges, 60000);

// ── boot ─────────────────────────────────────────────────────

async function boot() {
  for (const node of document.querySelectorAll('.mod-key')) node.textContent = MAC ? '⌘' : 'ctrl';
  ui.paste.title = `new text from the clipboard (${PASTE_KEYS} outside the editor)`;
  ui.text.placeholder = `type or paste text\n\n${PASTE_KEYS} outside the editor starts a new text · esc leaves the editor · ? lists keys`;
  setZoom(state.zoom);
  ui.charKeys.checked = state.charKeys;
  ui.charKeysSwitch.classList.toggle('ph-switch--on', state.charKeys);
  syncOptionsUI();
  updateEditorMeta();
  setMode();
  renderer.ready.then(
    () => {
      wasmReady = true;
      if (ui.stLabel.textContent === 'loading wasm') setActivity('ok', 'ready');
    },
    error => {
      wasmFailed = true;
      showMessage(wasmFailureLines(error));
      setActivity('err', 'wasm missing');
    });

  state.store = await openStore();
  if (state.store.kind === 'memory') toast('warn', 'history is memory only', `indexeddb unavailable: ${state.store.reason}`);
  try { state.entries = await state.store.list(); }
  catch (error) { toast('err', 'history read failed', message(error)); }
  sortEntries();
  renderSidebar();
  renderChrome();
  const last = prefs.get('last', null);
  if (last && state.entries.some(e => e.id === last)) await openEntry(last);
  else renderNow();
}

boot();

// Layout choices tied to the measured historical ceilings in vision-text-tests.
// GPT-6 square ceilings were not measured; "shared" is a compatibility default.
export const DEFAULTS = Object.freeze({
  preset: 'jetbrains_mono', theme: 'dark', crop: true, max_width: 1600, max_height: 1600,
  font_size: 13, antialias: true,
  max_columns: 0, grid: 32, page_mode: 'full', reflow: false,
});
export const FONTS = Object.freeze({ jetbrains_mono: 'JetBrains Mono', safe: '8x16', data: '6x13', prose: 'clR5x10', large: '9x18' });
export const CELLS = Object.freeze({ jetbrains_mono: [8, 18], safe: [8, 16], data: [6, 13], prose: [5, 10], large: [9, 18] });
export const JETBRAINS_CELLS = Object.freeze({ 8: [5,12], 9: [6,13], 10: [6,14], 11: [7,16], 12: [8,17], 13: [8,18], 14: [9,20], 15: [9,21], 16: [10,22] });
export function capacity(options) {
  const [width, height] = options.preset === 'jetbrains_mono' ? JETBRAINS_CELLS[options.font_size] ?? [NaN, NaN] : CELLS[options.preset];
  const columns = Math.min(Math.floor(options.max_width / width), options.max_columns || Infinity);
  const rows = Math.floor(options.max_height / height);
  return { columns, rows, characters: columns * rows };
}
export const RESOLUTIONS = Object.freeze({
  shared: Object.freeze({ max_width: 1600, max_height: 1600, grid: 32 }),
  claude: Object.freeze({ max_width: 1932, max_height: 1932, grid: 28 }),
});

export function resolutionName(options) {
  return Object.keys(RESOLUTIONS).find(name =>
    Object.entries(RESOLUTIONS[name]).every(([key, value]) => options[key] === value)) ?? 'custom';
}

// Preserve the old compact behavior when opening previously saved settings.
export function normalizeOptions(source) {
  const options = { ...DEFAULTS };
  if (source && typeof source === 'object') {
    if (Object.hasOwn(FONTS, source.preset)) options.preset = source.preset;
    for (const key of ['max_width', 'max_height', 'max_columns', 'grid', 'font_size']) {
      if (Number.isInteger(source[key])) options[key] = source[key];
    }
    options.page_mode = source.page_mode === 'full' ? 'full' : 'compact';
    options.theme = source.theme === 'dark' ? 'dark' : 'light';
    options.crop = source.crop !== false;
    options.antialias = source.antialias !== false;
    options.reflow = source.reflow === true;
  }
  return options;
}

export function optionProblem(o) {
  if (!(Number.isInteger(o.font_size) && o.font_size >= 8 && o.font_size <= 16)) return { field: 'fontSize', message: 'font size must be between 8 and 16 px' };
  if (!['dark', 'light'].includes(o.theme)) return { field: 'theme', message: 'image theme must be dark or light' };
  if (!['compact', 'full'].includes(o.page_mode)) return { field: 'pageMode', message: 'page mode must be compact or full' };
  if (![28, 32, 224].includes(o.grid)) return { field: 'grid', message: 'grid must be 28, 32 or 224' };
  if (!(Number.isInteger(o.max_columns) && (o.max_columns === 0 || (o.max_columns >= 12 && o.max_columns <= 512))))
    return { field: 'cols', message: 'cols must be 0 (auto) or between 12 and 512' };
  if (!(Number.isInteger(o.max_width) && o.max_width >= o.grid && o.max_width <= 1932))
    return { field: 'width', message: `max w must be between ${o.grid} and 1932` };
  if (!(Number.isInteger(o.max_height) && o.max_height >= o.grid && o.max_height <= 1932))
    return { field: 'height', message: `max h must be between ${o.grid} and 1932` };
  return null;
}

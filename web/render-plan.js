// Plan documents sequentially; retain one native document for lazy page rendering.
export function createPlan(PackedText, inputs, options) {
  const pages = []; let first = null, totalRows = 0, inputBytes = 0, escapedBytes = 0;
  for (const [sourceIndex, input] of inputs.entries()) {
    const doc = new PackedText(input.text, JSON.stringify(options));
    try {
      const manifest = JSON.parse(doc.manifestJson());
      first ??= manifest;
      for (const page of manifest.pages) {
        if (pages.length >= 4096) throw Error('set exceeds 4096 pages');
        pages.push({ ...page, index: pages.length, first_row: totalRows + page.first_row,
          filename: `page${String(pages.length + 1).padStart(4,'0')}.png`,
          source_index: sourceIndex, source_page_index: page.index, file_path: input.path });
      }
      totalRows += manifest.total_rows; inputBytes += manifest.input_bytes; escapedBytes += manifest.escaped_bytes;
    } finally { doc.free(); }
  }
  return { ...first, pages, total_rows: totalRows, input_bytes: inputBytes, escaped_bytes: escapedBytes,
    sources: inputs.map(({ path, fileIndex }) => ({ path, file_index: fileIndex })) };
}

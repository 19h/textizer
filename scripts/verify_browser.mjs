// BROWSER=/path/to/chrome node scripts/verify_browser.mjs
// Node >= 22; isolated headless profile, local static server, no npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.env.BROWSER, 'Set BROWSER to the Chromium/Chrome executable');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer((request, response) => {
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) throw Error('invalid path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript',
      '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)]
      ?? 'application/octet-stream');
    response.end(readFileSync(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'textizer-browser-'));
const browser = spawn(process.env.BROWSER, ['--headless=new', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '';
browser.stderr.on('data', chunk => { logs += chunk; });
let socket;
try {
  for (let i = 0; i < 200 && !logs.includes('DevTools listening on '); i++) await delay(50);
  const endpoint = logs.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
  assert.ok(endpoint, `Browser did not start: ${logs}`);
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let counter = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 200; i++) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(50);
    }
    const context = await evaluate(`({status:document.querySelector('#st-state-label')?.textContent,
      files:document.querySelector('#file-count')?.textContent,
      input:document.querySelector('#text')?.value.slice(0,300),
      notices:document.querySelector('#toasts')?.textContent})`);
    throw Error(`Browser timed out: ${expression}\n${JSON.stringify(context)}`);
  };
  await page('Page.navigate', { url: base + '/tests/browser.html' });
  const report = await waitFor("document.body?.textContent.startsWith('PASS:') && document.body.textContent");
  console.log(report);
  await page('Page.navigate', { url: base + '/examples/index.html' });
  await waitFor("document.querySelector('#render')?.disabled === false");
  await evaluate("document.querySelector('#text').value = 'Browser UI test\\n'.repeat(300); document.querySelector('#render').click(); true");
  await waitFor("document.querySelector('#render')?.disabled === false && document.querySelectorAll('#pages img').length > 0");
  await waitFor("[...document.querySelectorAll('#pages img')].every(img => img.complete && img.naturalWidth > 0)");
  console.log('PASS: example UI renders downloadable PNG pages');

  const renderedPages = "document.querySelectorAll('#pages img[src]').length > 0 && "
    + "[...document.querySelectorAll('#pages img[src]')].every(img => img.complete && img.naturalWidth > 0)";
  const entries = "document.querySelectorAll('#history .hist__item').length";
  await page('Page.navigate', { url: base + '/web/index.html' });
  await waitFor("document.querySelector('#st-state-label')?.textContent === 'ready'");
  assert.deepEqual(await evaluate(`['opt-resolution','opt-page-mode','opt-cols','opt-width','opt-height']
    .map(id => document.getElementById(id).value)`), ['shared', 'full', '0', '1600', '1600']);
  assert.deepEqual(await evaluate("['opt-preset','opt-theme'].map(id => document.getElementById(id).value)"), ['jetbrains_mono', 'dark']);
  assert.ok(await evaluate("document.querySelector('#capacity').textContent.includes('17,600')"));
  assert.equal(await evaluate("document.querySelector('#opt-crop').checked"),true);
  await evaluate("document.querySelector('#opt-crop').click(); true");
  await evaluate(`(() => { const t = document.querySelector('#text');
    t.value = 'Web UI test\\n'.repeat(300); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(renderedPages);
  await waitFor(`${entries} === 1`);
  await waitFor("document.querySelector('#pages img[src]')?.naturalWidth === 1600 && document.querySelector('#pages img[src]')?.naturalHeight === 1600");
  const corner = () => evaluate(`(() => { const c = document.createElement('canvas'); c.width = c.height = 1;
    const ctx = c.getContext('2d'); const img = document.querySelector('#pages img[src]');
    ctx.drawImage(img, img.naturalWidth - 1, img.naturalHeight - 1, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data]; })()`);
  assert.deepEqual(await corner(), [0, 0, 0, 255]);
  await evaluate(`(() => { const t = document.querySelector('#opt-theme'); t.value = 'light';
    t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(`(() => { const c = document.createElement('canvas'); c.width=c.height=1; const ctx=c.getContext('2d');
    const i=document.querySelector('#pages img[src]'); ctx.drawImage(i,i.naturalWidth-1,i.naturalHeight-1,1,1,0,0,1,1);
    return ctx.getImageData(0,0,1,1).data[0]===255; })()`);
  console.log('PASS: JetBrains default, capacity and actual dark/light PNG pixels');
  await evaluate(`(() => { const t = document.querySelector('#text');
    t.value = 'x'.repeat(20001); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#pages-count').textContent === '2' && document.querySelector('#st-layout').textContent.startsWith('200 cols')");
  await evaluate(`(() => { const r = document.querySelector('#opt-resolution');
    r.value = 'claude'; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#pages-count').textContent === '1' && document.querySelector('#pages img[src]')?.naturalWidth === 1932 && document.querySelector('#pages img[src]')?.naturalHeight === 1932");
  assert.equal(await evaluate("document.querySelector('#opt-grid').value"), '28');
  // Options persist with their history entry; loading it must restore the profile.
  await delay(700);
  await page('Page.reload');
  await waitFor("document.querySelector('#opt-resolution')?.value === 'claude' && document.querySelector('#pages img[src]')?.naturalWidth === 1932");
  await evaluate(`(() => { const m = document.querySelector('#opt-page-mode');
    m.value = 'compact'; m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#pages img[src]')?.naturalHeight < 1932 && document.querySelector('#opt-grid').disabled === false");
  await evaluate("document.querySelector('#opt-reset').click(); document.querySelector('#opt-crop').click(); true");
  await waitFor("document.querySelector('#opt-resolution').value === 'shared' && document.querySelector('#pages img[src]')?.naturalHeight === 1600");
  console.log('PASS: web full-size 1600/1932 profiles, pagination, persistence and compact mode');
  if (process.env.SCREENSHOT) {
    const { data } = await page('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.SCREENSHOT, Buffer.from(data, 'base64'));
  }
  // A paste outside the editor becomes a new stored text.
  const pasted = 'pasted outside the editor\t\u03b1\n';
  await evaluate(`(() => { document.activeElement.blur(); const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(pasted)});
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return true; })()`);
  await waitFor(`document.querySelector('#text').value === ${JSON.stringify(pasted)} && ${entries} === 2`);
  await waitFor(renderedPages);
  // History survives a reload and reopens the last text; the delay lets queued IndexedDB writes commit.
  await delay(700);
  await page('Page.reload');
  await waitFor(`${entries} === 2 && document.querySelector('#text').value === ${JSON.stringify(pasted)}`);
  await waitFor(renderedPages);
  console.log('PASS: web UI renders pages, captures paste and restores history');
  await evaluate(`(() => { const crop=document.querySelector('#opt-crop');
    if (!crop.checked) crop.click();
    const t=document.querySelector('#text'); t.value='abc\\nx\\n\\n';
    t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await waitFor("document.querySelector('#pages img[src]')?.naturalWidth === 24 && document.querySelector('#pages img[src]')?.naturalHeight === 36");
  console.log('PASS: cropped PNG removes trailing blank rows and columns');
  await evaluate(`(() => { const s=document.querySelector('#opt-font-size'); s.value='8';
    s.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await waitFor("document.querySelector('#pages img[src]')?.naturalWidth === 15 && document.querySelector('#pages img[src]')?.naturalHeight === 24");
  assert.ok(await evaluate("document.querySelector('#capacity').textContent.includes('42,560')"));
  const hasGray = () => evaluate(`(() => { const img=document.querySelector('#pages img[src]');
    const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    return [...ctx.getImageData(0,0,c.width,c.height).data].some((v,i)=>i%4!==3 && v>0 && v<255); })()`);
  assert.equal(await hasGray(),true);
  await evaluate("document.querySelector('#opt-antialias').click(); true");
  await waitFor(`(() => { const img=document.querySelector('#pages img[src]'); const c=document.createElement('canvas');
    c.width=img.naturalWidth; c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
    return [...ctx.getImageData(0,0,c.width,c.height).data].every((v,i)=>i%4===3 || v===0 || v===255); })()`);
  console.log('PASS: 8 px font, updated capacity, antialiasing and crisp pixels');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await waitFor('innerWidth === 390');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'mobile layout overflows');
  console.log('PASS: web controls fit a 390 px viewport');
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('#new').click(); true");
  await waitFor("document.querySelector('#text').value === ''");
  await evaluate(`(() => {
    const dt = new DataTransfer();
    const item = dt.items.add(new File([], 'project', {type:'application/x-directory'}));
    const leaf=(name,text)=>({name,isFile:true,file(ok){ok(new File([text],name));}});
    const nested={name:'src',isDirectory:true,createReader(){let done=false;return {readEntries(ok){ok(done?[]:[leaf('b.rs','let   b=2;\\n\\nlet c=3;')]);done=true;}};}};
    const root={name:'project',isDirectory:true,createReader(){let batch=0;return {readEntries(ok){ok(batch++===0?[leaf('a.txt','alpha'),nested]:batch===2?[leaf('bad.bin',new Uint8Array([0,1,2]))]:[]);}};}};
    const original=DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry=()=>root;
    document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    DataTransferItem.prototype.webkitGetAsEntry=original;
    return true;
  })()`);
  await waitFor("document.querySelector('#file-count').textContent === '2' && document.querySelector('#text').value.includes('# project/src/b.rs')");
  await waitFor("document.querySelector('#skipped-summary').textContent === '1 skipped files'");
  await waitFor("document.querySelector('#pages-count').textContent === '1'");
  assert.equal(await evaluate("document.querySelector('#opt-reflow').disabled"),false);
  await evaluate("document.querySelector('#opt-reflow').click();true");
  await evaluate(`(() => {const p=document.querySelector('#path-prefix');p.value='/Users/me';p.dispatchEvent(new Event('input',{bubbles:true}));
    const mode=document.querySelector('#file-mode');mode.value='per_file';mode.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await waitFor("document.querySelector('#pages-count').textContent === '2' && document.querySelector('#text').value.startsWith('# /Users/me/project/a.txt\\n')");
  await evaluate("document.querySelector('#file-list button').click();true");
  await waitFor("document.querySelector('#file-count').textContent === '1' && document.querySelector('#pages-count').textContent === '1'");
  await delay(700); await page('Page.reload');
  await waitFor("document.querySelector('#file-count')?.textContent === '1' && document.querySelector('#file-mode').value === 'per_file' && document.querySelector('#path-prefix').value === '/Users/me' && document.querySelector('#opt-reflow').checked");
  // Directory entries exposed through a paste event use the identical recursive intake.
  await evaluate(`(() => {const dt=new DataTransfer();const item=dt.items.add(new File([],'pasted',{type:'application/x-directory'}));
    const root={name:'pasted',isDirectory:true,createReader(){let done=false;return {readEntries(ok){ok(done?[]:[{name:'p.txt',isFile:true,file(ok){ok(new File(['paste body'],'p.txt'));}}]);done=true;}};}};
    const original=DataTransferItem.prototype.webkitGetAsEntry; DataTransferItem.prototype.webkitGetAsEntry=()=>root;document.activeElement.blur();
    document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    DataTransferItem.prototype.webkitGetAsEntry=original; return true;})()`);
  await waitFor("document.querySelector('#file-count').textContent === '2' && document.querySelector('#text').value.includes('# /Users/me/pasted/p.txt')");
  console.log('PASS: nested directory drop/paste, binary exclusion, modes, path headers, removal and history persistence');
  const realFolder=join(profile,'folder-fixture');
  mkdirSync(join(realFolder,'nested'),{recursive:true});
  writeFileSync(join(realFolder,'one.txt'),'real text one');
  writeFileSync(join(realFolder,'nested','two.rs'),'fn actual() {}');
  writeFileSync(join(realFolder,'nested','binary.dat'),Buffer.from([0,1,2]));
  const dom=await page('DOM.getDocument');
  const selector=await page('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#folder'});
  await page('DOM.setFileInputFiles',{nodeId:selector.nodeId,files:[realFolder]});
  await waitFor("document.querySelector('#file-count').textContent === '4' && document.querySelector('#text').value.includes('folder-fixture/nested/two.rs')");
  await waitFor("document.querySelector('#pages-count').textContent === '4'");
  console.log('PASS: real folder input reads nested text files and rejects binary contents');
  const downloads=join(profile,'downloads');mkdirSync(downloads);
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await evaluate("document.querySelector('#zip').click();true");
  let archive;
  for(let attempt=0;attempt<200;attempt++) {
    archive=readdirSync(downloads).find(name=>name.endsWith('.zip'));
    if(archive) break;
    await delay(50);
  }
  assert.ok(archive,'ZIP export completed');
  const zip=readFileSync(join(downloads,archive));const contents=new Map();let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50) {
    assert.equal(zip.readUInt16LE(offset+8),0);
    const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString();
    const start=offset+30+nameLength+extra; contents.set(name,zip.subarray(start,start+size));offset=start+size;
  }
  const manifest=JSON.parse(contents.get('manifest.json'));
  assert.equal(manifest.file_mode,'per_file');assert.equal(manifest.files.length,4);
  assert.equal(manifest.options.reflow,true);assert.equal(manifest.reflow_scope,'file_bodies');
  assert.equal(contents.size,manifest.pages.length+2);
  const rows=JSON.parse(contents.get('rows.json'));
  assert.ok(rows.flat().some(row=>row.text.startsWith('# /Users/me/folder-fixture/nested/two.rs')));
  assert.ok(rows.flat().some(row=>row.text==='let b=2; let c=3;'));
  for(const pageRows of rows) {
    assert.ok(pageRows[0].text.startsWith('# /Users/me/'));
    assert.equal(pageRows[0].hard_break,true);
  }
  console.log('PASS: exported ZIP contains per-file PNGs, path headers and matching manifest');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await waitFor('innerWidth === 390');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'file-set mobile layout overflows');
} finally {
  socket?.close();
  browser.kill();
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

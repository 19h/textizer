// BROWSER=/path/to/chrome node scripts/verify_browser.mjs
// Node >= 22; isolated headless profile, local static server, no npm dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      '.wasm': 'application/wasm' })[extname(path)] ?? 'application/octet-stream');
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
    throw Error(`Browser timed out: ${expression}`);
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
} finally {
  socket?.close();
  browser.kill();
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

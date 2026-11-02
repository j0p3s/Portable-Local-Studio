const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

test('custom LLM downloads validate URLs, save complete files, report progress, and cancel cleanly', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-llm-download-'));
  fs.cpSync(path.join(root, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
  const bytes = Buffer.from('GGUF\x03\x00\x00\x00local-download-fixture');
  const provider = http.createServer((req, res) => {
    if (req.url === '/redirect.gguf') { res.writeHead(302, { Location: '/tiny.gguf' }); res.end(); return; }
    if (req.url === '/bad-redirect.gguf') { res.writeHead(302, { Location: 'ftp://example.com/file.gguf' }); res.end(); return; }
    if (req.url === '/html.gguf') { res.setHeader('Content-Type', 'text/html'); res.end('<html>not a model</html>'); return; }
    if (req.url === '/slow.gguf') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 1024 * 1024 });
      res.write(Buffer.alloc(1024));
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 25);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }); res.end(bytes);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const source = `http://127.0.0.1:${provider.address().port}`;
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['scripts/server/serve.cjs'], {
    cwd: fixture, env: { ...process.env, PORT: String(port), COMFYUI_URL: 'http://127.0.0.1:8188' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs = (logs + data).slice(-5000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  async function api(route, body) {
    const response = await fetch(`${base}${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, data: await response.json() };
  }
  for (let attempt = 0; ; attempt++) {
    try { await api('/api/llm/models'); break; }
    catch (err) { if (attempt > 100 || child.exitCode !== null) throw new Error(`API startup failed: ${logs}`, { cause: err }); await delay(30); }
  }
  async function finished() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { data } = await api('/api/download-progress');
      if (!data.active) return data;
      await delay(30);
    }
    throw new Error('Download did not finish.');
  }

  await t.test('invalid protocols, filenames, and repository pages are rejected without crashing the API', async () => {
    for (const body of [
      { url: 'file:///tmp/model.gguf' },
      { url: 'ftp://example.com/model.gguf' },
      { url: `${source}/tiny.gguf`, filename: '../outside.gguf' },
      { url: `${source}/tiny.gguf`, filename: 'folder\\outside.gguf' },
      { url: `${source}/tiny.gguf`, filename: 'image.safetensors' },
      { url: 'https://huggingface.co/owner/repo', filename: 'text.gguf' },
    ]) assert.equal((await api('/api/llm/download-model', body)).status, 400);
    assert.equal((await api('/api/llm/models')).status, 200);
  });
  await t.test('redirected model appears in the shared text library after an atomic download', async () => {
    const result = await api('/api/llm/download-model', { url: `${source}/redirect.gguf`, filename: 'custom-prompt.gguf', overwrite: false });
    assert.equal(result.status, 200);
    const progress = await finished();
    assert.equal(progress.error, null);
    assert.equal(progress.progress, 100);
    assert.equal(progress.kind, 'text');
    assert.deepEqual(fs.readFileSync(path.join(fixture, 'app/llm-models/custom-prompt.gguf')), bytes);
    assert.equal(fs.existsSync(path.join(fixture, 'app/llm-models/custom-prompt.gguf.part')), false);
    assert.ok((await api('/api/llm/models')).data.models.some(model => model.filename === 'custom-prompt.gguf'));
    assert.equal((await api('/api/llm/download-model', { url: `${source}/tiny.gguf`, filename: 'custom-prompt.gguf', overwrite: false })).status, 409);
    assert.deepEqual(fs.readFileSync(path.join(fixture, 'app/llm-models/custom-prompt.gguf')), bytes);
  });
  await t.test('HTML responses and unsupported redirects do not leave a model file', async () => {
    for (const name of ['html.gguf', 'bad-redirect.gguf']) {
      assert.equal((await api('/api/llm/download-model', { url: `${source}/${name}` })).status, 200);
      assert.ok((await finished()).error);
      assert.equal(fs.existsSync(path.join(fixture, 'app/llm-models', name)), false);
      assert.equal(fs.existsSync(path.join(fixture, 'app/llm-models', `${name}.part`)), false);
    }
  });
  await t.test('another download is blocked and cancellation removes the partial file', async () => {
    assert.equal((await api('/api/llm/download-model', { url: `${source}/slow.gguf` })).status, 200);
    assert.equal((await api('/api/download-progress')).data.active, true);
    assert.equal((await api('/api/llm/download-model', { url: `${source}/tiny.gguf` })).status, 409);
    assert.equal((await api('/api/cancel-download', {})).data.ok, true);
    const progress = await finished();
    assert.match(progress.error, /cancel/i);
    await delay(30);
    assert.equal(fs.existsSync(path.join(fixture, 'app/llm-models/slow.gguf.part')), false);
    assert.equal(fs.existsSync(path.join(fixture, 'app/llm-models/slow.gguf')), false);
  });
});

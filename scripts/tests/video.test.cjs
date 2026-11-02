const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createVideoEngine } = require('../server/video.cjs');

test('local video workflow submits prompt, polls history, and streams only its own output', async t => {
  let submitted;
  let complete = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/system_stats') return res.end('{}');
    if (req.url === '/prompt') {
      let body = '';
      for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body);
      return res.end(JSON.stringify({ prompt_id: 'engine-job' }));
    }
    if (req.url === '/history/engine-job') return res.end(JSON.stringify(complete ? {
      'engine-job': { status: { completed: true }, outputs: { '3': { gifs: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output' }] } } },
    } : {}));
    if (req.url.startsWith('/view?')) {
      assert.equal(new URL(req.url, 'http://localhost').searchParams.get('filename'), 'clip.mp4');
      assert.equal(req.headers.range, 'bytes=0-3');
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/4' });
      return res.end('test');
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const engine = createVideoEngine(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await engine.health()).ok, true);
  const workflow = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'original' } }, '2': { class_type: 'CLIPTextEncode', inputs: { text: 'negative' } } };
  const job = await engine.generate({ workflow, prompt: 'a bird flying', promptNode: '1' });
  assert.equal(submitted.prompt['1'].inputs.text, 'a bird flying');
  assert.equal(submitted.prompt['2'].inputs.text, 'negative');
  assert.equal(workflow['1'].inputs.text, 'original');
  assert.equal((await engine.status(job.id)).status, 'queued');
  complete = true;
  const status = await engine.status(job.id);
  assert.equal(status.status, 'complete');
  assert.equal(status.outputs.length, 1);
  const stream = await engine.file(job.id, 0, 'bytes=0-3');
  let data = '';
  for await (const chunk of stream) data += chunk;
  assert.equal(data, 'test');
  await assert.rejects(engine.file(job.id, 1), /not found/);
  await assert.rejects(engine.status('another-job'), /not found/);
  await assert.rejects(engine.generate({ workflow: { nodes: [] } }), /API format/);
  await assert.rejects(engine.generate({ workflow, prompt: 'test', promptNode: 'missing' }), /prompt node/);
});

test('video engine reports failed and non-video workflows honestly', async t => {
  let history;
  const server = http.createServer((req, res) => res.end(JSON.stringify(req.url === '/prompt' ? { prompt_id: 'id' } : { id: history })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const engine = createVideoEngine(`http://127.0.0.1:${server.address().port}`);
  const payload = { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }, prompt: 'test', promptNode: '1' };
  const first = await engine.generate(payload);
  history = { status: { status_str: 'error' } };
  assert.equal((await engine.status(first.id)).status, 'failed');
  const second = await engine.generate(payload);
  history = { status: { completed: true }, outputs: {} };
  assert.match((await engine.status(second.id)).error, /without a saved video/);
  assert.throws(() => createVideoEngine('https://example.com'), /local/);
});

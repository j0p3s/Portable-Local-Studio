const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

function createVideoEngine(baseUrl = process.env.COMFYUI_URL || 'http://127.0.0.1:8188') {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('COMFYUI_URL must point to a local HTTP or HTTPS ComfyUI server.');
  }
  const jobs = new Map();
  function request(route, body, streamResponse, headers = {}) {
    const url = new URL(route, base);
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: data ? 'POST' : 'GET', agent: false,
        headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
        timeout: 30000,
      }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let message = '';
          res.on('data', chunk => { if (message.length < 4000) message += chunk; });
          res.on('end', () => reject(new Error(`ComfyUI HTTP ${res.statusCode}: ${message.slice(0, 4000)}`)));
          res.on('error', reject);
          return;
        }
        if (streamResponse) return resolve(res);
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
          if (text.length > 8 * 1024 * 1024) res.destroy(new Error('ComfyUI response is too large.'));
        });
        res.on('error', reject);
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error('ComfyUI returned invalid JSON.')); } });
      });
      req.on('timeout', () => req.destroy(new Error('ComfyUI request timed out.')));
      req.on('error', err => reject(new Error(`Cannot reach local ComfyUI: ${err.message}`)));
      req.end(data);
    });
  }
  return {
    async health() {
      await request('/system_stats');
      return { ok: true, engine: 'ComfyUI' };
    },
    async generate({ workflow, prompt, promptNode }) {
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || workflow.nodes || JSON.stringify(workflow).length > 2 * 1024 * 1024) {
        throw new Error('Upload a ComfyUI workflow exported in API format (maximum 2 MB).');
      }
      const graph = structuredClone(workflow);
      if (!Object.keys(graph).length || Object.values(graph).some(node => !node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
        throw new Error('Invalid ComfyUI API workflow. Each node needs class_type and inputs.');
      }
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000 || typeof graph[promptNode]?.inputs?.text !== 'string') {
        throw new Error('Enter a prompt and select a text prompt node from the workflow.');
      }
      if (jobs.size >= 100) {
        for (const [id, job] of jobs) if (job.status !== 'queued') jobs.delete(id);
        if (jobs.size >= 100) throw new Error('Too many video jobs. Wait for queued jobs to finish.');
      }
      graph[promptNode].inputs.text = prompt.trim();
      const result = await request('/prompt', { prompt: graph, client_id: randomUUID() });
      if (!result.prompt_id || (result.node_errors && Object.keys(result.node_errors).length)) throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(result.node_errors || result.error)}`);
      const id = randomUUID();
      jobs.set(id, { promptId: result.prompt_id, status: 'queued', outputs: [] });
      return { id, status: 'queued' };
    },
    async status(id) {
      const job = jobs.get(id);
      if (!job) throw new Error('Video job not found. Jobs are retained until the studio server restarts.');
      if (job.status === 'queued') {
        const history = await request(`/history/${encodeURIComponent(job.promptId)}`);
        const entry = history[job.promptId];
        if (entry?.status?.status_str === 'error') {
          job.status = 'failed';
          job.error = 'ComfyUI could not execute this workflow. Check its console for missing models or nodes.';
        } else if (entry?.status?.completed) {
          job.outputs = Object.values(entry.outputs || {}).flatMap(output => [...(output.gifs || []), ...(output.videos || []), ...(output.images || [])])
            .filter(file => typeof file.filename === 'string' && /\.(mp4|webm|mov|gif)$/i.test(file.filename) && file.type === 'output');
          job.status = job.outputs.length ? 'complete' : 'failed';
          if (!job.outputs.length) job.error = 'The workflow completed without a saved video. Add a video output node that saves MP4, WebM, MOV, or GIF.';
        }
      }
      return { id, status: job.status, error: job.error, outputs: job.outputs.map((file, index) => ({ filename: file.filename, url: `/api/video/file?id=${encodeURIComponent(id)}&index=${index}` })) };
    },
    async file(id, index, range) {
      const file = jobs.get(id)?.outputs[index];
      if (!file) throw new Error('Video output not found.');
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: 'output' });
      return request(`/view?${query}`, undefined, true, range ? { Range: range } : {});
    },
  };
}
module.exports = { createVideoEngine };

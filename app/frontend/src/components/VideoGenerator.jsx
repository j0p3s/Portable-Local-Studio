import { useEffect, useState } from 'react';
import '../styles/tools.css';

export default function VideoGenerator() {
  const [workflow, setWorkflow] = useState(null);
  const [workflowName, setWorkflowName] = useState('');
  const [promptNode, setPromptNode] = useState('');
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [engine, setEngine] = useState('');
  const nodes = Object.entries(workflow || {}).filter(([, node]) => typeof node?.inputs?.text === 'string');
  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Video request failed.');
    return data;
  }
  async function checkEngine() {
    setEngine('Checking…');
    try { await api('/api/video/health'); setEngine('Local ComfyUI connected'); }
    catch { setEngine('Start ComfyUI locally on port 8188 to generate video.'); }
  }
  useEffect(() => { checkEngine(); }, []);
  useEffect(() => {
    if (job?.status !== 'queued') return;
    let stopped = false;
    let timer;
    async function poll() {
      try {
        const next = await api(`/api/video/status?id=${encodeURIComponent(job.id)}`);
        if (!stopped) { setJob(next); setError(''); }
      } catch (err) { if (!stopped) setError(`${err.message} Retrying…`); }
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status]);
  async function loadWorkflow(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Workflow must be smaller than 2 MB.');
      const graph = JSON.parse(await file.text());
      if (!graph || Array.isArray(graph) || typeof graph !== 'object' || graph.nodes || !Object.keys(graph).length || Object.values(graph).some(node => !node?.class_type || !node.inputs)) throw new Error('Export your ComfyUI workflow in API format, then upload that JSON file.');
      const candidates = Object.entries(graph).filter(([, node]) => typeof node.inputs.text === 'string');
      if (!candidates.length) throw new Error('This workflow has no editable text prompt node.');
      const [id, node] = candidates.find(([, node]) => /positive/i.test(node._meta?.title || '')) || candidates[0];
      setWorkflow(graph); setWorkflowName(file.name); setPromptNode(id); setPrompt(node.inputs.text); setError('');
    } catch (err) { setError(err.message); }
  }
  async function generate(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { setJob(await api('/api/video/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow, prompt, promptNode }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const running = busy || job?.status === 'queued';
  return <section className="studio-tool">
    <h1>Video generation</h1>
    <p>Generate videos on your machine with ComfyUI and a locally installed video model, such as Wan or LTX-Video. Export a working workflow in API format with a saved video output, then upload it here. The workflow keeps its model, resolution, duration and seed settings.</p>
    <p role="status">{engine} <button type="button" onClick={checkEngine}>Check connection</button></p>
    <form className="studio-tool-form" onSubmit={generate}>
      <label>Video workflow (API JSON, up to 2 MB)<input type="file" accept=".json,application/json" onChange={loadWorkflow} disabled={running} /></label>
      {workflowName && <p>{workflowName}</p>}
      {nodes.length > 0 && <label>Positive prompt node<select value={promptNode} disabled={running} onChange={e => { setPromptNode(e.target.value); setPrompt(workflow[e.target.value].inputs.text); }}>
        {nodes.map(([id, node]) => <option key={id} value={id}>{node._meta?.title || node.class_type} (#{id})</option>)}
      </select></label>}
      <label>Describe your video<textarea rows={5} maxLength={10000} value={prompt} disabled={running} onChange={e => setPrompt(e.target.value)} required /></label>
      <button disabled={running || !workflow || !prompt.trim()}>{running ? 'Generating video…' : 'Generate video'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {job?.status === 'queued' && <p role="status">Queued or rendering in ComfyUI. Keep the studio server running. Large video models can take several minutes.</p>}
    {job?.error && <p role="alert">{job.error}</p>}
    {job?.outputs?.map(output => <article className="studio-tool-result" key={output.url}>
      {/\.gif$/i.test(output.filename) ? <img src={output.url} alt="Generated animation" /> : <video src={output.url} controls preload="metadata" />}
      <p><a href={output.url} download={output.filename}>Download {output.filename}</a></p>
    </article>)}
  </section>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelModelDownload, downloadLlmModel, formatBytes, getBackendStatus,
  getDownloadProgress, getLlmStatus, listLlmModels, startLlm, stopLlm,
  stopServer, streamChatWithLlm,
} from '../services/api';

const withoutReasoning = text => String(text || '')
  .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

export default function VideoPromptAssistant({ prompt, onUsePrompt, disabled, active = true, textSettings = {}, showConfirm, onImageUnloaded }) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [status, setStatus] = useState({ ready: false, settings: {} });
  const [download, setDownload] = useState({ active: false });
  const [startingDownload, setStartingDownload] = useState(false);
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestedFilename = useRef('');
  const lastCompletion = useRef('');
  const abortController = useRef(null);

  const refreshModels = useCallback(async (preferred = '') => {
    const available = (await listLlmModels()).filter(model => !model.isProjector);
    setModels(available);
    setSelectedModel(current => {
      if (preferred && available.some(model => model.filename === preferred)) return preferred;
      return available.some(model => model.filename === current) ? current : available[0]?.filename || '';
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    refreshModels().catch(err => setError(err.message));
    let stopped = false;
    let timer;
    async function poll() {
      const [nextStatus, nextDownload] = await Promise.all([getLlmStatus(), getDownloadProgress()]);
      if (stopped) return;
      setStatus(nextStatus); setDownload(nextDownload);
      if (nextDownload.kind === 'text' && !nextDownload.active && nextDownload.filename && !nextDownload.error && nextDownload.progress === 100) {
        const key = `${nextDownload.filename}:${nextDownload.downloadedBytes}`;
        if (lastCompletion.current !== key) {
          lastCompletion.current = key;
          const preferred = requestedFilename.current === nextDownload.filename ? nextDownload.filename : '';
          refreshModels(preferred).catch(err => setError(err.message));
        }
      }
      timer = setTimeout(poll, 1000);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, refreshModels]);

  useEffect(() => () => abortController.current?.abort(), []);

  async function downloadModel(event) {
    event.preventDefault(); setError(''); setNotice('');
    let parsed;
    try { parsed = new URL(url.trim()); } catch { setError('Enter a valid direct download URL for a .gguf file.'); return; }
    if (!['https:', 'http:'].includes(parsed.protocol)) { setError('Use an HTTP or HTTPS model download URL.'); return; }
    let name;
    try { name = filename.trim() || decodeURIComponent(parsed.pathname.split('/').pop() || ''); }
    catch { setError('The model URL contains an invalid filename.'); return; }
    if (!/^[^/\\\x00-\x1f]+\.gguf$/i.test(name) || name.length > 240) { setError('Enter a filename ending in .gguf, without folders.'); return; }
    if (models.some(model => model.filename === name)) { setError('A model with this filename already exists. Choose another filename to keep the existing model.'); return; }
    setStartingDownload(true);
    try {
      const result = await downloadLlmModel(parsed.toString(), name, null, { overwrite: false });
      requestedFilename.current = result.filename || name;
      setDownload({ active: true, kind: 'text', filename: result.filename || name, progress: 0 });
      setNotice('Download started. Keep the studio server running until it finishes.');
    } catch (err) { setError(err.message); }
    finally { setStartingDownload(false); }
  }

  async function cancelDownload() {
    const result = await cancelModelDownload();
    if (!result.ok) setError(result.error || 'Could not cancel the download.');
    else { setDownload(await getDownloadProgress()); setNotice('Download cancelled.'); }
  }

  async function loadModel() {
    setLoading(true); setError(''); setNotice('');
    try {
      const [text, image] = await Promise.all([getLlmStatus(), getBackendStatus()]);
      const changingText = (text.ready || text.running) && text.settings?.model !== selectedModel;
      if (image.ready || image.running || changingText) {
        const confirmed = await showConfirm?.({
          title: 'Switch to the prompt assistant model?',
          message: 'The current image or text model must be unloaded to load this LLM. Continue?',
          confirmLabel: 'Unload and load',
        });
        if (!confirmed) return;
      }
      if (image.ready || image.running) { await stopServer(); onImageUnloaded?.(); }
      if (changingText) await stopLlm();
      if (!(text.ready && text.settings?.model === selectedModel)) {
        await startLlm(selectedModel, { ...textSettings, enableThinking: false });
      }
      setStatus(await getLlmStatus());
      setNotice('Text model loaded. Enter a video idea below, then choose Help write prompt.');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function helpWritePrompt() {
    setWriting(true); setError(''); setNotice(''); setSuggestion('');
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const current = await getLlmStatus();
      setStatus(current);
      if (!current.ready || current.settings?.model !== selectedModel) throw new Error('Load the selected text model before writing a video prompt.');
      const result = await streamChatWithLlm([
        { role: 'system', content: 'You write concise, vivid prompts for local video generation. Expand the user idea into one coherent prompt describing the subject, action, motion, camera movement, lighting and visual style. Preserve the user intent. Return only the video prompt, without commentary, reasoning, headings or quotation marks.' },
        { role: 'user', content: prompt.trim() },
      ], { temperature: textSettings.temperature ?? 0.7, maxTokens: 512, signal: controller.signal, useWeb: false },
      (_token, fullText) => setSuggestion(withoutReasoning(fullText)));
      const clean = withoutReasoning(result.content);
      if (!clean) throw new Error('The LLM did not return a video prompt. Try again.');
      setSuggestion(clean);
    } catch (err) {
      if (err.name === 'AbortError') setNotice('Prompt writing stopped.');
      else { setError(err.message); setSuggestion(''); }
    } finally { setWriting(false); abortController.current = null; }
  }

  const loaded = status.ready && status.settings?.model === selectedModel;
  const busy = disabled || loading || writing;
  return <section className="video-prompt-assistant" aria-labelledby="video-prompt-assistant-title">
    <h2 id="video-prompt-assistant-title">Prompt assistant (text LLM)</h2>
    <p>Download a custom GGUF text model to help write video prompts. It is shared with Chat and saved in app/llm-models. ComfyUI still uses your video workflow and video models to render the result.</p>
    <form className="studio-tool-form" onSubmit={downloadModel}>
      <label>Custom LLM download URL<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://huggingface.co/owner/model/resolve/main/model.gguf" required disabled={startingDownload || download.active} /></label>
      <label>Save as (optional .gguf filename)<input value={filename} onChange={event => setFilename(event.target.value)} placeholder="Inferred from the URL" maxLength={240} disabled={startingDownload || download.active} /></label>
      <p className="video-prompt-note">Use a public link to a single .gguf file. Hugging Face file links are supported. Downloading requires Internet access; prompt writing runs locally after setup.</p>
      <button disabled={!url.trim() || startingDownload || download.active}>{startingDownload ? 'Starting download…' : 'Download custom LLM'}</button>
    </form>
    {download.active && download.kind !== 'text' && <p role="status">Another download is active. Wait for it to finish before downloading an LLM.</p>}
    {download.kind === 'text' && download.filename && <div className="video-llm-download" aria-live="polite">
      <p>{download.filename}: {download.active ? 'Downloading' : download.error ? 'Download stopped' : download.progress === 100 ? 'Downloaded' : 'Idle'}
        {download.active && ` · ${formatBytes(download.downloadedBytes || 0)}${download.totalBytes ? ` of ${formatBytes(download.totalBytes)}` : ''}${download.speed ? ` · ${download.speed}` : ''}`}</p>
      {download.active && <><progress aria-label="Text model download progress" max="100" value={download.totalBytes > 0 ? download.progress : undefined} /><button type="button" onClick={cancelDownload}>Cancel LLM download</button></>}
      {download.error && <p role="alert">{download.error}</p>}
    </div>}
    <div className="studio-tool-form">
      <label>Text model for video prompts<select value={selectedModel} onChange={event => setSelectedModel(event.target.value)} disabled={busy}>
        <option value="">Select a downloaded text model</option>
        {models.map(model => <option key={model.filename} value={model.filename}>{model.filename}</option>)}
      </select></label>
      <div><button type="button" disabled={busy} onClick={() => refreshModels().catch(err => setError(err.message))}>Refresh text models</button>
        <button type="button" disabled={busy || !selectedModel || loaded} onClick={loadModel}>{loading ? 'Loading text model…' : loaded ? 'Text model loaded' : 'Load text model'}</button>
        <button type="button" disabled={busy || !loaded || !prompt.trim()} onClick={helpWritePrompt}>{writing ? 'Writing prompt…' : 'Help write prompt'}</button>
        {writing && <button type="button" onClick={() => abortController.current?.abort()}>Stop writing</button>}
      </div>
      <p className="video-prompt-note">Enter your idea in “Describe your video” below. Load this text model to draft a prompt, then use it when you are happy with the result. Loading requires the llama.cpp runtime from the app’s platform setup.</p>
      {suggestion && <div className="video-prompt-suggestion"><label>Suggested video prompt<textarea rows={5} value={suggestion} readOnly /></label>
        <button type="button" disabled={busy} onClick={() => { onUsePrompt(suggestion); setNotice('Suggested prompt applied to the video description.'); }}>Use this prompt</button>
      </div>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

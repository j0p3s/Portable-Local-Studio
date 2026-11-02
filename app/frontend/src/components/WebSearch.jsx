import { useRef, useState } from 'react';
import '../styles/tools.css';

export default function WebSearch() {
  const [query, setQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState('any');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef(null);
  async function search(event) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    controller.current = new AbortController();
    setBusy(true); setError(''); setResults(null);
    try {
      const response = await fetch('/api/web-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, timeFilter }), signal: controller.current.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Search failed.');
      setResults(data.sources);
    } catch (err) { setError(err.name === 'AbortError' ? 'Search cancelled.' : err.message); }
    finally { setBusy(false); }
  }
  return <section className="studio-tool">
    <h1>Web search</h1>
    <p>Search DuckDuckGo without loading a chat model. Internet access is required. Enable Web in chat to include search results in an answer.</p>
    <form onSubmit={search} className="studio-tool-form">
      <label>Search query<input value={query} onChange={e => setQuery(e.target.value)} maxLength={1000} required /></label>
      <label>Published<select value={timeFilter} onChange={e => setTimeFilter(e.target.value)}>
        <option value="any">Any time</option><option value="day">Past day</option><option value="week">Past week</option><option value="month">Past month</option><option value="year">Past year</option>
      </select></label>
      <div><button disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</button>{busy && <button type="button" onClick={() => controller.current?.abort()}>Cancel</button>}</div>
    </form>
    {error && <p role="alert">{error}</p>}
    {results?.length === 0 && <p role="status">No results returned. Try another query; the search provider may also be limiting requests.</p>}
    <div aria-live="polite">{results?.map(source => <article className="studio-tool-result" key={source.url}>
      <h2><a href={/^https?:\/\//i.test(source.url) ? source.url : undefined} target="_blank" rel="noopener noreferrer">{source.title}</a></h2>
      <small>{source.url}</small><p>{source.snippet || source.content?.slice(0, 400)}</p>
    </article>)}</div>
  </section>;
}

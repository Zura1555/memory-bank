import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import type { SourceCatalogEntry } from "../src/shared/protocol";
import { uploadStateLabels, type PrivateSource, type PrivateSourceDetail, type SourceIndexStatus } from "../src/shared/uploads";
import { UploadPicker, usePrivateUploads } from "./uploads";

type Resource = { key: string; title: string; group: string; type: string; date: string; status: string; privateSource?: PrivateSource; corpusSource?: SourceCatalogEntry };
const tabs = ["Overview", "Content", "Related", "Activity"] as const;

function FileIcon({ type }: { type: string }) {
  const kind = type.includes("spreadsheet") || type === "text/csv" ? "sheet" : type.includes("presentation") ? "slides" : type.startsWith("image/") ? "image" : "document";
  return <span className={`resource-file-icon resource-file-${kind}`}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" /></svg></span>;
}

export function SourceLibrary({ sources, indexStatus, renderSource }: {
  sources: SourceCatalogEntry[]; indexStatus: Record<string, SourceIndexStatus> | null;
  renderSource: (source: SourceCatalogEntry) => ReactNode;
}) {
  const library = usePrivateUploads();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("updated");
  const [selected, setSelected] = useState<string | null>(library.focusedId ? `private:${library.focusedId}` : null);
  const [tab, setTab] = useState<typeof tabs[number]>("Overview");
  const [detail, setDetail] = useState<PrivateSourceDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const tabId = useId();
  const detailElement = useRef<HTMLElement | null>(null);
  const listElement = useRef<HTMLElement | null>(null);
  const searchElement = useRef<HTMLInputElement | null>(null);
  const resources = useMemo<Resource[]>(() => [
    ...library.sources.map((source) => ({ key: `private:${source.id}`, title: source.name, group: "Private · this browser", type: source.mimeType, date: source.updatedAt, status: uploadStateLabels[source.state], privateSource: source })),
    ...sources.map((source) => ({ key: `corpus:${source.versionId}`, title: source.title, group: source.caseTitle, type: source.mimeType, date: source.statedDate ?? "", status: source.availability === "available" ? indexStatus?.[source.versionId] === "indexed" ? "Indexed" : indexStatus?.[source.versionId] === "partial" ? "Partially indexed" : indexStatus?.[source.versionId] === "pending" ? "Not indexed" : "Index unconfirmed" : source.availability === "incomplete" ? "Needs review" : "Unavailable", corpusSource: source })),
  ], [sources, library.sources, indexStatus]);
  const filtered = resources.filter((source) => (!group || source.group === group) && (!type || source.type === type) && (!status || source.status === status)
    && `${source.title} ${source.group} ${source.corpusSource?.versionId ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const current = resources.find((source) => source.key === selected) ?? null;
  const privateSource = current?.privateSource;
  const corpusSource = current?.corpusSource;
  const groupOptions = [...new Set(resources.map((source) => source.group))];
  const typeOptions = [...new Set(resources.map((source) => source.type))];
  const statusOptions = [...new Set(resources.map((source) => source.status))];
  const filterCount = [group, type, status].filter(Boolean).length;
  const clearFilters = () => { setQuery(""); setGroup(""); setType(""); setStatus(""); };
  useEffect(() => {
    if (library.focusedId) {
      select(`private:${library.focusedId}`);
      library.setFocusedId(null);
    }
  }, [library.focusedId]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (!privateSource) return;
    const controller = new AbortController();
    void library.detail(privateSource.id, controller.signal).then((source) => {
      if (!controller.signal.aborted) setDetail(source);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "Private source content could not be loaded.");
    });
    return () => controller.abort();
  }, [privateSource?.id, privateSource?.updatedAt, privateSource?.state]);
  const related = corpusSource ? sources.filter((source) => source.caseId === corpusSource.caseId && source.versionId !== corpusSource.versionId) : [];
  const select = (key: string, section: typeof tabs[number] = "Overview") => {
    setSelected(key); setTab(section);
    window.requestAnimationFrame(() => {
      if (listElement.current && getComputedStyle(listElement.current).display === "none") {
        detailElement.current?.scrollIntoView({ block: "start" });
        detailElement.current?.focus({ preventScroll: true });
      }
    });
  };
  const close = () => {
    setSelected(null); setExpanded(false); library.setFocusedId(null);
    window.requestAnimationFrame(() => {
      const row = listElement.current?.querySelector<HTMLButtonElement>(`[data-source-key="${CSS.escape(selected ?? "")}"]`);
      (row ?? searchElement.current)?.focus();
    });
  };
  return <section className="resource-workspace" aria-label="Source library">
    <div className="resource-heading"><div><h2>Your source library</h2><p>Browse originals, then open a source to inspect its content and provenance.</p></div>
      <Button className="primary-button" type="button" onClick={() => setShowUpload((open) => !open)} aria-expanded={showUpload} aria-controls="sources-upload">{showUpload ? "Close upload" : "Add source"}</Button></div>
    {showUpload && <div id="sources-upload"><UploadPicker /></div>}
    {library.error && !showUpload && <p className="notice notice-error" role="alert">{library.error} <button type="button" className="text-button" onClick={() => void library.refresh()}>Refresh private sources</button></p>}
    <div className="resource-browser">
      <div className="resource-controls">
        <label className="resource-search">Search sources<input ref={searchElement} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search by title, case or version…" /></label>
        <label className="resource-sort">Sort<select aria-label="Sort sources" value={sort} onChange={(event) => setSort(event.currentTarget.value)}><option value="updated">Last updated</option><option value="name">Name</option></select></label>
        <button type="button" className="text-button resource-clear" disabled={!query && !filterCount} onClick={clearFilters}>Clear all</button>
      </div>
      <details className="resource-filter-panel">
        <summary>Filters <span>{filterCount ? `${filterCount} active` : "Space, file type, status"}</span></summary>
        <div className="resource-filters" role="group" aria-label="Filter sources">
          <label>Space<select value={group} onChange={(event) => setGroup(event.currentTarget.value)}><option value="">All spaces ({resources.length})</option>{groupOptions.map((value) => <option key={value} value={value}>{value} ({resources.filter((source) => source.group === value).length})</option>)}</select></label>
          <label>File type<select value={type} onChange={(event) => setType(event.currentTarget.value)}><option value="">All types</option>{typeOptions.map((value) => <option key={value} value={value}>{value.startsWith("image/") ? value : value.split(".").pop()?.replace("document", "DOCX").replace("sheet", "XLSX").replace("presentation", "PPTX")}</option>)}</select></label>
          <label>Status<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="">All statuses</option>{statusOptions.map((value) => <option key={value} value={value}>{value} ({resources.filter((source) => source.status === value).length})</option>)}</select></label>
        </div>
      </details>
      <div className="resource-list-toolbar"><span role="status">{filtered.length} of {resources.length} sources</span><span>Select a source to inspect</span></div>
      <div className="resource-layout" data-detail-open={current ? "" : undefined} data-expanded={current && expanded ? "" : undefined}>
      <section ref={listElement} className="resource-list" aria-label="Retained sources">
        <div className="resource-columns" aria-hidden="true"><span>Source name</span><span>Space</span><span>Updated</span><span>Status</span></div>
        {filtered.length === 0 ? <div className="empty-state"><h3>No matching sources</h3><p>Try another title, clear your filters or add a private file.</p><button type="button" className="secondary-button" onClick={clearFilters} disabled={!query && !filterCount}>Clear filters</button></div> : <ul>{filtered.map((resource) => <li key={resource.key}><button type="button" className="resource-row" data-source-key={resource.key} aria-pressed={selected === resource.key} onClick={() => select(resource.key)}>
          <span className="resource-row-name"><FileIcon type={resource.type} /><span className="resource-row-copy"><strong>{resource.title}</strong><small>{resource.privateSource ? "Private · this browser" : "Fictional corpus"}</small></span></span>
          <span className="resource-row-space">{resource.group}</span>
          <span className="resource-row-date">{resource.date ? new Date(resource.date).toLocaleDateString() : "No stated date"}</span>
          <span className={`resource-status resource-status-${resource.status.toLowerCase().replaceAll(" ", "-")}`}>{resource.status}</span>
        </button></li>)}</ul>}
      </section>
      <section ref={detailElement} className="resource-detail" aria-label="Source details" tabIndex={-1} hidden={!current}>
        {current && <>
          <div className="resource-detail-top"><button type="button" className="text-button resource-back" aria-label="Close source details" onClick={close}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>Back to sources</button>
            <button type="button" className="text-button resource-expand" aria-pressed={expanded} onClick={() => setExpanded((open) => !open)}>{expanded ? "Show source list" : "Expand source"}</button></div>
          <h3 className="resource-detail-title">{current.title}</h3><p className="resource-detail-subtitle">{current.group}</p>
          <div className="badge-row"><span className={`resource-status resource-status-${current.status.toLowerCase().replaceAll(" ", "-")}`}>{current.status}</span><span className="badge">{privateSource ? "Unreviewed client context" : "Fictional corpus"}</span></div>
          <div className="resource-tabs" role="tablist" aria-label="Source detail sections">{tabs.map((name, index) => <button type="button" key={name} role="tab" id={`${tabId}-${name}`} aria-controls={`${tabId}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); setTab(tabs[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
          }}>{name}{name === "Related" && related.length > 0 ? ` (${related.length})` : ""}</button>)}</div>
          <div className="resource-tab-panel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
            {tab === "Overview" && <>
              <dl className="resource-metadata"><div><dt>Type</dt><dd>{current.type}</dd></div><div><dt>Space</dt><dd>{current.group}</dd></div>
                {privateSource ? <><div><dt>Size</dt><dd>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(privateSource.size / 1024)} KiB</dd></div><div><dt>Added</dt><dd>{new Date(privateSource.createdAt).toLocaleString()}</dd></div><div><dt>Expires</dt><dd>{new Date(privateSource.expiresAt).toLocaleString()}</dd></div><div><dt>Extraction</dt><dd>{privateSource.hasText ? `${privateSource.textKind.replaceAll("_", " ")} · not audited` : "Not ready"}</dd></div><div><dt>Index chunks</dt><dd>{privateSource.chunkCount}</dd></div></>
                  : <><div><dt>Version</dt><dd>{corpusSource!.versionId}</dd></div><div><dt>Source access</dt><dd>{corpusSource!.availability}</dd></div><div><dt>Passages</dt><dd>{corpusSource!.passages.length}</dd></div></>}
                <div><dt>Index status</dt><dd>{current.status}</dd></div></dl>
              <h4>Use and review</h4><p className="field-hint">{privateSource ? "Uploaded files can provide new-client context after you inspect their extracted text. They do not become historical evidence or checked recommendations." : "Retained fictional sources support exact-passage inspection. Semantic similarity alone does not establish applicability."}</p>
              {privateSource?.warning && <p className="notice notice-warning">{privateSource.warning}</p>}
              {privateSource?.error && <p className="notice notice-error" role="alert">{privateSource.error}</p>}
              {privateSource && <div className="resource-actions"><Button type="button" className="secondary-button" onClick={() => void library.download(privateSource)}>Download exact original</Button>
                {["pending", "failed", "needs_review"].includes(privateSource.state) && <Button type="button" className="secondary-button" onClick={() => void library.process(privateSource.id)}>Process again</Button>}
                <Button type="button" className="secondary-button" onClick={() => setTab("Content")} disabled={!privateSource.hasText}>Review extracted content</Button></div>}
              {corpusSource && renderSource(corpusSource)}
            </>}
            {tab === "Content" && (privateSource ? <>
              {detailError ? <p className="notice notice-error" role="alert">{detailError}</p> : detail === null ? <p role="status">Loading private content…</p> : detail.text ? <><p className="field-hint">{detail.textKind.replaceAll("_", " ")} · unreviewed, not checked evidence. No markup, scripts or external links are executed.</p><pre className="resource-extracted-text">{detail.text}</pre><a className="primary-button" href="/" onClick={() => window.dispatchEvent(new CustomEvent("memory-bank:attach-source", { detail: privateSource.id }))}>Use reviewed text in Ask</a></> : <p>Extracted content is not ready. Inspect the status in Overview; the original is retained.</p>}
            </> : renderSource(corpusSource!))}
            {tab === "Related" && (related.length ? <><p className="field-hint">Other retained versions in the same fictional case—not a semantic relevance claim.</p><ul className="resource-related">{related.map((source) => <li key={source.versionId}><button className="text-button" type="button" onClick={() => select(`corpus:${source.versionId}`)}>{source.title} · {source.versionId}</button></li>)}</ul></> : <p>No related sources have been established for this private file. Search the private library by meaning below.</p>)}
            {tab === "Activity" && (privateSource ? <ol className="resource-activity">{privateSource.activity.map((event, index) => <li key={`${event.at}-${index}`}><strong>{uploadStateLabels[event.state]}</strong><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><p>{event.message}</p></li>)}</ol> : <><p>Curated fictional source version: <strong>{corpusSource!.versionId}</strong>.</p><p>{corpusSource!.statedDate ? `Source-stated date: ${corpusSource!.statedDate}.` : "No source date was supplied."}</p><p>Live index observation: {current.status}. No upload or processing history is inferred for this curated source.</p></>)}
          </div>
        </>}
      </section>
    </div>
    </div>
    <p className="field-hint resource-privacy">Private files stay separate from the fictional corpus and require this browser’s access key. Indexing is not evidence review.</p>
    <PrivateSourceSearch onSelect={(id) => select(`private:${id}`, "Content")} />
  </section>;
}

function PrivateSourceSearch({ onSelect }: { onSelect: (id: string) => void }) {
  const library = usePrivateUploads();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ sourceId: string; name: string; chunk: number; excerpt: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setResults(null); setError(null); setBusy(false);
    return () => controller.current?.abort();
  }, [library.token]);
  useEffect(() => {
    setResults((items) => items?.filter((item) => library.sources.some((source) => source.id === item.sourceId && Date.parse(source.expiresAt) > Date.now())) ?? null);
  }, [library.sources]);
  if (!library.sources.length) return null;
  return <form className="private-source-search" aria-label="Search private file content" onSubmit={async (event) => {
    event.preventDefault(); if (busy || !query.trim()) return;
    setBusy(true); setError(null); setResults(null);
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await fetch("/api/uploads/search", { method: "POST", signal: request.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${library.token}` }, body: JSON.stringify({ query: query.trim() }) });
      if (!response.ok) throw new Error(`Private search is unavailable (HTTP ${response.status}). Indexed sources remain available for browsing.`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || !body.results.every((item) => item && typeof item === "object" && typeof item.sourceId === "string" && library.sources.some((source) => source.id === item.sourceId) && typeof item.excerpt === "string" && typeof item.name === "string" && Number.isSafeInteger(item.chunk))) throw new Error("Private search returned unverified results; they were not shown.");
      if (!request.signal.aborted) setResults(body.results);
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Private search failed."); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }}><h3>Search your private files by meaning</h3><p className="field-hint">On submit, Cloudflare Workers AI embeds this query and Vectorize searches only this browser’s private namespace. Only confirmed indexed content is returned; similarity is not a checked recommendation.</p>
    <div className="source-semantic-controls"><label>Private search<input type="search" value={query} maxLength={1024} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Describe what you need…" /></label><Button className="secondary-button" type="submit" disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search private files"}</Button></div>
    {error && <p className="notice notice-error" role="alert">{error}</p>}{results && <div role="status">{results.length} private passage matches</div>}
    {results?.map((result) => <article className="private-search-match" key={`${result.sourceId}-${result.chunk}`}><button type="button" className="text-button" onClick={() => onSelect(result.sourceId)}>{result.name} · chunk {result.chunk + 1}</button><blockquote>{result.excerpt}</blockquote></article>)}
  </form>;
}

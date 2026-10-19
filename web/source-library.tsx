import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import type { PassageView, SourceCatalogEntry, SourceRef } from "../src/shared/protocol";
import { uploadStateLabels, type PrivateSource, type PrivateSourceDetail, type SourceIndexStatus } from "../src/shared/uploads";
import { isPassage } from "../src/ui/passage";
import { UploadPicker, usePrivateUploads } from "./uploads";
import "./sources.css";

type Resource = { key: string; title: string; caseId: string; group: string; type: string; date: string; status: string; privateSource?: PrivateSource; corpusSource?: SourceCatalogEntry };
const tabs = ["Overview", "Content", "Related", "Notes", "Activity"] as const;
type Tab = typeof tabs[number];
const dateLabel = (date: string) => date ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Not stated";
function fileLabel(type: string) {
  if (type.includes("pdf")) return "PDF";
  if (type.includes("wordprocessing")) return "DOCX";
  if (type.includes("spreadsheet")) return "XLSX";
  if (type.includes("presentation")) return "PPTX";
  if (type.startsWith("image/")) return "Image";
  return ({ "text/html": "Webpage", "text/markdown": "MD", "text/plain": "TXT", "text/csv": "CSV" } as Record<string, string>)[type] ?? type;
}
function Icon({ name }: { name: "add" | "close" | "search" | "open" | "download" | "lock" | "public" | "note" | "move" | "delete" | "left" | "right" | "sort" | "more" }) {
  const paths = { add: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", open: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7", download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4", lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zm7 4v3", public: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18", note: "M14 3H4v18h16V9m-6-6v6h6M8 13h8m-8 4h5", move: "M3 7V4h7l2 3h9v13H3zm6 7h8m-3-3 3 3-3 3", delete: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", left: "m15 5-7 7 7 7", right: "m9 5 7 7-7 7", sort: "M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4", more: "M5 12h.01M12 12h.01M19 12h.01" };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function FileIcon({ type }: { type: string }) {
  const label = fileLabel(type);
  return <span className={`source-file source-file-${label.toLowerCase()}`} aria-hidden="true"><svg width="30" height="36" viewBox="0 0 30 36" fill="none"><path d="M5 1h14l7 7v24a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" fill="currentColor" /><path d="M19 1v7h7" fill="white" fillOpacity=".35" /></svg><span>{label === "Image" ? "IMG" : label.slice(0, 4)}</span></span>;
}
function Status({ value }: { value: string }) {
  return <span className={`source-status source-status-${value.toLowerCase().replaceAll(" ", "-")}`}>{value}</span>;
}
function Visibility({ privateSource }: { privateSource: boolean }) {
  return <span className={`source-visibility ${privateSource ? "is-private" : "is-public"}`}><Icon name={privateSource ? "lock" : "public"} />{privateSource ? "Private" : "Public · fictional"}</span>;
}

export function SourceLibrary({ sources, indexStatus, inspect, loading, error }: {
  sources: SourceCatalogEntry[]; indexStatus: Record<string, SourceIndexStatus> | null;
  inspect: (ref: SourceRef) => void; loading: boolean; error: boolean;
}) {
  const library = usePrivateUploads();
  const { focusedId, setFocusedId } = library;
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("");
  const [caseId, setCaseId] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("Overview");
  const [showUpload, setShowUpload] = useState(false);
  const [pointerMotion, setPointerMotion] = useState(false);
  const [bulkAction, setBulkAction] = useState<{ kind: "delete" | "move"; open: boolean }>({ kind: "move", open: false });
  const [targetCase, setTargetCase] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const detailElement = useRef<HTMLElement>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const caseOptions = useMemo(() => [...new Map(sources.map((source) => [source.caseId, source.caseTitle])).entries()], [sources]);
  const resources = useMemo<Resource[]>(() => {
    const caseTitles = new Map(caseOptions);
    return [
      ...library.sources.map((source) => ({ key: `private:${source.id}`, title: source.name, caseId: source.caseId ?? "", group: caseTitles.get(source.caseId ?? "") ?? "Unassigned", type: source.mimeType, date: source.createdAt, status: uploadStateLabels[source.state], privateSource: source })),
      ...sources.map((source) => ({ key: `corpus:${source.versionId}`, title: source.title, caseId: source.caseId, group: source.caseTitle, type: source.mimeType, date: source.statedDate ?? "", status: source.availability === "available" ? indexStatus?.[source.versionId] === "indexed" ? "Indexed" : indexStatus?.[source.versionId] === "partial" ? "Partially indexed" : indexStatus?.[source.versionId] === "pending" ? "Not indexed" : "Index unconfirmed" : source.availability === "incomplete" ? "Needs review" : "Unavailable", corpusSource: source })),
    ];
  }, [sources, library.sources, indexStatus, caseOptions]);
  const filtered = resources.filter((source) => (!space || Boolean(source.privateSource) === (space === "private")) && (!caseId || source.caseId === caseId) && (!type || fileLabel(source.type) === type) && (!status || source.status === status)
    && `${source.title} ${source.group} ${source.corpusSource?.versionId ?? ""} ${source.privateSource?.sourceUrl ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : sort === "oldest" ? a.date.localeCompare(b.date) || a.title.localeCompare(b.title) : b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const current = resources.find((source) => source.key === selected) ?? null;
  const checkedResources = resources.filter((source) => checked.includes(source.key));
  const allPrivate = checkedResources.length > 0 && checkedResources.every((source) => source.privateSource);
  const reset = () => { setQuery(""); setSpace(""); setCaseId(""); setType(""); setStatus(""); };
  const activeFilters = Boolean(query || space || caseId || type || status);
  const select = (key: string, nextTab: Tab = "Overview") => { setSelected(key); setTab(nextTab); };
  const close = () => {
    const key = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      const row = key ? document.querySelector<HTMLButtonElement>(`[data-source-key="${CSS.escape(key)}"]`) : null;
      (row ?? libraryHeading.current)?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (focusedId) { setSelected(`private:${focusedId}`); setTab("Overview"); setFocusedId(null); }
  }, [focusedId, setFocusedId]);
  useEffect(() => {
    if (current) {
      detailElement.current?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1199px)").matches) detailElement.current?.scrollIntoView({ block: "start" });
    }
  }, [current?.key]);
  if (checkedResources.length !== checked.length) setChecked(checkedResources.map((source) => source.key));
  if (selected && !current) setSelected(null);
  async function runBulk() {
    if (!allPrivate || busy) return;
    setBusy(true); setActionError(null);
    try {
      for (const resource of checkedResources) {
        if (bulkAction.kind === "delete") await library.remove(resource.privateSource!.id);
        else await library.update(resource.privateSource!.id, { caseId: targetCase || null });
        setChecked((items) => items.filter((key) => key !== resource.key));
      }
      setBulkAction((current) => ({ ...current, open: false }));
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : "The action could not be completed. Completed changes were retained."); }
    finally { setBusy(false); }
  }
  return <section className={`sources-workspace${current ? " has-source" : ""}`} aria-label="Source library"
    onPointerDownCapture={() => setPointerMotion(true)}
    onClickCapture={(event) => setPointerMotion(event.detail > 0)}
    onKeyDownCapture={() => setPointerMotion(false)}>
    <div className="sources-collection">
      <header className="sources-heading"><div><h1 id="sources-title" ref={libraryHeading} tabIndex={-1}>Sources</h1><p>Find, manage, and explore your source documents.</p></div>
        <Button className="primary-button sources-add" onClick={() => setShowUpload(true)}><Icon name="add" />Add source</Button></header>
      <div className="sources-toolbar" role="search" aria-label="Filter sources">
        <label className="sources-query"><Icon name="search" /><span className="visually-hidden">Search sources</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sources or case names…" /></label>
        <label><span className="visually-hidden">Space</span><select aria-label="Space" value={space} onChange={(event) => setSpace(event.target.value)}><option value="">All spaces</option><option value="public">Public corpus</option><option value="private">Private uploads</option></select></label>
        <label><span className="visually-hidden">Case</span><select aria-label="Case" value={caseId} onChange={(event) => setCaseId(event.target.value)}><option value="">All cases</option>{caseOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
        <label><span className="visually-hidden">File type</span><select aria-label="File type" value={type} onChange={(event) => setType(event.target.value)}><option value="">File type</option>{[...new Set(resources.map((source) => fileLabel(source.type)))].sort().map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span className="visually-hidden">Processing status</span><select aria-label="Processing status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Status</option>{[...new Set(resources.map((source) => source.status))].sort().map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="sources-sort"><span className="visually-hidden">Sort sources</span><select aria-label="Sort sources" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">Most recent</option><option value="oldest">Oldest first</option><option value="name">Title A–Z</option></select></label>
        <button className="text-button sources-reset" type="button" disabled={!activeFilters} onClick={reset}>Reset filters</button>
      </div>
      {library.error && <p className="notice notice-error" role="alert">{library.error} <button className="text-button" onClick={() => void library.refresh()}>Refresh</button></p>}
      {error && <p className="notice notice-error" role="alert">The public source inventory could not be verified. Reload to try again. Private files remain separate.</p>}
      <div className="sources-list-summary"><span role="status">{loading ? "Loading public sources…" : `${filtered.length} of ${resources.length} sources`}</span><span>Indexing is not evidence approval</span></div>
      {checkedResources.length > 0 && <div className="sources-selection"><strong>{checkedResources.length} selected</strong><button className="text-button" onClick={() => setChecked([])}>Clear selection</button><button className="secondary-button" disabled={!allPrivate} onClick={() => { setBulkAction({ kind: "move", open: true }); setActionError(null); }}>Move to case</button><button className="secondary-button source-danger" disabled={!allPrivate} onClick={() => { setBulkAction({ kind: "delete", open: true }); setActionError(null); }}>Delete</button>{!allPrivate && <small>Public corpus sources are read-only.</small>}</div>}
      <div className="sources-table-wrap"><table className="sources-table"><caption className="visually-hidden">Source documents</caption><thead><tr>
        <th className="source-check"><input aria-label="Select all visible sources" type="checkbox" checked={filtered.length > 0 && filtered.every((source) => checked.includes(source.key))} ref={(element) => { if (element) element.indeterminate = filtered.some((source) => checked.includes(source.key)) && !filtered.every((source) => checked.includes(source.key)); }} onChange={(event) => setChecked(event.target.checked ? [...new Set([...checked, ...filtered.map((source) => source.key)])] : checked.filter((key) => !filtered.some((source) => source.key === key)))} /></th>
        <th scope="col" className="source-title-cell" aria-sort={sort === "name" ? "ascending" : "none"}><button onClick={() => setSort(sort === "name" ? "recent" : "name")}>Title <Icon name="sort" /></button></th><th scope="col" className="source-case-cell">Case / Space</th><th scope="col" className="source-type-cell">Type</th><th scope="col" className="source-date-cell" aria-sort={sort === "recent" ? "descending" : sort === "oldest" ? "ascending" : "none"}><button onClick={() => setSort(sort === "recent" ? "oldest" : "recent")}>Date <Icon name="sort" /></button></th><th scope="col" className="source-status-cell">Status</th><th scope="col" className="source-visibility-cell">Visibility</th><th className="source-menu-cell"><span className="visually-hidden">Actions</span></th>
      </tr></thead><tbody>{filtered.map((resource) => <tr key={resource.key} data-selected={selected === resource.key || undefined}>
        <td className="source-check"><input type="checkbox" aria-label={`Select ${resource.title}`} checked={checked.includes(resource.key)} onChange={(event) => setChecked(event.target.checked ? [...checked, resource.key] : checked.filter((key) => key !== resource.key))} /></td>
        <td className="source-title-cell"><button className="source-title-button" data-source-key={resource.key} aria-pressed={selected === resource.key} onClick={() => select(resource.key)}><FileIcon type={resource.type} /><span><strong>{resource.title}</strong><small>{resource.privateSource?.sourceUrl ?? resource.privateSource?.name ?? resource.corpusSource!.versionId}</small><span className="source-mobile-meta">{dateLabel(resource.date)} · {resource.privateSource ? "Private" : "Public · fictional"}</span></span></button></td>
        <td className="source-case-cell"><span>{resource.group}</span><small>{resource.privateSource ? "Private sources" : "Fictional case library"}</small></td><td className="source-type-cell">{fileLabel(resource.type)}</td><td className="source-date-cell"><time dateTime={resource.date || undefined}>{dateLabel(resource.date)}</time><small>{resource.privateSource ? "This browser" : "Source-stated date"}</small></td>
        <td className="source-status-cell"><Status value={resource.status} />{["Pending", "Extracting", "Indexing"].includes(resource.status) && <progress aria-label={`${resource.title}: ${resource.status}`} />}</td><td className="source-visibility-cell"><Visibility privateSource={Boolean(resource.privateSource)} /></td>
        <td className="source-menu-cell"><details className="source-row-menu"><summary aria-label={`Actions for ${resource.title}`}><Icon name="more" /></summary><div><button onClick={() => select(resource.key, "Content")}>Open content</button>{resource.privateSource && <><button onClick={() => void library.download(resource.privateSource!)}>Download original</button><button onClick={() => select(resource.key, "Notes")}>Edit notes</button></>}{resource.corpusSource?.availability === "available" && <a href={`/api/evidence/originals/${encodeURIComponent(resource.corpusSource.versionId)}`}>Download original</a>}</div></details></td>
      </tr>)}</tbody></table></div>
      {filtered.length === 0 && !loading && <div className="sources-empty"><Icon name="search" /><h2>{activeFilters ? "No sources found" : "Your library starts here"}</h2><p>{activeFilters ? "Try a different search or clear your filters." : "Add a private file or webpage to inspect its content alongside the public fictional library."}</p><button className="secondary-button" onClick={activeFilters ? reset : () => setShowUpload(true)}>{activeFilters ? "Reset filters" : "Add source"}</button></div>}
      <footer className="sources-library-footer"><Icon name="lock" /><p>Private files and webpages stay separate from the public corpus. Access is through this browser and expires after seven days.</p></footer>
    </div>
    {current && <aside className="source-detail-panel" ref={detailElement} tabIndex={-1} aria-label="Source details" onKeyDown={(event) => { if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement)) { event.stopPropagation(); close(); } }}><SourceDetail key={current.key} resource={current} sources={sources} caseOptions={caseOptions} tab={tab} setTab={setTab} inspect={inspect} close={close} select={select} pointerMotion={pointerMotion} /></aside>}
    <Dialog.Root open={showUpload} onOpenChange={setShowUpload}><Dialog.Portal className="source-dialog-portal" data-pointer-motion={pointerMotion || undefined}><Dialog.Backdrop className="evidence-backdrop" /><Dialog.Popup className="source-upload-dialog"><div className="source-modal-heading"><Dialog.Title>Add source</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close upload"><Icon name="close" /></Dialog.Close></div><Dialog.Description className="field-hint">Add a file or public URL to your private, seven-day browser library.</Dialog.Description><UploadPicker /><div className="source-upload-receipts">{library.sources.slice(0, 5).map((source) => <div key={source.id}><FileIcon type={source.mimeType} /><span>{source.name}<small>{(source.size / 1024).toFixed(1)} KiB</small></span><Status value={uploadStateLabels[source.state]} /></div>)}</div></Dialog.Popup></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={bulkAction.open} onOpenChange={(open) => { if (!open && !busy) setBulkAction((current) => ({ ...current, open: false })); }}><Dialog.Portal className="source-dialog-portal" data-pointer-motion={pointerMotion || undefined}><Dialog.Backdrop className="evidence-backdrop" /><Dialog.Popup className="source-upload-dialog"><Dialog.Title>{bulkAction.kind === "delete" ? "Delete selected sources?" : "Move selected sources to a case"}</Dialog.Title><Dialog.Description>{bulkAction.kind === "delete" ? "Originals, extracted text, and notes will be removed. Existing downloaded copies and submitted requests are not deleted." : "This organizes private uploads only. It does not publish them or turn them into checked historical evidence."}</Dialog.Description>{bulkAction.kind === "move" && <label className="source-form-field">Case<select value={targetCase} onChange={(event) => setTargetCase(event.target.value)}><option value="">Unassigned</option>{caseOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>}{actionError && <p className="notice notice-error" role="alert">{actionError}</p>}<div className="source-modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setBulkAction((current) => ({ ...current, open: false }))}>Cancel</button><button className={bulkAction.kind === "delete" ? "secondary-button source-danger" : "primary-button"} disabled={busy || !allPrivate} onClick={() => void runBulk()}>{busy ? "Working…" : bulkAction.kind === "delete" ? "Delete sources" : "Move sources"}</button></div></Dialog.Popup></Dialog.Portal></Dialog.Root>
    <details className="sources-search-disclosure"><summary>Search private source content by meaning</summary><PrivateSourceSearch onSelect={(id) => select(`private:${id}`, "Content")} /></details>
  </section>;
}

function SourceDetail({ resource, sources, caseOptions, tab, setTab, inspect, close, select, pointerMotion }: { resource: Resource; sources: SourceCatalogEntry[]; caseOptions: [string, string][]; tab: Tab; setTab: (tab: Tab) => void; inspect: (ref: SourceRef) => void; close: () => void; select: (key: string, tab?: Tab) => void; pointerMotion: boolean }) {
  const library = usePrivateUploads();
  const { detail: loadDetail, token } = library;
  const [detail, setDetail] = useState<PrivateSourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "move" | "delete"; open: boolean }>({ kind: "move", open: false });
  const [targetCase, setTargetCase] = useState("");
  const [notes, setNotes] = useState(resource.privateSource?.notes ?? "");
  const [notesBase, setNotesBase] = useState(resource.privateSource?.notes ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [documentQuery, setDocumentQuery] = useState("");
  const tabId = useId();
  const privateSource = resource.privateSource;
  const corpusSource = resource.corpusSource;
  const processing = ["Extracting", "Indexing"].includes(resource.status);
  const activityRows = useMemo(() => {
    const occurrences = new Map<string, number>();
    return (privateSource?.activity ?? []).map((event) => {
      const identity = JSON.stringify([event.at, event.state, event.message]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { event, key: `${identity}:${occurrence}` };
    });
  }, [privateSource?.activity]);
  const savedNotes = privateSource?.notes ?? "";
  const notesConflict = savedNotes !== notesBase && notes !== savedNotes;
  if (savedNotes !== notesBase && (notes === notesBase || notes === savedNotes)) {
    setNotes(savedNotes);
    setNotesBase(savedNotes);
  }
  useEffect(() => {
    setDetail(null); setError(null);
    if (!privateSource) return;
    const controller = new AbortController();
    void loadDetail(privateSource.id, controller.signal).then((source) => { if (!controller.signal.aborted) setDetail(source); }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Content could not be retrieved."); });
    return () => controller.abort();
  }, [privateSource?.id, privateSource?.updatedAt, privateSource?.state, loadDetail, token]);
  const related = sources.filter((source) => source.caseId === resource.caseId && source.versionId !== corpusSource?.versionId);
  async function save(changes: { notes?: string; caseId?: string | null }) {
    if (!privateSource || busy) return;
    setBusy(true); setError(null); setSaved(false);
    try { await library.update(privateSource.id, changes.notes !== undefined ? { ...changes, previousNotes: notesBase } : changes); if (changes.notes !== undefined) setNotesBase(changes.notes); setAction((current) => ({ ...current, open: false })); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Your changes could not be saved."); }
    finally { setBusy(false); }
  }
  const openContent = () => setTab("Content");
  return <>
    <header className="source-detail-heading"><FileIcon type={resource.type} /><div><h2>{resource.title}</h2><p>{privateSource?.sourceUrl ?? privateSource?.name ?? corpusSource!.versionId}</p></div><button className="icon-button" aria-label="Close source details" onClick={close}><Icon name="close" /></button></header>
    <div className="source-detail-actions"><button className="secondary-button" onClick={privateSource ? privateSource.mimeType === "text/html" ? () => setTab("Content") : () => void library.download(privateSource, true) : openContent} disabled={Boolean(corpusSource && corpusSource.availability !== "available")}><Icon name="open" />{privateSource?.mimeType === "text/html" ? "Open content" : "Open"}</button>{privateSource ? <button className="secondary-button" onClick={() => void library.download(privateSource)}><Icon name="download" />Download</button> : corpusSource!.availability === "available" && <a className="secondary-button" href={`/api/evidence/originals/${encodeURIComponent(corpusSource!.versionId)}`}><Icon name="download" />Download</a>}</div>
    <div className="source-detail-tabs" role="tablist" aria-label="Source detail sections">{tabs.map((name, index) => <button role="tab" key={name} id={`${tabId}-${name}`} aria-controls={`${tabId}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={(event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); setTab(tabs[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus(); }
    }}>{name}</button>)}</div>
    <div className="source-detail-body" data-reading={tab === "Content" || undefined} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {tab === "Overview" && <>
        <section className="source-about"><h3>About this source</h3><p>{privateSource ? `A private ${privateSource.sourceUrl ? "webpage capture" : "upload"} for new-client context. Review the extracted content against the original before using it in Ask.` : `Retained source material from ${resource.group}. This is a fictional case document, not a checked recommendation.`}</p></section>
        <dl className="source-overview-grid"><div><dt>{privateSource ? "Original filename" : "Retained version"}</dt><dd>{privateSource?.name ?? corpusSource!.versionId}</dd></div><div><dt>File type</dt><dd>{fileLabel(resource.type)}{privateSource ? ` · ${(privateSource.size / 1024).toFixed(1)} KiB` : ""}</dd></div><div><dt>Case / Space</dt><dd>{resource.group}<small>{privateSource ? "Private upload · not published" : "Public fictional corpus"}</small></dd></div><div><dt>Processing status</dt><dd><Status value={resource.status} /><small>Searchability is not evidence approval.</small></dd></div><div><dt>{privateSource ? "Added" : "Source-stated date"}</dt><dd>{dateLabel(resource.date)}<small>{privateSource ? "By this browser" : "Not an upload timestamp"}</small></dd></div><div><dt>{privateSource ? "Index chunks" : "Passages"}</dt><dd>{privateSource ? privateSource.chunkCount : `${corpusSource!.passages.length} exact passages`}</dd></div><div><dt>{privateSource ? "Extraction" : "Source access"}</dt><dd>{privateSource ? privateSource.hasText ? privateSource.textKind.replaceAll("_", " ") : "Not ready" : corpusSource!.availability}<small>{privateSource ? "Not audited" : "Exact-original integrity is checked"}</small></dd></div><div><dt>Visibility</dt><dd><Visibility privateSource={Boolean(privateSource)} /><small>{privateSource ? `This browser only · expires ${dateLabel(privateSource.expiresAt)}` : "Fictional examples, not real client records"}</small></dd></div></dl>
        {privateSource?.sourceUrl && <p className="source-source-url">Source URL: <a href={privateSource.sourceUrl} target="_blank" rel="noreferrer">{privateSource.sourceUrl}</a></p>}
        {privateSource?.warning && <p className="notice notice-warning">{privateSource.warning}</p>}{privateSource?.error && <p className="notice notice-error">{privateSource.error}</p>}
        {corpusSource && corpusSource.availability !== "available" && <p className="notice notice-warning">{corpusSource.exclusionReasons.join(" ")}</p>}
        <div className="source-action-row">{privateSource ? <><button className="secondary-button" onClick={() => setTab("Notes")}><Icon name="note" />{privateSource.notes ? "Edit notes" : "Add note"}</button><button className="secondary-button" disabled={processing} onClick={() => { setTargetCase(resource.caseId); setAction({ kind: "move", open: true }); }}><Icon name="move" />Move to case</button><button className="secondary-button source-danger" onClick={() => setAction({ kind: "delete", open: true })}><Icon name="delete" />Delete source</button>{["Pending", "Failed", "Needs review"].includes(resource.status) && <button className="secondary-button" onClick={() => void library.process(privateSource.id)}>Process again</button>}</> : <button className="secondary-button" onClick={openContent} disabled={corpusSource!.availability !== "available"}>Read exact passages</button>}</div>
      </>}
      {tab === "Content" && (privateSource ? detail ? detail.text ? <><p className="source-reading-note">{detail.textKind.replaceAll("_", " ")} · Unreviewed client context, not checked evidence.</p><label className="source-document-search"><Icon name="search" /><span className="visually-hidden">Search in this document</span><input type="search" placeholder="Search in this document…" value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} /></label><article className="source-private-content">{documentQuery && !detail.text.toLocaleLowerCase().includes(documentQuery.toLocaleLowerCase()) ? <p role="status">No matching text in this document.</p> : <pre><Highlight text={detail.text} query={documentQuery} /></pre>}</article><a className="primary-button source-use-ask" href="/" onClick={() => window.dispatchEvent(new CustomEvent("memory-bank:attach-source", { detail: privateSource.id }))}>Use reviewed text in Ask</a></> : <p>Extracted content is not ready. The exact original remains available; inspect its status in Overview.</p> : !error && <p role="status">Loading private content…</p> : <CorpusReader source={corpusSource!} inspect={inspect} />)}
      {tab === "Related" && <><p className="source-reading-note">Other retained sources in this case—not a semantic relevance or evidence-approval claim.</p>{related.length ? <ul className="source-related-list">{related.map((source) => <li key={source.versionId}><button onClick={() => select(`corpus:${source.versionId}`)}><FileIcon type={source.mimeType} /><span><strong>{source.title}</strong><small>{source.versionId}</small></span><Icon name="right" /></button></li>)}</ul> : <p>No related sources have been established{privateSource && !privateSource.caseId ? ". Assign a case to organize this private file alongside its public case documents." : "."}</p>}</>}
      {tab === "Notes" && (privateSource ? <form className="source-notes-form" onSubmit={(event) => { event.preventDefault(); void save({ notes }); }}><label htmlFor={`${tabId}-notes`}>Private source notes</label><p className="field-hint">Notes share this source’s access and expiry. They are not evidence and are not sent to Ask.</p><textarea id={`${tabId}-notes`} maxLength={4000} value={notes} onChange={(event) => { setNotes(event.target.value); setSaved(false); }} placeholder="Add context, questions, or things to review…" />{notesConflict && <p className="notice notice-warning" role="alert">These notes changed in another tab. Your draft has been kept. Copy it before loading the newer saved notes. <button className="text-button" type="button" onClick={() => { setNotes(savedNotes); setNotesBase(savedNotes); }}>Load latest notes</button></p>}<div><small>{notes.length} / 4,000</small><button className="primary-button" type="submit" disabled={busy || processing || notesConflict || notes === privateSource.notes}>{busy ? "Saving…" : "Save notes"}</button></div>{processing && <p className="field-hint">Notes can be saved once processing finishes.</p>}{saved && <p role="status">Notes saved.</p>}</form> : <p>Public corpus documents are read-only. Notes and case assignment are available for your private sources.</p>)}
      {tab === "Activity" && (privateSource ? <ol className="source-activity-list">{activityRows.map(({ event, key }) => <li key={key}><strong>{uploadStateLabels[event.state]}</strong><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><p>{event.message}</p></li>)}</ol> : <><h3>Retained source version</h3><p>{corpusSource!.versionId}</p><p className="field-hint">Source-stated date: {dateLabel(resource.date)}. No upload, author, or processing history is inferred for this curated document.</p><Status value={resource.status} /></>)}
    </div>
    <Dialog.Root open={action.open} onOpenChange={(open) => { if (!open && !busy) setAction((current) => ({ ...current, open: false })); }}><Dialog.Portal className="source-dialog-portal" data-pointer-motion={pointerMotion || undefined}><Dialog.Backdrop className="evidence-backdrop" /><Dialog.Popup className="source-upload-dialog"><Dialog.Title>{action.kind === "delete" ? "Delete this source?" : "Move to case"}</Dialog.Title><Dialog.Description>{action.kind === "delete" ? `Remove ${resource.title}, its extracted content, and notes. Downloaded copies and previously submitted requests are not deleted.` : "Organize this private file under a case. It stays private and does not become historical evidence."}</Dialog.Description>{action.kind === "move" && <label className="source-form-field">Case<select value={targetCase} onChange={(event) => setTargetCase(event.target.value)}><option value="">Unassigned</option>{caseOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>}{error && <p className="notice notice-error" role="alert">{error}</p>}<div className="source-modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setAction((current) => ({ ...current, open: false }))}>Cancel</button><button className={action.kind === "delete" ? "secondary-button source-danger" : "primary-button"} disabled={busy} onClick={() => {
      if (action.kind === "move") void save({ caseId: targetCase || null });
      else if (privateSource) { setBusy(true); setError(null); void library.remove(privateSource.id).then(close).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "The source could not be deleted.")).finally(() => setBusy(false)); }
    }}>{busy ? "Working…" : action.kind === "delete" ? "Delete source" : "Move source"}</button></div></Dialog.Popup></Dialog.Portal></Dialog.Root>
  </>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const parts: ReactNode[] = [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(start, match.index), <mark key={match.index}>{match[0]}</mark>);
    start = match.index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}
function CorpusReader({ source, inspect }: { source: SourceCatalogEntry; inspect: (ref: SourceRef) => void }) {
  const [passages, setPassages] = useState<PassageView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  useEffect(() => {
    if (source.availability !== "available") return;
    setPassages(null); setError(null);
    const controller = new AbortController();
    void Promise.all(source.passages.map(async (ref) => {
      const response = await fetch(`/api/evidence/passages/${encodeURIComponent(ref.passageId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error("A retained passage could not be loaded. The reader has not substituted another source.");
      const body: unknown = await response.json();
      if (!isPassage(body, ref) || body.sourceKind !== ref.sourceKind) throw new Error("A passage did not match this exact source version; its content was withheld.");
      return body;
    })).then((items) => { if (!controller.signal.aborted) { setPassages(items); setSelected(items[0]?.passageId ?? ""); } }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Passages are unavailable."); });
    return () => controller.abort();
  }, [source.versionId, source.availability, source.passages]);
  const matches = passages?.filter((passage) => `${passage.excerpt} ${passage.passageId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const current = matches.find((passage) => passage.passageId === selected) ?? matches[0];
  const index = current ? matches.indexOf(current) : -1;
  if (source.availability !== "available") return <p className="notice notice-warning">{source.exclusionReasons.join(" ") || "This source is unavailable for inspection."}</p>;
  if (error) return <p className="notice notice-error" role="alert">{error}</p>;
  if (!passages) return <p role="status">Loading exact retained passages…</p>;
  return <div className="source-reader"><div className="source-reader-toolbar"><label className="source-document-search"><Icon name="search" /><span className="visually-hidden">Search in this document</span><input type="search" placeholder="Search in this document…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="source-reader-pagination"><button className="icon-button" aria-label="Previous passage" disabled={index <= 0} onClick={() => setSelected(matches[index - 1].passageId)}><Icon name="left" /></button><span role="status">{index + 1} / {matches.length}</span><button className="icon-button" aria-label="Next passage" disabled={index < 0 || index >= matches.length - 1} onClick={() => setSelected(matches[index + 1].passageId)}><Icon name="right" /></button></div></div><div className="source-reader-layout"><nav aria-label="Document passages"><h3>Passages</h3>{matches.map((passage, passageIndex) => <button key={passage.passageId} aria-current={current?.passageId === passage.passageId ? "true" : undefined} onClick={() => setSelected(passage.passageId)}><span>{typeof passage.location.section === "string" ? passage.location.section : `Passage ${passageIndex + 1}`}</span><small>{typeof passage.location.page === "number" ? `p. ${passage.location.page}` : passageIndex + 1}</small></button>)}</nav>{current ? <article className="source-reader-document"><div className="source-reader-document-heading"><h3>{current.title}</h3><span>{current.sourceKind.replaceAll("_", " ")}</span></div><p className="source-reading-note">Fictional source · exact retained passage, not a generated summary</p><blockquote><Highlight text={current.excerpt} query={query} /></blockquote><dl className="source-location">{Object.entries(current.location).map(([name, value]) => <div key={name}><dt>{name.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{Array.isArray(value) ? value.join(", ") : value === null ? "Not stated" : String(value)}</dd></div>)}</dl><button className="secondary-button" onClick={() => inspect(current)}>Inspect exact passage</button></article> : <p className="sources-reader-empty" role="status">{query ? "No matching passages. Try another phrase." : "No inspectable passages are retained."}</p>}</div></div>;
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
  const visibleResults = results?.filter((item) => library.sources.some((source) => source.id === item.sourceId && Date.parse(source.expiresAt) > Date.now())) ?? null;
  if (!library.sources.length) return <p className="field-hint">Add private sources and wait for confirmed indexing to search their content by meaning.</p>;
  return <form className="private-source-search" aria-label="Search private source content" onSubmit={async (event) => {
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
  }}><p className="field-hint">On submit, Cloudflare Workers AI embeds this query and searches this browser’s private namespace. Similarity is not a checked recommendation.</p><div className="source-semantic-controls"><label>Private search<input type="search" value={query} maxLength={1024} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Describe what you need…" /></label><Button className="secondary-button" type="submit" disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search private sources"}</Button></div>{error && <p className="notice notice-error" role="alert">{error}</p>}{visibleResults && <div role="status">{visibleResults.length} private passage matches</div>}{visibleResults?.map((result) => <article className="private-search-match" key={`${result.sourceId}-${result.chunk}`}><button type="button" className="text-button" onClick={() => onSelect(result.sourceId)}>{result.name} · chunk {result.chunk + 1}</button><blockquote>{result.excerpt}</blockquote></article>)}</form>;
}

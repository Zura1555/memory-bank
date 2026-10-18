import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { Drawer } from "@base-ui/react/drawer";
import { NavigationMenu } from "@base-ui/react/navigation-menu";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import FolderLibraryIcon from "@hugeicons/core-free-icons/FolderLibraryIcon";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";

type Page = "ask" | "sources" | "knowledge";
const destinations: { page: Page; href: string; label: string; detail: string; icon: IconSvgElement }[] = [
  { page: "ask", href: "/", label: "Ask", detail: "Work brief builder", icon: Message01Icon },
  { page: "sources", href: "/?sources", label: "Sources", detail: "Corpus & private files", icon: FolderLibraryIcon },
  { page: "knowledge", href: "/?knowledge", label: "Reviewed knowledge", detail: "Decisions & lessons", icon: BookOpen01Icon },
];

function locationView() {
  const query = new URLSearchParams(window.location.search);
  return query.has("knowledge")
    ? { page: "knowledge" as Page, recordId: query.get("knowledge") || undefined }
    : { page: query.has("sources") ? "sources" as Page : "ask" as Page, recordId: undefined };
}

function Navigation({ page }: { page: Page }) {
  return <NavigationMenu.Root orientation="vertical" aria-label="Primary navigation" className="primary-nav">
    <NavigationMenu.List className="primary-nav-list">
      {destinations.map((item) => <NavigationMenu.Item key={item.page}>
        <NavigationMenu.Link href={item.href} active={page === item.page} aria-current={page === item.page ? "page" : undefined} className="nav-link">
          <HugeiconsIcon icon={item.icon} size={22} strokeWidth={1.5} aria-hidden="true" focusable="false" />
          <span><span className="nav-label">{item.label}</span><span className="nav-detail">{item.detail}</span></span>
        </NavigationMenu.Link>
      </NavigationMenu.Item>)}
    </NavigationMenu.List>
  </NavigationMenu.Root>;
}

export function AppShell({ ask, sources, knowledge }: {
  ask: (active: boolean) => ReactNode;
  sources: ReactNode;
  knowledge: (recordId?: string) => ReactNode;
}) {
  const [view, setView] = useState(locationView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const navigating = useRef(false);
  const previousLocation = useRef(window.location.href);

  useEffect(() => {
    function update() {
      navigating.current = true;
      setDrawerOpen(false);
      setView(locationView());
    }
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  useEffect(() => {
    document.title = `${destinations.find((item) => item.page === view.page)!.label} — Memory Bank`;
    if (previousLocation.current !== window.location.href) {
      previousLocation.current = window.location.href;
      main.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }, [view]);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (wide.matches) { navigating.current = true; setDrawerOpen(false); } };
    wide.addEventListener("change", closeOnDesktop);
    return () => wide.removeEventListener("change", closeOnDesktop);
  }, []);

  function navigate(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href);
    if (url.origin !== window.location.origin || url.pathname !== "/" || url.hash
      || [...url.searchParams.keys()].some((key) => key !== "knowledge" && key !== "sources")) return;
    event.preventDefault();
    navigating.current = true;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setView(locationView());
    setDrawerOpen(false);
  }

  const brand = <a href="/" className="brand" aria-label="Memory Bank home"><span className="brand-mark" aria-hidden="true">M</span></a>;
  return <div className="app-shell" onClick={navigate}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="app-sidebar" aria-label="Workspace sidebar">
      {brand}
      <Navigation page={view.page} />
    </aside>
    <div className="app-body">
      <header className="app-header">
        <div className="header-location">
          <Drawer.Root open={drawerOpen} onOpenChange={(open) => { if (open) navigating.current = false; setDrawerOpen(open); }}
            onOpenChangeComplete={(open) => { if (!open && navigating.current) main.current?.focus({ preventScroll: true }); }} swipeDirection="left">
            <Drawer.Trigger render={<Button className="icon-button mobile-nav-trigger" aria-label="Open navigation" />}>
              <HugeiconsIcon icon={Menu01Icon} size={22} strokeWidth={1.5} aria-hidden="true" focusable="false" />
            </Drawer.Trigger>
            <Drawer.Portal>
              <Drawer.Backdrop className="navigation-backdrop" />
              <Drawer.Viewport className="navigation-viewport">
                <Drawer.Popup className="navigation-drawer" finalFocus={() => navigating.current ? false : true}>
                  <Drawer.Content>
                    <div className="drawer-heading"><Drawer.Title className="drawer-title">Memory Bank</Drawer.Title><Drawer.Close render={<Button className="icon-button" aria-label="Close navigation" />}>Close</Drawer.Close></div>
                    <Drawer.Description className="muted">Evidence Workbench</Drawer.Description>
                    <Navigation page={view.page} />
                    <p className="drawer-disclaimer">Fictional evidence · checked before use</p>
                  </Drawer.Content>
                </Drawer.Popup>
              </Drawer.Viewport>
            </Drawer.Portal>
          </Drawer.Root>
          <span className="header-workspace">Workspace <span aria-hidden="true">/</span></span>
          <span className="header-page">{destinations.find((item) => item.page === view.page)!.label}</span>
        </div>
        <span className="fictional-banner">Fictional examples</span>
      </header>
      <main id="main-content" ref={main} tabIndex={-1}>
        <div hidden={view.page !== "ask"}>{ask(view.page === "ask")}</div>
        {view.page === "sources" && sources}
        {view.page === "knowledge" && knowledge(view.recordId)}
      </main>
      <footer className="app-footer"><span>Memory Bank</span><span>Fictional evidence · checked before use</span></footer>
    </div>
  </div>;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  allCategories,
  catalogDocument,
  formatDate,
  formatMetric,
  matchesPack,
  packHref,
  packLabel,
  type CatalogPack,
  type VerificationStatus,
} from "../lib/catalog";

const categoryLabels: Record<string, string> = {
  "browser-automation": "Browser automation",
  communication: "Communication",
  data: "Data",
  "developer-tools": "Developer tools",
  operations: "Operations",
  quality: "Quality",
};

const categoryMarks: Record<string, string> = {
  "browser-automation": "↗",
  communication: "◎",
  data: "≋",
  "developer-tools": "{ }",
  operations: "⌁",
  quality: "✓",
};

function verificationLabel(status: VerificationStatus): string {
  if (status === "verified") return "AART verified";
  if (status === "community") return "Community reviewed";
  return "Unverified";
}

function VerificationBadge({ status = "unverified" }: { status?: VerificationStatus }) {
  return (
    <span className={`verification verification--${status}`}>
      <span aria-hidden="true">{status === "verified" ? "◆" : status === "community" ? "◇" : "○"}</span>
      {verificationLabel(status)}
    </span>
  );
}

function Header() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AART Pack Library home">
        <span className="brand-mark">A</span>
        <span>
          <strong>AART</strong>
          <small>Pack Library</small>
        </span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/#packs">Explore</Link>
        <Link href="/#categories">Categories</Link>
        <Link href="/#publish">Publish</Link>
      </nav>
      <div className="header-actions">
        <Link className="text-link" href="/#trust">How trust works</Link>
        <Link className="button button--small" href="/#publish">Build a Pack</Link>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="brand brand--footer">
        <span className="brand-mark">A</span>
        <span><strong>AART</strong><small>Pack Library</small></span>
      </div>
      <p>Reusable automation, with the evidence attached.</p>
      <div>
        <Link href="/#packs">Explore</Link>
        <Link href="/#trust">Trust model</Link>
        <Link href="/#publish">Publish</Link>
      </div>
    </footer>
  );
}

function PackCard({ pack, index }: { pack: CatalogPack; index: number }) {
  const workflows = pack.workflows ?? [];
  const category = pack.categories?.[0] ?? "community";
  return (
    <Link className="pack-card" href={packHref(pack)} style={{ "--delay": `${index * 45}ms` } as React.CSSProperties}>
      <div className="pack-card__top">
        <span className="pack-glyph" aria-hidden="true">{categoryMarks[category] ?? "◫"}</span>
        <VerificationBadge status={pack.verification?.status} />
      </div>
      <div>
        <p className="eyebrow">{pack.npmPackageName}</p>
        <h3>{packLabel(pack)}</h3>
        <p className="pack-description">{pack.description}</p>
      </div>
      <div className="tag-list" aria-label="Categories">
        {(pack.categories ?? []).slice(0, 2).map((item) => <span key={item}>{categoryLabels[item] ?? item}</span>)}
      </div>
      <div className="pack-card__meta">
        <span><strong>{pack.blocks.length}</strong> Blocks</span>
        <span><strong>{workflows.length}</strong> Workflows</span>
        <span><strong>{formatMetric(pack.stats?.reuses)}</strong> reuses</span>
      </div>
      <div className="pack-card__footer">
        <span>by {pack.author?.name ?? "Community"}</span>
        <span>v{pack.version} →</span>
      </div>
    </Link>
  );
}

function TrustStrip() {
  return (
    <section className="trust-strip" id="trust">
      <div>
        <span className="section-index">01</span>
        <p className="eyebrow">Install is not trust</p>
        <h2>Inspect first.<br />Approve on your terms.</h2>
      </div>
      <ol>
        <li><span>1</span><div><strong>Download inertly</strong><p>No lifecycle scripts. No code runs during install.</p></div></li>
        <li><span>2</span><div><strong>Review the seal</strong><p>Capabilities, secrets and exact content hash stay visible.</p></div></li>
        <li><span>3</span><div><strong>Approve explicitly</strong><p>Only a human decision makes Pack code loadable.</p></div></li>
      </ol>
    </section>
  );
}

function HomeCatalog({ initialCategory }: { initialCategory?: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(initialCategory ?? "");
  const [showAll, setShowAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const packs = catalogDocument.packs;
  const categories = allCategories(packs);
  const filtered = useMemo(
    () => packs.filter((pack) => matchesPack(pack, query, category)),
    [packs, query, category],
  );
  const visible = showAll || query || category ? filtered : filtered.slice(0, 6);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Header />
      <main>
        <section className="hero">
          <div className="hero-grid" aria-hidden="true" />
          <div className="preview-notice">
            <span>Registry preview</span>
            The Packs below are representative fixtures until the production index opens.
          </div>
          <div className="hero-copy">
            <p className="eyebrow">The reusable layer for governed automation</p>
            <h1>Reuse work that<br /><em>already works.</em></h1>
            <p className="hero-lede">
              Search inspectable Blocks and complete Workflows before building another automation from scratch.
            </p>
          </div>
          <div className="search-shell">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <label className="sr-only" htmlFor="pack-search">Search Packs, Blocks and Workflows</label>
            <input
              ref={searchRef}
              id="pack-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="What do you want to automate?"
              autoComplete="off"
            />
            <kbd>/</kbd>
          </div>
          <div className="hero-stats">
            <span><strong>{packs.length}</strong> preview Packs</span>
            <span><strong>{packs.reduce((sum, pack) => sum + pack.blocks.length, 0)}</strong> Blocks</span>
            <span><strong>{packs.reduce((sum, pack) => sum + (pack.workflows?.length ?? 0), 0)}</strong> Workflows</span>
            <span><strong>100%</strong> inspectable</span>
          </div>
        </section>

        <section className="catalog-section" id="packs">
          <div className="section-heading">
            <div>
              <span className="section-index">02</span>
              <p className="eyebrow">{query || category ? "Search results" : "Explore the library"}</p>
              <h2>{query || category ? `${filtered.length} matching Packs` : "Start with proven pieces."}</h2>
            </div>
            {(query || category) && (
              <button className="clear-button" onClick={() => { setQuery(""); setCategory(""); }}>
                Clear filters
              </button>
            )}
          </div>
          <div className="category-pills" aria-label="Filter by category">
            <button className={!category ? "active" : ""} onClick={() => setCategory("")}>All</button>
            {categories.map((item) => (
              <button
                key={item.name}
                className={category === item.name ? "active" : ""}
                onClick={() => setCategory(category === item.name ? "" : item.name)}
              >
                {categoryLabels[item.name] ?? item.name}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          {visible.length > 0 ? (
            <div className="pack-grid">
              {visible.map((pack, index) => <PackCard key={`${pack.packName}@${pack.version}`} pack={pack} index={index} />)}
            </div>
          ) : (
            <div className="empty-result">
              <span>⌕</span>
              <h3>No Pack matches yet.</h3>
              <p>That is a useful signal: reuse failed before authoring began.</p>
              <button className="button" onClick={() => { setQuery(""); setCategory(""); }}>Browse every Pack</button>
            </div>
          )}
          {!showAll && !query && !category && filtered.length > 6 && (
            <button className="show-all" onClick={() => setShowAll(true)}>Show the full library <span>↓</span></button>
          )}
        </section>

        <section className="category-section" id="categories">
          <div className="section-heading">
            <div>
              <span className="section-index">03</span>
              <p className="eyebrow">Browse by outcome</p>
              <h2>Find the shape of work.</h2>
            </div>
            <p>Categories are deliberately about the job to be done—not the vendor carrying it.</p>
          </div>
          <div className="category-grid">
            {categories.map((item, index) => (
              <Link key={item.name} href={`/categories/${encodeURIComponent(item.name)}`}>
                <span className="category-number">0{index + 1}</span>
                <span className="category-mark" aria-hidden="true">{categoryMarks[item.name] ?? "◫"}</span>
                <strong>{categoryLabels[item.name] ?? item.name}</strong>
                <small>{item.count} Packs</small>
                <span className="category-arrow">↗</span>
              </Link>
            ))}
          </div>
        </section>

        <TrustStrip />

        <section className="publish-section" id="publish">
          <div>
            <p className="eyebrow">Made something worth repeating?</p>
            <h2>Package the proof,<br />not just the code.</h2>
          </div>
          <div>
            <p>
              A public Pack carries self-contained Blocks, reusable Workflows and the metadata people and agents need to judge it.
            </p>
            <code>aart pack prepare ./my-pack</code>
            <p className="publish-note">Publishing uses npm for versioned transport. Discovery and trust stay with AART.</p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="install-command">
      <code>{command}</code>
      <button onClick={copy} aria-label="Copy install command">{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function PackDetail({ pack }: { pack: CatalogPack }) {
  const workflows = pack.workflows ?? [];
  return (
    <>
      <Header />
      <main className="detail-main">
        <Link className="back-link" href="/">← Back to the library</Link>
        <section className="detail-hero">
          <div>
            <div className="detail-badges">
              <VerificationBadge status={pack.verification?.status} />
              <span>v{pack.version}</span>
              <span>{pack.license ?? "License not declared"}</span>
            </div>
            <p className="eyebrow">{pack.npmPackageName}</p>
            <h1>{packLabel(pack)}</h1>
            <p className="detail-lede">{pack.description}</p>
            <div className="tag-list">
              {(pack.categories ?? []).map((item) => <span key={item}>{categoryLabels[item] ?? item}</span>)}
              {(pack.tags ?? []).slice(0, 4).map((item) => <span key={item}>#{item}</span>)}
            </div>
          </div>
          <aside className="install-panel">
            <p className="eyebrow">Install inertly</p>
            <CopyCommand command={`aart pack add ${pack.packName} --version ${pack.version}`} />
            <p>Installation downloads exact bytes. It does not approve or execute the Pack.</p>
            <div className="seal">
              <span>CONTENT SEAL</span>
              <code>{pack.contentHash ?? "Pending publication"}</code>
            </div>
          </aside>
        </section>

        <section className="detail-layout">
          <div className="detail-content">
            <section>
              <div className="section-title-row"><h2>Included Blocks</h2><span>{pack.blocks.length}</span></div>
              <div className="asset-list">
                {pack.blocks.map((block) => (
                  <article key={block.manifest.id}>
                    <div><code>{block.manifest.id}</code><span>v{block.manifest.version}</span></div>
                    <p>{block.manifest.description}</p>
                    {block.examples[0] && <small>Example: {block.examples[0].description}</small>}
                  </article>
                ))}
              </div>
            </section>
            <section>
              <div className="section-title-row"><h2>Included Workflows</h2><span>{workflows.length}</span></div>
              <div className="asset-list">
                {workflows.map((workflow) => (
                  <article key={workflow.id}>
                    <div><code>{workflow.id}</code><span>v{workflow.version}</span></div>
                    <p>{workflow.name}</p>
                    {workflow.examples?.[0] && <small>Use it for: {workflow.examples[0].description}</small>}
                  </article>
                ))}
              </div>
            </section>
          </div>
          <aside className="provenance-panel">
            <p className="eyebrow">Provenance</p>
            <dl>
              <div><dt>Publisher</dt><dd>{pack.author?.name ?? "Unknown"}</dd></div>
              <div><dt>Published</dt><dd>{formatDate(pack.publishedAt)}</dd></div>
              <div><dt>Updated</dt><dd>{formatDate(pack.updatedAt)}</dd></div>
              <div><dt>AART</dt><dd>{pack.compatibility?.aart ?? "Not declared"}</dd></div>
              <div><dt>Runtime</dt><dd>{pack.compatibility?.runtimes?.join(", ") || "Node"}</dd></div>
              <div><dt>Weekly pulls</dt><dd>{formatMetric(pack.stats?.weeklyDownloads)}</dd></div>
              <div><dt>Recorded reuses</dt><dd>{formatMetric(pack.stats?.reuses)}</dd></div>
            </dl>
            <hr />
            <p className="eyebrow">Declared access</p>
            <div className="access-list">
              {(pack.capabilities ?? []).map((item) => <span key={item}>Capability · {item}</span>)}
              {(pack.secrets ?? []).map((item) => <span key={item}>Secret · {item}</span>)}
              {(pack.capabilities?.length ?? 0) + (pack.secrets?.length ?? 0) === 0 && <span>No elevated access declared</span>}
            </div>
            <p className="verification-note">{pack.verification?.note ?? "This preview entry has not been independently verified."}</p>
          </aside>
        </section>
        <TrustStrip />
      </main>
      <Footer />
    </>
  );
}

export function CatalogApp({ initialPackName, initialCategory }: { initialPackName?: string; initialCategory?: string }) {
  if (initialPackName) {
    const pack = catalogDocument.packs.find((candidate) => candidate.packName === initialPackName);
    if (pack) return <PackDetail pack={pack} />;
  }
  return <HomeCatalog initialCategory={initialCategory} />;
}

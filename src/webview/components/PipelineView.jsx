import { kindMeta } from "../lib/kindMeta";
import { UI_COLOR } from "../lib/vscodeTheme";

const STATUS = {
  found: { label: "Found", className: "text-fg-soft" },
  missing: { label: "Missing", className: "text-error" },
  no_files: { label: "No files", className: "text-warning" },
  not_a_notebook: { label: "Not a notebook", className: "text-warning" },
  is_a_notebook: {
    label: "Is a notebook",
    className: "text-warning",
    title: "Listed as a file, but its first line is the Databricks notebook header.",
  },
  not_checked: {
    label: "Not checked",
    className: "text-muted",
    title: "A workspace path, a variable or a pattern the inspector doesn't read, so it isn't checked on this machine.",
  },
};

function fileName(file) {
  return String(file ?? "").split(/[\\/]/).pop();
}

function location(file, line) {
  return file ? `${fileName(file)}${line ? `:${line}` : ""}` : "";
}

function Badge({ kind }) {
  const meta = kindMeta(kind);
  return (
    <span
      style={{ color: meta.color, backgroundColor: meta.bg }}
      className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none"
    >
      {meta.code}
    </span>
  );
}

function SectionTitle({ children, tone = "text-muted" }) {
  return <h3 className={`m-0 text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}>{children}</h3>;
}

function LinkButton({ onClick, title, className = "", children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`min-w-0 truncate text-left text-link hover:text-link-active hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * One pipeline, from its YAML: the jobs in this bundle that run it, its settings, the
 * sources its `libraries` list and their state, and its problems.
 */
export default function PipelineView({ view, otherPipelines, background, onSelect, onOpenFile, resolveName }) {
  const open = (file, line, column) => file && onOpenFile?.(file, line, column);
  const name = resolveName ? resolveName(view.name) : view.name;
  const issueCount = view.issues.filter((issue) => issue.severity !== "info").length;
  const defaultLocation = [view.catalog, view.schema].filter(Boolean).join(".");

  return (
    <div className="flex h-full flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-8 p-6 lg:overflow-auto" style={background}>
        <div className="flex flex-wrap items-start gap-6">
          <section className="flex w-60 max-w-full flex-col gap-2" aria-label="Run by">
            <SectionTitle>Run by a job in this bundle</SectionTitle>
            {view.runBy.length === 0 ? (
              <p className="m-0 text-xs text-fg-soft">No job in this bundle runs this pipeline.</p>
            ) : (
              view.runBy.map((runner) => (
                <button
                  key={`${runner.jobKey}:${runner.taskKey}`}
                  type="button"
                  onClick={() => onSelect({ group: "jobs", key: runner.jobKey })}
                  title="Show this job's tasks"
                  className="flex h-12 items-center gap-2.5 rounded-xl border px-3 text-left hover:border-fg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ borderColor: UI_COLOR.boxLine, backgroundColor: UI_COLOR.widget }}
                >
                  <Badge kind="job" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">
                      {resolveName ? resolveName(runner.jobName) : runner.jobName}
                    </span>
                    <span className="block truncate text-[11px] text-muted">task {runner.taskKey}</span>
                  </span>
                </button>
              ))
            )}
          </section>

          <section
            aria-label="Pipeline"
            className="flex w-80 max-w-full flex-col gap-3 rounded-2xl border-2 p-4"
            style={{
              borderColor: kindMeta("pipeline").color,
              backgroundColor: `color-mix(in srgb, ${kindMeta("pipeline").color} 6%, ${UI_COLOR.widget})`,
            }}
          >
            <div className="flex items-center gap-2.5">
              <Badge kind="pipeline" />
              <h2 className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-fg" title={name}>
                {name}
              </h2>
              {issueCount > 0 && (
                <span className="shrink-0 rounded-full bg-error/15 px-2 py-0.5 text-[11px] font-semibold text-fg-strong">
                  {issueCount} {issueCount === 1 ? "issue" : "issues"}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-fg-soft">
              {view.serverless && <span className="rounded-md border border-line px-2 py-0.5">Serverless</span>}
              <span className="rounded-md border border-line px-2 py-0.5">{view.mode}</span>
              {view.development && <span className="rounded-md border border-line px-2 py-0.5">Development mode</span>}
              <span className="rounded-md border border-line px-2 py-0.5">
                {view.sources.length} {view.sources.length === 1 ? "source" : "sources"}
              </span>
            </div>
          </section>

          <section className="flex w-56 max-w-full flex-col gap-2" aria-label="Default catalog and schema">
            <SectionTitle>Default catalog · schema</SectionTitle>
            <div
              className="flex h-12 items-center gap-2.5 rounded-xl border px-3"
              style={{ borderColor: UI_COLOR.boxLine, backgroundColor: UI_COLOR.widget }}
            >
              <span className="truncate font-mono text-[13px] text-fg">{defaultLocation || "Not set"}</span>
            </div>
            {defaultLocation && (
              <p className="m-0 text-[11px] text-fg-soft">Tables go here unless the code names another schema.</p>
            )}
          </section>
        </div>

        <section className="flex max-w-3xl flex-col gap-2" aria-label="Sources">
          <SectionTitle>Sources · libraries</SectionTitle>
          {view.sources.length === 0 ? (
            <p className="m-0 text-xs text-fg-soft">The YAML lists no libraries for this pipeline.</p>
          ) : (
            <ul
              className="m-0 list-none overflow-hidden rounded-xl border p-0"
              style={{ borderColor: UI_COLOR.line, backgroundColor: UI_COLOR.widget }}
            >
              {view.sources.map((source, index) => {
                const status = STATUS[source.status];
                return (
                  <li
                    key={`${source.file}:${source.line}:${index}`}
                    // Narrow editors put where it's listed and its status on a second line, so
                    // the path keeps the row's width.
                    className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-line-soft px-4 py-2.5 text-xs last:border-b-0 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto_6.5rem] sm:gap-y-3"
                  >
                    <span className="text-fg-soft">{source.kind}</span>
                    {source.resolvedPath ? (
                      <LinkButton onClick={() => open(source.resolvedPath)} title={`Open ${source.path}`} className="font-mono">
                        {source.path}
                      </LinkButton>
                    ) : (
                      <span className="min-w-0 truncate font-mono text-fg" title={source.path}>
                        {source.path}
                      </span>
                    )}
                    <div className="col-start-2 flex min-w-0 items-center justify-between gap-3 sm:contents">
                      <LinkButton onClick={() => open(source.file, source.line, source.column)} title="Open where libraries lists it" className="text-[11px]">
                        {location(source.file, source.line)}
                      </LinkButton>
                      <span title={status.title} className={`shrink-0 justify-self-end text-[10px] font-bold uppercase tracking-wide ${status.className}`}>
                        {status.label}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {otherPipelines.length > 0 && (
          <section className="flex max-w-3xl flex-col gap-2" aria-label="Other pipelines">
            <SectionTitle>Other pipelines in this bundle</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {otherPipelines.map((other) => (
                <button
                  key={other.key}
                  type="button"
                  onClick={() => onSelect({ group: "pipelines", key: other.key })}
                  className="flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] text-fg hover:border-fg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ borderColor: UI_COLOR.boxLine, backgroundColor: UI_COLOR.widget }}
                >
                  <Badge kind="pipeline" />
                  {other.key}
                  {other.issueCount > 0 && (
                    <span className="text-[11px] text-error">
                      {other.issueCount} {other.issueCount === 1 ? "issue" : "issues"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside
        aria-label="Pipeline details"
        className="flex shrink-0 flex-col gap-6 border-line-soft p-5 lg:w-[360px] lg:overflow-auto lg:border-l"
        style={{ backgroundColor: UI_COLOR.panel }}
      >
        <div className="flex flex-col gap-1">
          <SectionTitle>Pipeline</SectionTitle>
          <div className="truncate text-lg font-semibold text-fg" title={name}>{name}</div>
          <div className="truncate text-xs text-muted">resources.pipelines.{view.key}</div>
        </div>

        <section className="flex flex-col gap-2" aria-label="Issues">
          <SectionTitle tone={issueCount > 0 ? "text-error" : "text-muted"}>Issues · {view.issues.length}</SectionTitle>
          {view.issues.length === 0 ? (
            <p className="m-0 text-xs text-fg-soft">No problems found in this pipeline's settings or source paths.</p>
          ) : (
            view.issues.map((issue) => (
              <button
                key={issue.id}
                type="button"
                onClick={() => open(issue.file, issue.line, issue.column)}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  issue.severity === "error" ? "border-error/40 bg-error/10" : "border-warning/40 bg-warning/10"
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="flex-1 text-[12.5px] font-semibold text-fg">{issue.title}</span>
                  <span className="shrink-0 text-[11px] text-link">{location(issue.file, issue.line)}</span>
                </span>
                {issue.detail && <span className="break-all font-mono text-xs text-fg-soft">{issue.detail}</span>}
              </button>
            ))
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Configuration">
          <SectionTitle>Configuration</SectionTitle>
          <dl className="m-0 overflow-hidden rounded-lg border text-xs" style={{ borderColor: UI_COLOR.line }}>
            {[
              ["Catalog", view.catalog ?? "Not set"],
              ["Schema", view.schema ?? "Not set"],
              ["Mode", view.mode],
              ...(view.serverless ? [["Compute", "Serverless"]] : []),
            ].map(([label, value]) => (
              <div key={label} className="flex border-b border-line-soft px-3 py-2 last:border-b-0">
                <dt className="w-24 shrink-0 text-fg-soft">{label}</dt>
                <dd className="m-0 min-w-0 truncate text-fg">{value}</dd>
              </div>
            ))}
            {view.file && (
              <div className="flex px-3 py-2">
                <dt className="w-24 shrink-0 text-fg-soft">Defined in</dt>
                <dd className="m-0 min-w-0">
                  <LinkButton onClick={() => open(view.file, view.line)}>{location(view.file, view.line)}</LinkButton>
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="flex flex-col gap-2" aria-label="Secret scopes">
          <SectionTitle>Secret scopes</SectionTitle>
          {view.secrets.length === 0 ? (
            <p className="m-0 text-xs text-fg-soft">None found in its .py, .sql and .ipynb sources or its cluster settings.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
              {view.secrets.map((secret) => (
                <li key={secret.scope} className="flex items-baseline gap-2">
                  <span className="font-mono text-fg">{secret.scope}</span>
                  {secret.file && (
                    <LinkButton onClick={() => open(secret.file, secret.line)} className="text-[11px]">
                      {location(secret.file, secret.line)}
                    </LinkButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

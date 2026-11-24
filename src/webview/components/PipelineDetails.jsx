const STATUS = {
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

const fileName = (file) => String(file ?? "").split(/[\\/]/).pop();
const linkClass =
  "min-w-0 max-w-full truncate text-left text-link hover:text-link-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function Heading({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{children}</div>;
}

function IssueLine({ issue }) {
  return (
    <div className={`text-[11px] leading-4 ${issue.severity === "error" ? "text-error" : "text-warning"}`} data-pipeline-issue={issue.kind}>
      {issue.title}
    </div>
  );
}

/**
 * A pipeline's details on the bundle overview (issue 436): what runs it, where it writes,
 * its settings, each source with its problems directly under it, and its data flow.
 * Each thing is said once.
 */
export default function PipelineDetails({ view, panel, onSelectItem, onOpenFile, onOpenDataFlow, resolveName = (value) => value }) {
  const open = (file, line, column) => file && onOpenFile?.(file, line, column);
  return (
    <div data-pipeline-details={view.key} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5" data-pipeline-run-by>
        <Heading>Run by</Heading>
        {view.runBy.length === 0 ? (
          <div className="text-xs text-fg-soft">No job in this bundle</div>
        ) : (
          view.runBy.map((runner) => (
            <button
              key={`${runner.jobKey}:${runner.taskKey}`}
              type="button"
              onClick={() => onSelectItem(`resources.jobs.${runner.jobKey}`)}
              title={resolveName(runner.jobName)}
              className="flex min-w-0 max-w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs text-fg hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="min-w-0 max-w-[65%] shrink-0 truncate font-medium">{runner.jobKey}</span>
              <span className="min-w-0 flex-1 truncate text-muted">task {runner.taskKey}</span>
            </button>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Heading>Writes to</Heading>
        <div className={`break-all text-xs ${panel.writesTo ? "font-mono text-fg" : "text-fg-soft"}`} data-pipeline-writes-to>
          {panel.writesTo ?? "Not set"}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Heading>Settings</Heading>
        <div className="text-xs text-fg" data-pipeline-settings>{panel.settings}</div>
      </div>

      <div className="flex flex-col gap-1.5" data-pipeline-code>
        <Heading>Code</Heading>
        {panel.sources.length === 0 ? (
          <div className="text-xs text-fg-soft">The YAML lists no libraries for this pipeline.</div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {panel.sources.map((source, index) => {
              const status = STATUS[source.status];
              return (
                <li key={`${source.file}:${source.line}:${index}`} className="flex min-w-0 flex-col gap-0.5" data-pipeline-source={source.path}>
                  {source.resolvedPath ? (
                    <button type="button" onClick={() => open(source.resolvedPath)} title={`Open ${source.path}`} className={`${linkClass} font-mono text-[11px]`}>
                      {source.path}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px] text-fg" title={source.path}>
                      {source.path}
                    </span>
                  )}
                  <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
                    <button type="button" onClick={() => open(source.file, source.line, source.column)} title="Open where libraries lists it" className={linkClass}>
                      {fileName(source.file)}:{source.line}
                    </button>
                    {/* A problem says it in words below, so the status is shown only without one. */}
                    {status && source.issues.length === 0 && (
                      <span title={status.title} className={`shrink-0 ${status.className}`}>
                        {status.label}
                      </span>
                    )}
                  </div>
                  {source.issues.map((issue) => (
                    <IssueLine key={issue.id} issue={issue} />
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {panel.otherIssues.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Heading>Problems</Heading>
          {panel.otherIssues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => open(issue.file, issue.line, issue.column)}
              className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <IssueLine issue={issue} />
            </button>
          ))}
        </div>
      )}

      {panel.dataFlow && (
        <div className="flex flex-col gap-1.5" data-pipeline-data-flow-summary>
          <Heading>Data flow</Heading>
          <div className="text-xs text-fg-soft">{panel.dataFlow.summary}</div>
          {panel.dataFlow.opens && (
            <button
              type="button"
              data-pipeline-open-data-flow
              onClick={onOpenDataFlow}
              className="self-start rounded-md border border-line bg-widget px-2.5 py-1 text-xs font-medium text-fg hover:border-line-strong hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Open data flow ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { useMemo, useRef } from "react";
import { branchById, branchCountWords, branchStates, holdsWords, sourceWords } from "../../bundle/lakebaseBranches";
import { UI_COLOR } from "../lib/vscodeTheme";

const HEADING = "text-[10px] font-semibold uppercase tracking-[0.16em] text-muted";
/** Each level of the tree steps in this far; the line to a branch runs down this column. */
const STEP = 24;
/** Where a row's ring sits: the line from its parent ends here. */
const RING_X = 18;
const RING_Y = 22;

const baseName = (file) => file.split(/[\\/]/).pop();

function Tag({ children }) {
  return <span className="rounded border border-line px-1.5 text-[11px] font-normal leading-5 text-fg-soft">{children}</span>;
}

function FileLink({ file, line, onOpenFile }) {
  if (!file) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenFile?.(file, line)}
      className="max-w-full self-start break-all text-left text-xs text-link hover:text-link-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {baseName(file)}
      {line ? `:${line}` : ""}
    </button>
  );
}

/**
 * For each row of the tree, which columns carry a line: the elbow into the row itself, and the
 * lines passing by to a later sibling of one of its parents.
 */
function treeLines(tree) {
  return tree.map(({ depth }, index) => {
    const later = tree.slice(index + 1);
    // Column k carries a line past this row when a later row at depth k + 1 comes before any row at depth k or less.
    const continues = (k) => {
      for (const row of later) {
        if (row.depth <= k) return false;
        if (row.depth === k + 1) return true;
      }
      return false;
    };
    return Array.from({ length: depth }, (_, k) => ({ elbow: k === depth - 1, down: continues(k) }));
  });
}

function Gutter({ columns }) {
  const line = UI_COLOR.boxLine;
  return columns.map(({ elbow, down }, k) => (
    <span key={k} aria-hidden="true" className="relative shrink-0 self-stretch" style={{ width: STEP }}>
      {(down || elbow) && (
        <span
          className="absolute"
          // The last child's line stops where its rounded elbow starts.
          style={{ left: RING_X - 1, top: 0, bottom: down ? 0 : undefined, height: down ? undefined : RING_Y - 12, borderLeft: `1.5px solid ${line}` }}
        />
      )}
      {elbow && (
        <span
          className="absolute"
          style={{
            left: RING_X - 1,
            top: RING_Y - 12,
            width: STEP - RING_X + 1,
            height: 12,
            borderLeft: `1.5px solid ${line}`,
            borderBottom: `1.5px solid ${line}`,
            borderBottomLeftRadius: 10,
          }}
        />
      )}
    </span>
  ));
}

function Ring({ selected, outside }) {
  return (
    <span
      aria-hidden="true"
      className="mt-[5px] h-3 w-3 shrink-0 rounded-full"
      style={{
        border: `2px ${outside ? "dashed" : "solid"} ${selected ? UI_COLOR.accent : UI_COLOR.boxLine}`,
        backgroundColor: selected ? UI_COLOR.accent : UI_COLOR.widget,
      }}
    />
  );
}

function BranchRow({ branch, selected, onSelect, register }) {
  const outside = branch.origin === "outside";
  const holds = holdsWords(branch);
  const states = branchStates(branch);
  return (
    <button
      ref={(element) => register(branch.id, element)}
      type="button"
      data-branch-row={branch.id}
      aria-pressed={selected}
      onClick={() => onSelect(selected ? null : branch.id)}
      title={outside ? "The bundle names this branch but doesn't define it" : undefined}
      className={`flex min-w-0 flex-1 items-start gap-3 rounded-lg border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        outside ? "border-dashed" : "border-solid"
      } ${selected ? "" : "hover:bg-hover"}`}
      style={{
        borderColor: selected ? UI_COLOR.accent : outside ? UI_COLOR.boxLine : "transparent",
        backgroundColor: selected ? `color-mix(in srgb, ${UI_COLOR.accent} 10%, ${UI_COLOR.widget})` : undefined,
      }}
    >
      <Ring selected={selected} outside={outside} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`truncate text-sm font-semibold ${selected ? "text-link-active" : outside ? "text-fg-soft" : "text-fg"}`}>{branch.label}</span>
          {branch.isDefault && <Tag>Default</Tag>}
          {branch.isProtected && <Tag>Protected</Tag>}
        </span>
        {sourceWords(branch) && <span className="truncate text-xs text-muted">{sourceWords(branch)}</span>}
        {holds && <span className="truncate text-xs text-muted">{holds}</span>}
        {/* A narrow panel puts the states under the name, so they never squeeze it. */}
        {states.map((state) => (
          <span key={state} className="text-xs text-muted @2xl:hidden">
            {state}
          </span>
        ))}
      </span>
      {states.length > 0 && (
        <span className="hidden shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right text-xs text-muted @2xl:flex">
          {states.map((state) => (
            <span key={state}>{state}</span>
          ))}
        </span>
      )}
    </button>
  );
}

function Fact({ label, children }) {
  if (children === undefined || children === null || children === "" || (Array.isArray(children) && children.length === 0)) return null;
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-0.5 break-words text-fg">{children}</dd>
    </>
  );
}

function ProjectFacts({ project, onOpenFile, resolveName }) {
  return (
    <>
      <div className={HEADING}>Project</div>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <Fact label="Project ID">{project.projectId ? resolveName(project.projectId) : undefined}</Fact>
        <Fact label="Name">{project.displayName ? resolveName(project.displayName) : undefined}</Fact>
        <Fact label="Postgres">{project.pgVersion}</Fact>
        <Fact label="History kept">{project.history}</Fact>
      </dl>
      <FileLink file={project.file} line={project.line} onOpenFile={onOpenFile} />
      <div className="text-xs text-muted">Select a branch to see what it holds.</div>
    </>
  );
}

function BranchDetails({ branch, project, onOpenFile, onClose, resolveName }) {
  const source = branch.source;
  const madeFrom =
    branch.origin === "outside"
      ? "Not in this bundle"
      : branch.origin === "project"
        ? "Made with the project"
        : source.kind === "branch" && source.implicit
          ? `${sourceWords(branch)}, the default branch`
          : sourceWords(branch);
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted">Branch</div>
          <div className="truncate text-base font-semibold text-fg" title={branch.label}>
            {branch.label}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close branch details"
          onClick={onClose}
          className="rounded-md px-1.5 text-sm text-muted hover:bg-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ×
        </button>
      </div>
      {(branch.isDefault || branch.isProtected) && (
        <div className="flex flex-wrap gap-1.5">
          {branch.isDefault && <Tag>Default</Tag>}
          {branch.isProtected && <Tag>Protected</Tag>}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs" data-branch-details={branch.id}>
        <Fact label="Branch ID">{branch.branchId ? resolveName(branch.branchId) : undefined}</Fact>
        <Fact label="Made from">{madeFrom}</Fact>
        <Fact label="Expires">{branch.expiry ? branch.expiry.text.replace(/^Expires /, "") : undefined}</Fact>
        <Fact label="Compute">
          {branch.origin === "bundle" && branch.endpoints.length === 0
            ? <span className="text-muted">No endpoint in this bundle</span>
            : branch.endpoints.map((endpoint) => (
                <span key={endpoint.id}>{[endpoint.label, endpoint.typeWords, endpoint.capacity, endpoint.suspend].filter(Boolean).join(" · ")}</span>
              ))}
        </Fact>
        <Fact label="Holds">
          {branch.held.map((held) => (
            <span key={held.id}>{[held.label, held.detail].filter(Boolean).join(" · ")}</span>
          ))}
        </Fact>
        <Fact label="Snapshots">
          {branch.schedules.flatMap((schedule) => (schedule.cadences.length ? schedule.cadences : [schedule.label]).map((words) => <span key={`${schedule.id}-${words}`}>{words}</span>))}
        </Fact>
        <Fact label="Used by">
          {branch.usedBy.map((use) => (
            <span key={use.id}>{use.through ? `${use.label}, through ${use.through}` : use.label}</span>
          ))}
        </Fact>
      </dl>
      <FileLink file={branch.file} line={branch.line} onOpenFile={onOpenFile} />
      {branch.origin === "outside" && (
        <div className="text-xs text-muted">The bundle names this branch in {project.label} but doesn't define it.</div>
      )}
    </>
  );
}

/**
 * A Lakebase project's branches (issue 543): each branch under the branch it was made from,
 * branches made from a snapshot below, and the selected branch's details on the right.
 * Grey lines and rings, blue only for the selected branch.
 */
export default function LakebaseBranches({ project, selectedBranchId, onSelectBranch, onOpenFile, resolveName = (value) => value }) {
  const lines = useMemo(() => treeLines(project.tree), [project]);
  const order = useMemo(() => [...project.tree.map((row) => row.id), ...project.fromSnapshot], [project]);
  const selected = selectedBranchId ? branchById(project, selectedBranchId) : undefined;
  const rows = useRef(new Map());
  const register = (id, element) => (element ? rows.current.set(id, element) : rows.current.delete(id));
  const schedules = project.branches.flatMap((branch) => branch.schedules.map((schedule) => ({ schedule, branch })));

  // Up and down move between branches, as on the overview's boxes.
  const onKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const at = order.indexOf(selected?.id ?? "");
    const next = order[event.key === "ArrowDown" ? Math.min(order.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
    if (!next) return;
    event.preventDefault();
    onSelectBranch(next);
    rows.current.get(next)?.focus();
  };

  return (
    <div className="@container h-full" data-branches-page={project.key}>
      <div className="flex h-full min-h-0 flex-col @3xl:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-6" onKeyDown={onKeyDown}>
          <div className="flex max-w-3xl flex-col gap-4">
            <div>
              <div className="text-[11px] text-muted">Lakebase project</div>
              <div className="truncate text-lg font-semibold text-fg" title={project.label}>
                {project.label}
              </div>
            </div>
            {(project.pgVersion || project.history) && (
              <div className="flex flex-wrap gap-1.5">
                {project.pgVersion && <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-soft">Postgres {project.pgVersion}</span>}
                {project.history && <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-soft">History kept {project.history}</span>}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className={HEADING}>Branch relationships</div>
              <div className="text-xs text-muted" data-branch-count>{branchCountWords(project)}</div>
            </div>
            <div role="list" aria-label={`Branches of ${project.label}`} className="flex flex-col">
              {project.tree.map(({ id, depth }, index) => {
                const branch = branchById(project, id);
                // A branch with branches made from it: a line from its ring down to its first child's.
                const hasChildren = (project.tree[index + 1]?.depth ?? -1) > depth;
                return (
                  <div role="listitem" key={id} className="relative flex min-w-0 items-stretch">
                    {hasChildren && (
                      <span
                        aria-hidden="true"
                        data-branch-trunk
                        className="absolute bottom-0"
                        style={{ left: depth * STEP + RING_X - 1, top: RING_Y + 6, borderLeft: `1.5px solid ${UI_COLOR.boxLine}` }}
                      />
                    )}
                    <Gutter columns={lines[index]} />
                    <BranchRow branch={branch} selected={selected?.id === id} onSelect={onSelectBranch} register={register} />
                  </div>
                );
              })}
            </div>
            {(schedules.length > 0 || project.fromSnapshot.length > 0) && (
              <div className="mt-2 flex flex-col gap-2 border-t border-line pt-4" data-branch-snapshots>
                {schedules.map(({ schedule, branch }) => (
                  <div key={schedule.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="text-xs text-muted">Snapshot schedule</span>
                    <span className="text-fg">
                      {(schedule.cadences.length ? schedule.cadences.join("; ") : schedule.label)} · {branch.label}
                    </span>
                  </div>
                ))}
                {project.fromSnapshot.map((id) => {
                  const branch = branchById(project, id);
                  const isSelected = selected?.id === id;
                  return (
                    <button
                      key={id}
                      ref={(element) => register(id, element)}
                      type="button"
                      data-branch-row={id}
                      aria-pressed={isSelected}
                      onClick={() => onSelectBranch(isSelected ? null : id)}
                      className="flex min-w-0 items-center gap-2 self-start rounded-lg border px-3 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent hover:bg-hover"
                      style={{
                        borderColor: isSelected ? UI_COLOR.accent : "transparent",
                        backgroundColor: isSelected ? `color-mix(in srgb, ${UI_COLOR.accent} 10%, ${UI_COLOR.widget})` : undefined,
                      }}
                    >
                      <span aria-hidden="true" className="text-muted">◆</span>
                      <span className="truncate text-xs text-muted">{branch.source.label}</span>
                      <span aria-hidden="true" className="text-muted">-----</span>
                      <Ring selected={isSelected} />
                      <span className={`truncate font-semibold ${isSelected ? "text-link-active" : "text-fg"}`}>{branch.label}</span>
                      {branchStates(branch).length > 0 && <span className="truncate text-xs text-muted">{branchStates(branch).join(" · ")}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <aside
          aria-label={selected ? `Branch ${selected.label}` : `Project ${project.label}`}
          className="flex max-h-[45%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto border-t border-line bg-panel p-4 @3xl:max-h-none @3xl:w-80 @3xl:border-l @3xl:border-t-0"
        >
          {selected ? (
            <BranchDetails branch={selected} project={project} onOpenFile={onOpenFile} onClose={() => onSelectBranch(null)} resolveName={resolveName} />
          ) : (
            <ProjectFacts project={project} onOpenFile={onOpenFile} resolveName={resolveName} />
          )}
        </aside>
      </div>
    </div>
  );
}

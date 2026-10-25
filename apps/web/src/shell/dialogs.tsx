import { type PageSummary } from "@workspace/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, conflictCurrent, errorMessage } from "../api";
import { qk } from "../queries";
import { navigate } from "../router";
import { Dialog, OnlineButton, toast } from "../ui";
import { PageTree } from "./PageTree";

type Movable = Pick<PageSummary, "id" | "parentId" | "workspaceId" | "revision" | "title">;

/** Keyboard-accessible alternative to dragging in the sidebar. */
export function MoveDialog({ page, onClose }: { page: Movable; onClose: () => void }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<PageSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const move = async (parentId: string | null) => {
    setBusy(true);
    let revision = page.revision;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await api.movePage(page.id, { expectedRevision: revision, parentId });
          break;
        } catch (err) {
          const current = conflictCurrent<PageSummary>(err);
          if (!current || attempt > 0) throw err;
          revision = current.revision; // moving is an explicit choice: retry once on the latest revision
        }
      }
      for (const p of new Set([page.parentId, parentId])) void qc.invalidateQueries({ queryKey: qk.children(page.workspaceId, p) });
      void qc.invalidateQueries({ queryKey: qk.page(page.id) });
      toast(`Moved “${page.title || "Untitled"}” to ${parentId ? `“${target?.title || "Untitled"}”` : "the top level"}`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Move “${page.title || "Untitled"}”`}
      onClose={onClose}
      footer={
        <>
          <OnlineButton className="btn" disabled={busy} onClick={() => void move(null)}>
            Move to top level
          </OnlineButton>
          <OnlineButton className="btn btn-primary" disabled={busy || !target} onClick={() => target && void move(target.id)}>
            {target ? `Move into “${target.title || "Untitled"}”` : "Choose a page"}
          </OnlineButton>
        </>
      }
    >
      <p className="muted small">Choose the new parent page. Use arrow keys to browse, Enter to choose.</p>
      <div className="picker">
        <PageTree ws={page.workspaceId} label="Destination pages" mode="picker" excludeId={page.id} pickedId={target?.id ?? null} onPick={setTarget} />
      </div>
    </Dialog>
  );
}

export function ImportDialog({ ws, kind, onClose }: { ws: string; kind: "markdown" | "csv"; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; imported?: number; rejected: { row: number; reason: string }[]; warnings: string[] } | null>(null);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const name = title.trim() || file.name.replace(/\.(md|markdown|csv|txt)$/i, "");
      if (kind === "markdown") {
        const r = await api.importMarkdown(ws, { markdown: text, parentId: null, title: name });
        setResult({ id: r.page.id, rejected: [], warnings: r.warnings });
      } else {
        const r = await api.importCsv(ws, { csv: text, parentId: null, title: name || "Imported" });
        setResult({ id: r.database.id, imported: r.imported, rejected: r.rejected, warnings: r.warnings });
      }
      void qc.invalidateQueries({ queryKey: qk.children(ws, null) });
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const label = kind === "markdown" ? "Import Markdown" : "Import CSV as a database";
  return (
    <Dialog
      title={label}
      onClose={onClose}
      footer={
        result ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onClose();
              navigate(`/p/${result.id}`);
            }}
          >
            Open {kind === "markdown" ? "page" : "database"}
          </button>
        ) : (
          <OnlineButton className="btn btn-primary" disabled={!file || busy} onClick={() => void run()}>
            {busy ? "Importing…" : "Import"}
          </OnlineButton>
        )
      }
    >
      {!result ? (
        <>
          <label className="field">
            <span>{kind === "markdown" ? "Markdown file (.md)" : "CSV file (first row = column names)"}</span>
            <input type="file" accept={kind === "markdown" ? ".md,.markdown,.txt,text/markdown,text/plain" : ".csv,text/csv"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? ""} />
          </label>
        </>
      ) : (
        <div aria-live="polite">
          {result.imported !== undefined && (
            <p>
              <strong>{result.imported}</strong> row{result.imported === 1 ? "" : "s"} imported
              {result.rejected.length ? `, ${result.rejected.length} rejected` : ""}.
            </p>
          )}
          {kind === "markdown" && <p>Page imported.</p>}
          {result.rejected.length > 0 && (
            <table className="report">
              <caption>Rejected rows</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.rejected.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.warnings.length > 0 && <Warnings warnings={result.warnings} />}
        </div>
      )}
    </Dialog>
  );
}

export function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="warnings">
      <h3>Conversion warnings</h3>
      <ul>
        {warnings.slice(0, 50).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

import { ApiRequestError, can, type Me, type PageSummary } from "@workspace/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { invalidatePage, qk, roleIn } from "../queries";
import { Link, navigate } from "../router";
import { PageLink, TopBar } from "../shell/Shell";
import { ConfirmDialog, OnlineButton, relTime, Spinner, toast, useOnline } from "../ui";

export default function Trash({ ws, me }: { ws: string; me: Me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: qk.trash(ws), queryFn: () => api.trash(ws) });
  const role = roleIn(me, ws);
  const [confirm, setConfirm] = useState<PageSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Trash · Workspace";
  }, []);

  const restore = async (p: PageSummary) => {
    try {
      await api.restorePage(p.id);
      invalidatePage(qc, p);
      toast(`Restored “${p.title || "Untitled"}”`);
    } catch (err) {
      const root = err instanceof ApiRequestError ? (err.details as { archiveRoot?: string } | undefined)?.archiveRoot : undefined;
      if (root) {
        toast("This page was trashed with its parent. Restore the parent instead.", "error");
        navigate(`/p/${root}`);
      } else toast(errorMessage(err), "error");
    }
  };
  const remove = async (p: PageSummary) => {
    setBusy(true);
    try {
      const r = await api.deletePage(p.id);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: qk.trash(ws) });
      qc.removeQueries({ queryKey: qk.page(p.id) });
      toast(r.deleted > 1 ? `Deleted “${p.title || "Untitled"}” and ${r.deleted - 1} page(s) inside it` : `Deleted “${p.title || "Untitled"}” permanently`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar>
        <span className="crumb-current">Trash</span>
      </TopBar>
      <div className="doc settings">
        <h1 className="home-title">Trash</h1>
        <p className="muted">Pages in the trash are read-only. {can(role, "delete_permanently") ? "Owners can delete them permanently." : "Only owners can delete them permanently."}</p>
        {q.isPending && q.fetchStatus !== "paused" && <Spinner label="Loading trash" />}
        {(q.isError || (q.isPending && q.fetchStatus === "paused")) && <p className="muted">{online ? `Couldn't load the trash: ${errorMessage(q.error)}` : "The trash isn't available offline."}</p>}
        {q.data && q.data.pages.length === 0 && <p>The trash is empty.</p>}
        {q.data && q.data.pages.length > 0 && (
          <ul className="list" aria-label="Pages in the trash">
            {q.data.pages.map((p) => (
              <li key={p.id}>
                <div className="who">
                  <PageLink page={p} />
                  <span className="muted small">Updated {relTime(p.updatedAt)}</span>
                </div>
                {can(role, "archive") && (
                  <OnlineButton className="btn btn-small" aria-label={`Restore ${p.title || "Untitled"}`} onClick={() => void restore(p)}>
                    Restore
                  </OnlineButton>
                )}
                {can(role, "delete_permanently") && (
                  <OnlineButton className="btn btn-small btn-ghost" aria-label={`Delete ${p.title || "Untitled"} permanently`} onClick={() => setConfirm(p)}>
                    Delete permanently
                  </OnlineButton>
                )}
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link to={`/w/${ws}`}>Back to the workspace</Link>
        </p>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete “${confirm.title || "Untitled"}” permanently?`}
          message="The page, its sub-pages, comments and attachments are deleted for everyone. This can't be undone."
          confirm="Delete permanently"
          danger
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => void remove(confirm)}
        />
      )}
    </>
  );
}

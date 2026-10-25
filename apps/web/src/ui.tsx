import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

// ---------- tiny external store (keeps fast-changing state out of big React trees) ----------

export interface Store<T> {
  get: () => T;
  set: (v: T) => void;
  subscribe: (l: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set: (v) => {
      if (Object.is(v, value)) return;
      value = v;
      ls.forEach((l) => l());
    },
    subscribe: (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
  };
}

export const useStore = <T,>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.get);

// ---------- online state ----------

const onlineSub = (l: () => void) => {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
};
export const useOnline = () => useSyncExternalStore(onlineSub, () => navigator.onLine);

// ---------- toasts (one polite live region) ----------

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}
const toasts = createStore<Toast[]>([]);
let toastSeq = 0;

export function toast(message: string, tone: Toast["tone"] = "info") {
  const id = ++toastSeq;
  toasts.set([...toasts.get().slice(-3), { id, message, tone }]);
  setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
}
const dismiss = (id: number) => toasts.set(toasts.get().filter((t) => t.id !== id));

export function Toaster() {
  const list = useStore(toasts);
  return (
    <div className="toaster" role="status" aria-live="polite" aria-relevant="additions text">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <span>{t.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- dialog: native <dialog> gives focus containment and Esc; we restore focus on close ----------

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useLayoutEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => {
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${props.wide ? "dialog-wide" : ""} ${props.className ?? ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{props.title}</h2>
        <button type="button" className="icon-btn" aria-label="Close dialog" onClick={() => onCloseRef.current()}>
          ×
        </button>
      </div>
      <div className="dialog-body">{props.children}</div>
      {props.footer && <div className="dialog-foot">{props.footer}</div>}
    </dialog>
  );
}

/** Promise-free confirm: render when needed. */
export function ConfirmDialog(props: { title: string; message: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className={`btn ${props.danger ? "btn-danger" : "btn-primary"}`} disabled={props.busy} onClick={props.onConfirm}>
            {props.confirm}
          </button>
        </>
      }
    >
      <div>{props.message}</div>
    </Dialog>
  );
}

// ---------- menu button ----------

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** When set, the item is disabled and this explains why. */
  disabledReason?: string | null;
}

export function Menu(props: {
  label: string;
  children: ReactNode;
  items: (MenuItem | null | false)[];
  className?: string;
  buttonClassName?: string;
  /** Visible text already names the button: don't override it with aria-label. */
  labelledByContent?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items = props.items.filter((i): i is MenuItem => !!i);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els.at(-1)?.focus();
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className={`menu-wrap ${props.className ?? ""}`}>
      <button
        ref={btn}
        type="button"
        className={props.buttonClassName ?? "icon-btn"}
        aria-label={props.labelledByContent ? undefined : props.label}
        title={props.labelledByContent ? undefined : props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={props.label} className={`menu menu-${props.align ?? "right"}`} onKeyDown={onKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? "danger" : ""}
              aria-disabled={item.disabledReason ? true : undefined}
              title={item.disabledReason ?? undefined}
              onClick={() => {
                if (item.disabledReason) return;
                close();
                item.onSelect();
              }}
            >
              {item.label}
              {item.disabledReason && <span className="menu-reason">{item.disabledReason}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- online-only button: stays focusable and explains why it is unavailable ----------

export const OFFLINE_REASON = "You're offline. This needs a connection.";

export function OnlineButton({ onClick, className, children, offlineReason = OFFLINE_REASON, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { offlineReason?: string }) {
  const online = useOnline();
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        {...rest}
        className={`${className ?? ""} ${online ? "" : "is-disabled"}`}
        aria-disabled={online ? rest["aria-disabled"] : true}
        aria-describedby={online ? rest["aria-describedby"] : reasonId}
        title={online ? rest.title : offlineReason}
        onClick={(e) => {
          if (!navigator.onLine) {
            e.preventDefault();
            toast(offlineReason);
            return;
          }
          onClick?.(e);
        }}
      >
        {children}
      </button>
      {!online && (
        <span id={reasonId} className="sr-only">
          {offlineReason}
        </span>
      )}
    </>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Splash() {
  return (
    <div className="splash">
      <Spinner />
    </div>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function relTime(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

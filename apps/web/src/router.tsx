import { type AnchorHTMLAttributes, useSyncExternalStore } from "react";

// shortcut: a tiny history router (no react-router dependency); upgrade if nested layouts/loaders are needed.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search + location.hash) return;
  history[opts.replace ? "replaceState" : "pushState"](null, "", to);
  notify();
  if (!opts.replace) window.scrollTo(0, 0);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLocation() {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.search + location.hash);
  const url = new URL(href, location.origin);
  return { pathname: url.pathname, search: url.searchParams, hash: url.hash, href };
}

export function setSearchParam(key: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  navigate(url.pathname + url.search + url.hash, { replace: true });
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function match(pattern: RegExp, pathname: string): string[] | null {
  const m = pattern.exec(pathname);
  return m ? m.slice(1) : null;
}

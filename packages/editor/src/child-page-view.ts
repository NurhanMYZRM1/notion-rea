import { ChildPage, type ChildPageHost, type ChildPageReference } from "./child-page";

/** Resolve titles outside the document so a rename does not rewrite every parent's body. */
export function childPageWithView(host: () => ChildPageHost | undefined, onError: (message: string) => void) {
  return ChildPage.extend({
    addNodeView() {
      return ({ node: initial }) => {
        let node = initial;
        let disposed = false;
        let generation = 0;
        const dom = document.createElement("div");
        dom.className = "ws-child-page";
        dom.setAttribute("data-child-page", "");
        const button = document.createElement("button");
        button.type = "button";
        const icon = document.createElement("span");
        icon.className = "ws-child-page-icon";
        icon.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.className = "ws-child-page-title";
        button.append(icon, title);
        dom.append(button);
        const render = (page?: ChildPageReference, unavailable = false) => {
          title.textContent = unavailable ? "Page unavailable" : page ? page.title || "Untitled" : String(node.attrs.title || "Untitled");
          icon.textContent = unavailable ? "" : page ? page.icon ?? "" : String(node.attrs.icon || "");
          icon.classList.toggle("has-icon", !!icon.textContent);
          button.disabled = unavailable || !host();
          button.setAttribute("aria-label", `Open ${title.textContent}`);
          dom.dataset.pageId = String(node.attrs.pageId);
        };
        const refresh = async () => {
          const current = ++generation;
          const api = host();
          if (!api) return render();
          try {
            const pages = await api.resolve([String(node.attrs.pageId)]);
            if (disposed || current !== generation) return;
            const page = pages.find((p) => p.id === node.attrs.pageId);
            render(page, !page);
          } catch {
            if (!disposed && current === generation) render(undefined, true);
          }
        };
        button.onclick = () => host()?.open(String(node.attrs.pageId));
        render();
        void refresh();
        const unsubscribe = host()?.subscribe?.(() => void refresh());
        return {
          dom,
          update(next) {
            if (next.type.name !== "childPage") return false;
            node = next;
            void refresh();
            return true;
          },
          stopEvent: (event) => event.target instanceof HTMLElement && button.contains(event.target) && event.type !== "dragstart",
          ignoreMutation: () => true,
          destroy() { disposed = true; unsubscribe?.(); },
        };
      };
    },
  }).configure({ host, onError });
}

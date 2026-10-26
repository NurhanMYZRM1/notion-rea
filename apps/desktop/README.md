# Workspace desktop

Tauri 2 / Rust desktop host for the existing Workspace web app. It opens in its own macOS window,
keeps a separate persistent cookie/IndexedDB store, and supports normal editing, databases, search,
file pickers, downloads, and keyboard shortcuts. External links open in the default browser.

## Run locally

With Node, pnpm, Rust, and the platform's Tauri prerequisites installed:

```sh
pnpm install
pnpm desktop
```

The app reuses the Workspace server at `http://localhost:5173` if it is already running. Otherwise it
starts Vite and the Cloudflare Worker from this checkout, waits for `/api/providers`, and opens the
app. A server started by the desktop app stops when the app quits; a pre-existing server is left alone.
The local database, migrations, and `apps/server/.dev.vars` are the same as the web app. Follow the
root README's initial setup on a fresh checkout.

The local demo created for this checkout is **demo@example.com / WorkspaceDemo123!**. Choose
**Sign in** to open **Try Workspace**, which has sample documents and a task database.

## Build a macOS app

```sh
pnpm desktop:build
open apps/desktop/src-tauri/target/release/bundle/macos/Workspace.app
```

This produces a local development `.app` that can be opened from Finder. It remembers the checkout
and Node paths used at build time so it can start the server without a terminal. Keep this checkout
and its dependencies in place. It is not a self-contained distribution of the Cloudflare backend.
Local server logs are under macOS's `~/Library/Logs/com.workspace.desktop/local-server.log`.

For a hosted backend, build with its HTTPS URL instead:

```sh
WORKSPACE_DESKTOP_URL=https://your-workspace.example.com pnpm desktop:build
```

That build loads the hosted app directly and does not need Node or this checkout at runtime.
Configure real OAuth sign-in with a system-browser/deep-link flow before distributing a hosted build;
the current local app uses the existing development email/password sign-in. Signing/notarization and
Windows/Linux installers are separate distribution steps; the checked-in bundle target is macOS.

Markdown exports and attachment downloads are saved in the app’s Exports folder. Choose **File → Show Exports Folder** to open it in Finder. Existing files are never overwritten. This avoids WebKit blocking on macOS protected-folder permissions.

The webview has no Tauri command capabilities and no filesystem/shell IPC. The Rust host alone starts
the known local server and opens external links. Frontend and server code continue to share an origin,
so the existing session cookies and WebSocket authorization do not need a CORS bypass.

## Verify

```sh
pnpm --filter desktop check
pnpm --filter desktop test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
```

The URL and health-response tests cover refusing insecure hosted URLs and refusing to attach to an
unrelated service occupying port 5173. Native window behavior and server lifecycle need a desktop run.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod server;

use anyhow::{Context, Result, bail};
use tauri::{
    Manager, RunEvent, Url, WebviewWindowBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    webview::{DownloadEvent, NewWindowResponse},
};

const APP_URL: &str = env!("WORKSPACE_DESKTOP_URL");
const LOCAL_URL: &str = "http://localhost:5173";

fn app_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).context("Invalid Workspace server URL")?;
    if url.as_str().trim_end_matches('/') != LOCAL_URL && url.scheme() != "https" {
        bail!("Use HTTPS for a hosted workspace, or {LOCAL_URL} for local development");
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        bail!("The Workspace URL must have a host and must not contain credentials");
    }
    Ok(url)
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "https" | "http" | "mailto")
        && let Err(error) = open::that_detached(url.as_str())
    {
        eprintln!("Could not open link: {error}");
    }
}

fn run() -> Result<()> {
    let destination = app_url(APP_URL)?;
    let origin = destination.origin();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(server::LocalServer::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(downloads::Downloads::new(handle.path().app_local_data_dir()?.join("Exports"))?);
            let menu = Menu::default(&handle)?;
            for item in menu.items()? {
                if let Some(file) = item.as_submenu() && file.text()? == "File" {
                    file.append(&PredefinedMenuItem::separator(&handle)?)?;
                    file.append(&MenuItem::with_id(&handle, "show-exports", "Show Exports Folder", true, None::<&str>)?)?;
                }
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "show-exports" {
                    let _ = open::that_detached(&app.state::<downloads::Downloads>().directory);
                }
            });
            let popup_handle = handle.clone();
            let popup_origin = origin.clone();
            let dev_origin = app.config().build.dev_url.as_ref().map(Url::origin);
            let config = app.config().app.windows.first().context("Missing main window configuration")?;
            let window = WebviewWindowBuilder::from_config(app, config)?
                .on_download(|webview, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            match webview.state::<downloads::Downloads>().reserve(destination) {
                                Ok(path) => *destination = path,
                                Err(error) => { eprintln!("Could not save download: {error}"); return false; }
                            }
                        }
                        DownloadEvent::Finished { success, .. } => {
                            let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('workspace-download', {{detail:{{success:{success}}}}}));"));
                        }
                        _ => {}
                    }
                    true
                })
                .on_navigation(move |url| {
                    // Only the bundled startup page and our server stay inside the app.
                    if url.origin() == origin
                        || (cfg!(debug_assertions) && dev_origin.as_ref() == Some(&url.origin()))
                        || matches!(url.scheme(), "tauri" | "about" | "blob")
                        || url.host_str() == Some("tauri.localhost")
                    {
                        return true;
                    }
                    open_external(url);
                    false
                })
                .on_new_window(move |url, _| {
                    if url.origin() == popup_origin {
                        if let Some(window) = popup_handle.get_webview_window("main") {
                            let _ = window.navigate(url);
                        }
                    } else {
                        open_external(&url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;

            std::thread::spawn(move || {
                let result = (|| -> Result<()> {
                    if destination.as_str().trim_end_matches('/') == LOCAL_URL {
                        let logs = handle.path().app_log_dir()?;
                        handle.state::<server::LocalServer>().ensure_running(&logs)?;
                    }
                    window.navigate(destination)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("Workspace startup failed: {error:#}");
                    handle.state::<server::LocalServer>().stop();
                    let message = serde_json::to_string(&format!(
                        "{error:#}\n\nQuit and reopen Workspace to try again."
                    ));
                    if let Ok(message) = message {
                        let _ = window.eval(format!(
                            "document.getElementById('title').textContent = 'Workspace could not open'; document.getElementById('message').textContent = {message};"
                        ));
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .context("Could not create the Workspace desktop app")?;

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<server::LocalServer>().stop();
        }
    });
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::app_url;

    #[test]
    fn accepts_local_development_and_https_hosted_workspaces() {
        assert!(app_url("http://localhost:5173").is_ok());
        assert!(app_url("https://workspace.example.com/").is_ok());
    }

    #[test]
    fn rejects_credentials_and_insecure_remote_servers() {
        for url in [
            "http://workspace.example.com/",
            "https://user:secret@workspace.example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(app_url(url).is_err(), "accepted {url}");
        }
    }
}

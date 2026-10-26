use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};

#[derive(Default)]
pub(crate) struct LocalServer {
    child: Mutex<Option<Child>>,
    stopped: AtomicBool,
}

impl LocalServer {
    pub(crate) fn ensure_running(&self, logs: &Path) -> Result<()> {
        if ready()? {
            return Ok(()); // A terminal/browser session owns this server; leave it running on exit.
        }

        let root = PathBuf::from(env!("WORKSPACE_REPO_DIR"));
        let vite = root.join("apps/web/node_modules/vite/bin/vite.js");
        if !vite.is_file() {
            bail!(
                "The local checkout is unavailable. Keep the repository at {} and run pnpm install",
                root.display()
            );
        }
        fs::create_dir_all(logs).context("Could not create the desktop log directory")?;
        let log_path = logs.join("local-server.log");
        let output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let mut command = Command::new(env!("WORKSPACE_NODE_BINARY"));
        command
            .arg(&vite)
            .args(["--port", "5173", "--strictPort", "--host", "localhost"])
            .current_dir(root.join("apps/web"))
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        {
            let mut child = self
                .child
                .lock()
                .map_err(|_| anyhow::anyhow!("Server lock unavailable"))?;
            if self.stopped.load(Ordering::Acquire) {
                bail!("The desktop app is closing");
            }
            *child = Some(
                command
                    .spawn()
                    .context("Could not start Node.js for the local workspace")?,
            );
        }

        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline {
            if self.stopped.load(Ordering::Acquire) {
                bail!("The desktop app is closing");
            }
            // During boot Vite can accept connections before the Worker has initialized.
            if matches!(ready(), Ok(true)) {
                return Ok(());
            }
            {
                let mut child = self
                    .child
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Server lock unavailable"))?;
                if let Some(child) = child.as_mut()
                    && let Some(status) = child.try_wait()?
                {
                    bail!(
                        "The local server exited ({status}). Details: {}",
                        log_path.display()
                    );
                }
            }
            thread::sleep(Duration::from_millis(200));
        }
        bail!(
            "The local server did not become ready. Details: {}",
            log_path.display()
        );
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut slot) = self.child.lock()
            && let Some(mut child) = slot.take()
        {
            #[cfg(unix)]
            if let Ok(pid) = i32::try_from(child.id()) {
                use nix::{
                    sys::signal::{Signal, killpg},
                    unistd::Pid,
                };
                // Vite and its Worker subprocesses belong to this app's process group only.
                let _ = killpg(Pid::from_raw(pid), Signal::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn is_workspace_response(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        != Some("200")
    {
        return false;
    }
    let Ok(providers) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    ["google", "apple", "testLogin"]
        .iter()
        .all(|key| providers.get(key).is_some_and(|v| v.is_boolean()))
}

fn ready() -> Result<bool> {
    for address in ("localhost", 5173).to_socket_addrs()? {
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300))
        else {
            continue;
        };
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(
            b"GET /api/providers HTTP/1.0\r\nHost: localhost:5173\r\nConnection: close\r\n\r\n",
        )?;
        let mut response = String::new();
        stream.take(16 * 1024).read_to_string(&mut response)?;
        if !is_workspace_response(&response) {
            bail!("Port 5173 is in use by a server that is not a ready Workspace instance");
        }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::is_workspace_response;

    #[test]
    fn recognizes_the_workspace_health_endpoint() {
        assert!(is_workspace_response(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"google\":false,\"apple\":false,\"testLogin\":true}"
        ));
    }

    #[test]
    fn refuses_an_unrelated_server_or_error_page() {
        for response in [
            "HTTP/1.1 200 OK\r\n\r\n<!doctype html><title>Another app</title>",
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"google\":false,\"apple\":false,\"testLogin\":true}",
            "HTTP/1.1 200 OK\r\n\r\n{\"google\":\"yes\",\"apple\":false,\"testLogin\":true}",
        ] {
            assert!(!is_workspace_response(response));
        }
    }
}

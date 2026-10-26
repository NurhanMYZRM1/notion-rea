use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=WORKSPACE_DESKTOP_URL");
    println!("cargo:rerun-if-env-changed=WORKSPACE_NODE_BINARY");
    let url =
        env::var("WORKSPACE_DESKTOP_URL").unwrap_or_else(|_| "http://localhost:5173".to_owned());
    println!("cargo:rustc-env=WORKSPACE_DESKTOP_URL={url}");

    let root = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets its manifest directory"),
    )
    .join("../../..");
    let root = root
        .canonicalize()
        .expect("the workspace must exist when building");
    println!("cargo:rustc-env=WORKSPACE_REPO_DIR={}", root.display());
    let node = env::var_os("WORKSPACE_NODE_BINARY")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("PATH").and_then(|path| {
                env::split_paths(&path)
                    .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
                    .find(|path| path.is_file())
            })
        })
        .unwrap_or_else(|| PathBuf::from("node"));
    println!("cargo:rustc-env=WORKSPACE_NODE_BINARY={}", node.display());
    tauri_build::build();
}

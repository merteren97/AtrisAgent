use std::{env, fs, path::PathBuf};

fn main() {
    let runtime_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("runtime");
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    if profile == "release" {
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let required = [
            runtime_dir.join(node_name),
            runtime_dir.join("gateway.cjs"),
            runtime_dir.join("control-plane-bridge.mjs"),
            runtime_dir.join("manifest.json"),
            runtime_dir.join("THIRD_PARTY_NOTICES"),
            runtime_dir.join("THIRD_PARTY_NOTICES.sources.json"),
            runtime_dir.join("licenses"),
            runtime_dir.join("node_modules/better-sqlite3/package.json"),
            runtime_dir.join("node_modules/better-sqlite3/lib/index.js"),
            runtime_dir.join("node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
            runtime_dir.join("node_modules/bindings/package.json"),
            runtime_dir.join("node_modules/bindings/bindings.js"),
            runtime_dir.join("node_modules/file-uri-to-path/package.json"),
            runtime_dir.join("node_modules/file-uri-to-path/index.js"),
        ];
        if let Some(missing) = required.iter().find(|path| {
            if path.file_name().is_some_and(|name| name == "licenses") {
                !path.is_dir()
            } else {
                !path.is_file()
            }
        }) {
            panic!(
                "Packaged runtime is incomplete (missing {}). Run `npm run build:runtime-sidecar -w @atris-agent-code/desktop` before a release Tauri build.",
                missing.display()
            );
        }
        let manifest = fs::read_to_string(runtime_dir.join("manifest.json"))
            .expect("could not read packaged runtime manifest");
        let expected_version = format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION"));
        if !manifest.contains(&expected_version)
            || !manifest.contains("\"nodeVersion\":")
            || !manifest.contains("\"notices\":")
        {
            panic!(
                "Packaged runtime manifest does not match AtrisAgent version {} or notice inventory.",
                env!("CARGO_PKG_VERSION")
            );
        }
    } else {
        fs::create_dir_all(&runtime_dir)
            .expect("could not create debug runtime resource directory");
        let placeholder = runtime_dir.join(".dev-placeholder");
        if !placeholder.exists() {
            fs::write(
                &placeholder,
                "debug builds use the external local gateway\n",
            )
            .expect("could not create debug runtime resource placeholder");
        }
    }
    println!("cargo:rerun-if-changed={}", runtime_dir.display());
    tauri_build::build();
}

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

/// Keep browser downloads in an app-owned directory: WebKit can otherwise block its main
/// thread while macOS grants a sandbox extension for a protected Downloads directory.
pub(crate) struct Downloads {
    pub(crate) directory: PathBuf,
    reserved: Mutex<HashSet<String>>,
}

impl Downloads {
    pub(crate) fn new(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        Ok(Self {
            directory,
            reserved: Mutex::new(HashSet::new()),
        })
    }

    pub(crate) fn reserve(&self, suggested: &Path) -> io::Result<PathBuf> {
        let filename: String = suggested
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("download"))
            .to_string_lossy()
            .chars()
            .filter(|ch| !ch.is_control())
            .collect();
        let filename = if filename.is_empty() {
            "download"
        } else {
            &filename
        };
        let leaf = Path::new(filename);
        let stem = leaf
            .file_stem()
            .unwrap_or_else(|| std::ffi::OsStr::new("download"))
            .to_string_lossy();
        let extension = leaf
            .extension()
            .map(|ext| format!(".{}", bounded(&ext.to_string_lossy(), 32)))
            .unwrap_or_default();
        let mut reserved = self
            .reserved
            .lock()
            .map_err(|_| io::Error::other("Export directory lock unavailable"))?;
        for suffix in 0_u32.. {
            let suffix = if suffix == 0 {
                String::new()
            } else {
                format!(" ({suffix})")
            };
            // APFS and other filesystems limit component bytes. Preserve whole UTF-8 characters,
            // including when adding a collision suffix to a long attachment or page title.
            let name = format!(
                "{}{}{}",
                bounded(&stem, 240 - extension.len() - suffix.len()),
                suffix,
                extension
            );
            let key: String = name.nfd().case_fold().nfd().collect();
            let candidate = self.directory.join(&name);
            if !reserved.contains(&key) && !candidate.exists() {
                reserved.insert(key);
                return Ok(candidate);
            }
        }
        Err(io::Error::other("No available export filename"))
    }
}

fn bounded(value: &str, max_bytes: usize) -> String {
    value
        .char_indices()
        .take_while(|(index, ch)| index + ch.len_utf8() <= max_bytes)
        .map(|(_, ch)| ch)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::Downloads;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn directory() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "workspace-export-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn keeps_untrusted_filenames_inside_the_export_directory() {
        let root = directory();
        let exports = Downloads::new(root.clone()).unwrap();
        assert_eq!(
            exports.reserve(Path::new("../../outside.md")).unwrap(),
            root.join("outside.md")
        );
        assert_eq!(
            exports.reserve(Path::new("/")).unwrap(),
            root.join("download")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_overwrites_existing_or_pending_downloads() {
        let root = directory();
        let exports = Downloads::new(root.clone()).unwrap();
        fs::write(root.join("Ideas.md"), "keep existing content").unwrap();
        assert_eq!(
            exports.reserve(Path::new("Ideas.md")).unwrap(),
            root.join("Ideas (1).md")
        );
        assert_eq!(
            exports.reserve(Path::new("Ideas.md")).unwrap(),
            root.join("Ideas (2).md")
        );
        assert_eq!(
            fs::read_to_string(root.join("Ideas.md")).unwrap(),
            "keep existing content"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bounds_unicode_attachment_names_without_splitting_characters() {
        let root = directory();
        let exports = Downloads::new(root.clone()).unwrap();
        let name = format!("{}.{}", "頁".repeat(200), "💡".repeat(40));
        for _ in 0..2 {
            let path = exports.reserve(Path::new(&name)).unwrap();
            assert!(path.file_name().unwrap().to_str().unwrap().len() <= 240);
            fs::write(&path, "valid Unicode export").unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn avoids_case_and_canonical_unicode_collisions_before_downloads_finish() {
        let root = directory();
        let exports = Downloads::new(root.clone()).unwrap();
        exports.reserve(Path::new("Notes.md")).unwrap();
        assert_eq!(
            exports.reserve(Path::new("notes.md")).unwrap(),
            root.join("notes (1).md")
        );
        exports.reserve(Path::new("Nótes.md")).unwrap();
        assert_eq!(
            exports.reserve(Path::new("no\u{301}tes.md")).unwrap(),
            root.join("no\u{301}tes (1).md")
        );
        exports.reserve(Path::new("Straße.md")).unwrap();
        assert_eq!(
            exports.reserve(Path::new("STRASSE.md")).unwrap(),
            root.join("STRASSE (1).md")
        );
        fs::remove_dir_all(root).unwrap();
    }
}

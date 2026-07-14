use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Mirrors the TypeScript scanners' exclude list — directories that are either
/// regenerable, root/system-owned, or risky to walk into file-by-file.
const EXCLUDED_DIR_NAMES: &[&str] = &[
  "node_modules",
  ".git",
  "Library",
  ".Trash",
  ".npm",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  "site-packages",
  "dist",
  "build",
  ".next",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "DerivedData",
  "com.docker.docker",
  "Caches",
  "Extensions",
  "Frameworks",
  "PreferencePanes",
  // Xcode/CLT ships multiple full versioned SDK copies here (MacOSX14.5.sdk,
  // MacOSX15.2.sdk, ...) — cross-version "duplicates" are intentional and toolchain-
  // managed, same reasoning as node_modules/go's module cache.
  "CommandLineTools",
];

/// App-managed library bundles (Photos, iMovie, GarageBand, .app bundles, disk images).
/// These look like single items in Finder but are directories of internal files an app
/// maintains a database/index over — walking into one and touching files individually
/// can corrupt the library. Reported as one opaque item elsewhere, never walked here.
const OPAQUE_BUNDLE_SUFFIXES: &[&str] = &[
  ".photoslibrary",
  ".sparsebundle",
  ".imovielibrary",
  ".tvlibrary",
  ".fcpbundle",
  ".band",
  ".app",
];

pub fn is_opaque_bundle(name: &str) -> bool {
  OPAQUE_BUNDLE_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn is_excluded(name: &str) -> bool {
  (name.starts_with('.') && name != ".") || EXCLUDED_DIR_NAMES.contains(&name)
}

#[derive(Clone)]
pub struct WalkedFile {
  pub path: PathBuf,
  pub size: u64,
  pub mtime_ms: i64,
}

pub struct WalkOptions {
  pub max_entries: usize,
  pub max_depth: usize,
}

impl Default for WalkOptions {
  fn default() -> Self {
    Self { max_entries: 200_000, max_depth: 12 }
  }
}

/// Recursively walks `root`, calling `on_file` for every file found, skipping excluded
/// dirs, opaque bundles, hidden dot-directories, and symlinks. Stops after `max_entries`
/// files to bound worst-case scan time on huge trees.
pub fn walk<F: FnMut(WalkedFile)>(root: &Path, opts: &WalkOptions, mut on_file: F) {
  let mut count = 0usize;
  walk_dir(root, 0, opts, &mut count, &mut on_file);
}

fn walk_dir<F: FnMut(WalkedFile)>(
  dir: &Path,
  depth: usize,
  opts: &WalkOptions,
  count: &mut usize,
  on_file: &mut F,
) {
  if depth > opts.max_depth || *count >= opts.max_entries {
    return;
  }

  let entries = match fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return, // permission denied / gone — skip, don't crash the scan
  };

  let mut subdirs: Vec<PathBuf> = Vec::new();

  for entry in entries.flatten() {
    if *count >= opts.max_entries {
      return;
    }
    let name = entry.file_name();
    let name_str = name.to_string_lossy();
    if is_excluded(&name_str) {
      continue;
    }

    let file_type = match entry.file_type() {
      Ok(ft) => ft,
      Err(_) => continue,
    };
    if file_type.is_symlink() {
      continue;
    }

    if file_type.is_dir() {
      if is_opaque_bundle(&name_str) {
        continue;
      }
      subdirs.push(entry.path());
    } else if file_type.is_file() {
      if let Ok(metadata) = entry.metadata() {
        let mtime_ms = metadata
          .modified()
          .ok()
          .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
          .map(|d| d.as_millis() as i64)
          .unwrap_or(0);
        *count += 1;
        on_file(WalkedFile { path: entry.path(), size: metadata.len(), mtime_ms });
      }
    }
  }

  for dir in subdirs {
    if *count >= opts.max_entries {
      return;
    }
    walk_dir(&dir, depth + 1, opts, count, on_file);
  }
}

pub struct ChildEntry {
  pub name: String,
  pub path: PathBuf,
  /// A directory that shouldn't be recursed into further (see is_opaque_bundle) — still
  /// sized as a whole, just not broken down into its own internals.
  pub is_opaque: bool,
}

/// Immediate children of `dir` — no exclusions applied beyond symlinks (unlike `walk`,
/// which skips node_modules/.git/etc. for cleanup purposes). The disk-usage visualizer
/// wants to show everything, including the things the cleanup scanners hide on purpose.
pub fn list_children(dir: &Path) -> Vec<ChildEntry> {
  let mut result = Vec::new();
  let entries = match fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return result,
  };
  for entry in entries.flatten() {
    let file_type = match entry.file_type() {
      Ok(ft) => ft,
      Err(_) => continue,
    };
    if file_type.is_symlink() {
      continue;
    }
    let name = entry.file_name().to_string_lossy().to_string();
    if file_type.is_dir() {
      let is_opaque = is_opaque_bundle(&name);
      result.push(ChildEntry { name, path: entry.path(), is_opaque });
    } else if file_type.is_file() {
      result.push(ChildEntry { name, path: entry.path(), is_opaque: false });
    }
  }
  result
}

/// Recursive size sum with no exclusions applied (matches plain `du -sk` semantics) — used
/// for sizing a specific target (app bundle, cache folder, opaque library) as a whole.
pub fn dir_size(path: &Path) -> u64 {
  let mut total = 0u64;
  sum_dir(path, &mut total);
  total
}

fn sum_dir(dir: &Path, total: &mut u64) {
  let entries = match fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return,
  };
  for entry in entries.flatten() {
    let file_type = match entry.file_type() {
      Ok(ft) => ft,
      Err(_) => continue,
    };
    if file_type.is_symlink() {
      continue;
    }
    if file_type.is_dir() {
      sum_dir(&entry.path(), total);
    } else if let Ok(metadata) = entry.metadata() {
      *total += metadata.len();
    }
  }
}

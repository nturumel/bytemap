#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

mod breakdown;
mod cache;
mod hash;
mod walk;

use breakdown::{build_tree, DirNode};
use cache::HashCache;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walk::{dir_size as native_dir_size, walk, WalkOptions};

#[napi]
pub fn ping() -> String {
  "pong".to_string()
}

#[napi(object)]
pub struct FileEntry {
  pub path: String,
  pub size: f64,
  pub mtime_ms: f64,
}

#[napi(object)]
pub struct DuplicateGroup {
  pub size: f64,
  pub keeper: String,
  pub duplicates: Vec<String>,
}

type Progress = ThreadsafeFunction<String>;

fn emit(progress: &Progress, msg: impl Into<String>) {
  progress.call(Ok(msg.into()), ThreadsafeFunctionCallMode::NonBlocking);
}

#[napi]
pub async fn dir_size(path: String) -> Result<f64> {
  let size = spawn_blocking(move || native_dir_size(Path::new(&path)))
    .await
    .map_err(|e| Error::from_reason(e.to_string()))?;
  Ok(size as f64)
}

#[napi]
pub async fn dir_sizes(paths: Vec<String>) -> Result<Vec<f64>> {
  spawn_blocking(move || {
    paths
      .par_iter()
      .map(|p| native_dir_size(Path::new(p)) as f64)
      .collect::<Vec<_>>()
  })
  .await
  .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub async fn find_large_files(
  roots: Vec<String>,
  threshold: f64,
  #[napi(ts_arg_type = "(err: Error | null, message: string) => void")] progress: Progress,
) -> Result<Vec<FileEntry>> {
  let threshold = threshold as u64;
  spawn_blocking(move || {
    let mut results = Vec::new();
    for root in &roots {
      emit(&progress, format!("Scanning {root} for large files"));
      walk(Path::new(root), &WalkOptions::default(), |f| {
        if f.size >= threshold {
          results.push(FileEntry {
            path: f.path.to_string_lossy().to_string(),
            size: f.size as f64,
            mtime_ms: f.mtime_ms as f64,
          });
        }
      });
    }
    Ok(results)
  })
  .await
  .map_err(|e| Error::from_reason(e.to_string()))?
}

#[napi]
pub async fn find_duplicates(
  roots: Vec<String>,
  min_size: f64,
  cache_db_path: String,
  #[napi(ts_arg_type = "(err: Error | null, message: string) => void")] progress: Progress,
) -> Result<Vec<DuplicateGroup>> {
  let min_size = min_size as u64;

  spawn_blocking(move || -> Result<Vec<DuplicateGroup>> {
    // Phase 1: index every root, grouping paths by exact size — only files that share a
    // size with at least one sibling are worth hashing at all.
    let mut by_size: HashMap<u64, Vec<(PathBuf, i64)>> = HashMap::new();
    for root in &roots {
      emit(&progress, format!("Indexing {root}"));
      walk(Path::new(root), &WalkOptions { max_entries: 60_000, ..Default::default() }, |f| {
        if f.size >= min_size {
          by_size.entry(f.size).or_default().push((f.path, f.mtime_ms));
        }
      });
    }

    let candidates: Vec<(PathBuf, u64, i64)> = by_size
      .into_iter()
      .filter(|(_, paths)| paths.len() > 1)
      .flat_map(|(size, paths)| paths.into_iter().map(move |(p, m)| (p, size, m)))
      .collect();

    // Phase 2: fingerprint candidates in parallel across CPU cores, reusing the SQLite
    // cache for files whose (size, mtime) haven't changed since the last scan.
    let cache = HashCache::open(&cache_db_path).map_err(|e| Error::from_reason(e.to_string()))?;
    let total = candidates.len();
    let compared = std::sync::atomic::AtomicUsize::new(0);

    let fingerprints: Vec<Option<String>> = candidates
      .par_iter()
      .map(|(path, size, mtime_ms)| {
        let n = compared.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n.is_multiple_of(200) {
          emit(&progress, format!("Comparing files ({n}/{total})"));
        }
        if let Some(cached) = cache.get(path, *size, *mtime_ms) {
          return Some(cached);
        }
        match hash::fingerprint(path, *size) {
          Ok(fp) => {
            cache.put(path, *size, *mtime_ms, &fp);
            Some(fp)
          }
          Err(_) => None,
        }
      })
      .collect();

    // Phase 3: group by (size, hash); oldest mtime in each group is the keeper.
    let mut by_key: HashMap<(u64, String), Vec<(PathBuf, i64)>> = HashMap::new();
    for ((path, size, mtime_ms), fp) in candidates.iter().zip(fingerprints) {
      if let Some(fp) = fp {
        by_key.entry((*size, fp)).or_default().push((path.clone(), *mtime_ms));
      }
    }

    let mut groups = Vec::new();
    for ((size, _), mut paths) in by_key {
      if paths.len() < 2 {
        continue;
      }
      paths.sort_by_key(|(_, mtime)| *mtime);
      let keeper = paths.remove(0).0;
      groups.push(DuplicateGroup {
        size: size as f64,
        keeper: keeper.to_string_lossy().to_string(),
        duplicates: paths.into_iter().map(|(p, _)| p.to_string_lossy().to_string()).collect(),
      });
    }

    Ok(groups)
  })
  .await
  .map_err(|e| Error::from_reason(e.to_string()))?
}

/// Breaks down the immediate children of `path` for the disk-usage visualizer (each child
/// itself expanded `max_depth` levels deep) — unlike the cleanup scanners, this doesn't
/// hide node_modules/.git/caches/etc.; the whole point is showing where the bytes actually
/// went. Sizing something like ~/Library fully can take tens of seconds with no exclusions
/// to skip, so results stream back one child at a time via `on_child` as they complete
/// (rayon processes children in parallel, so they arrive out of size order) rather than
/// blocking the caller until every child is done.
#[napi]
pub async fn dir_breakdown_stream(
  path: String,
  max_depth: u32,
  #[napi(ts_arg_type = "(err: Error | null, node: DirNode) => void")] on_child: ThreadsafeFunction<DirNode>,
) -> Result<()> {
  spawn_blocking(move || {
    let p = Path::new(&path);
    let children = walk::list_children(p);
    children.par_iter().for_each(|c| {
      let node = if c.is_opaque {
        DirNode {
          name: c.name.clone(),
          path: c.path.to_string_lossy().to_string(),
          size: native_dir_size(&c.path) as f64,
          is_dir: true,
          children: None,
        }
      } else {
        build_tree(&c.path, c.name.clone(), 1, max_depth)
      };
      on_child.call(Ok(node), ThreadsafeFunctionCallMode::NonBlocking);
    });
  })
  .await
  .map_err(|e| Error::from_reason(e.to_string()))
}

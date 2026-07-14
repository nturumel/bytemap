use crate::walk::{dir_size, list_children};
use rayon::prelude::*;
use std::fs;
use std::path::Path;

#[napi(object)]
pub struct DirNode {
  pub name: String,
  pub path: String,
  pub size: f64,
  pub is_dir: bool,
  /// None means "not broken down further" — either a file, a depth cutoff, or an opaque
  /// bundle — not "empty directory" (that would be Some(vec![])).
  pub children: Option<Vec<DirNode>>,
}

/// Builds a size-sorted tree of `path` down to `max_depth` levels of children. Beyond that
/// depth (or inside an opaque bundle) a node still gets an accurate total size via
/// `dir_size`, it just isn't broken down into its own children — keeps the response bounded
/// for huge trees while staying accurate about where the bytes actually are.
pub fn build_tree(path: &Path, name: String, depth: u32, max_depth: u32) -> DirNode {
  let metadata = match fs::symlink_metadata(path) {
    Ok(m) => m,
    Err(_) => {
      return DirNode { name, path: path.to_string_lossy().to_string(), size: 0.0, is_dir: false, children: None }
    }
  };

  if !metadata.is_dir() {
    return DirNode {
      name,
      path: path.to_string_lossy().to_string(),
      size: metadata.len() as f64,
      is_dir: false,
      children: None,
    };
  }

  if depth >= max_depth {
    return DirNode {
      name,
      path: path.to_string_lossy().to_string(),
      size: dir_size(path) as f64,
      is_dir: true,
      children: None,
    };
  }

  let children = list_children(path);
  let mut built: Vec<DirNode> = children
    .par_iter()
    .map(|c| {
      if c.is_opaque {
        DirNode {
          name: c.name.clone(),
          path: c.path.to_string_lossy().to_string(),
          size: dir_size(&c.path) as f64,
          is_dir: true,
          children: None,
        }
      } else {
        build_tree(&c.path, c.name.clone(), depth + 1, max_depth)
      }
    })
    .collect();

  built.sort_by(|a, b| b.size.partial_cmp(&a.size).unwrap_or(std::cmp::Ordering::Equal));
  let total: f64 = built.iter().map(|n| n.size).sum();

  DirNode { name, path: path.to_string_lossy().to_string(), size: total, is_dir: true, children: Some(built) }
}

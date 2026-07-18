use crate::walk::{dir_size_cancellable, list_children};
use std::fs;
use std::path::Path;

pub struct DirNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    /// None means "not broken down further" — either a file, a depth cutoff, or an opaque
    /// bundle — not "empty directory" (that would be Some(vec![])).
    pub children: Option<Vec<DirNode>>,
}

/// Builds a size-sorted tree of `path` down to `max_depth` levels of children. Beyond that
/// depth (or inside an opaque bundle) a node still gets an accurate total size via
/// `dir_size`, it just isn't broken down into its own children — keeps the response bounded
/// for huge trees while staying accurate about where the bytes actually are.
/// Returns `None` when the operation is cancelled, checking before each subtree.
pub fn build_tree_cancellable(
    path: &Path,
    name: String,
    depth: u32,
    max_depth: u32,
    cancelled: &dyn Fn() -> bool,
) -> Option<DirNode> {
    if cancelled() {
        return None;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Some(DirNode {
                name,
                path: path.to_string_lossy().to_string(),
                size: 0,
                is_dir: false,
                children: None,
            });
        }
    };

    if !metadata.is_dir() {
        #[cfg(unix)]
        let size = {
            use std::os::unix::fs::MetadataExt;
            let allocated = metadata.blocks().saturating_mul(512);
            if allocated > 0 {
                allocated
            } else {
                metadata.len()
            }
        };
        #[cfg(not(unix))]
        let size = metadata.len();
        return Some(DirNode {
            name,
            path: path.to_string_lossy().to_string(),
            size,
            is_dir: false,
            children: None,
        });
    }

    if depth >= max_depth {
        return dir_size_cancellable(path, cancelled).map(|size| DirNode {
            name,
            path: path.to_string_lossy().to_string(),
            size,
            is_dir: true,
            children: None,
        });
    }

    let children = list_children(path);
    let mut built = Vec::with_capacity(children.len());
    for child in children {
        if cancelled() {
            return None;
        }
        let node = if child.is_opaque {
            dir_size_cancellable(&child.path, cancelled).map(|size| DirNode {
                name: child.name,
                path: child.path.to_string_lossy().to_string(),
                size,
                is_dir: true,
                children: None,
            })
        } else {
            build_tree_cancellable(&child.path, child.name, depth + 1, max_depth, cancelled)
        };
        built.push(node?);
    }
    built.sort_by(|left, right| right.size.cmp(&left.size));
    let size = built.iter().map(|node| node.size).sum();
    Some(DirNode {
        name,
        path: path.to_string_lossy().to_string(),
        size,
        is_dir: true,
        children: Some(built),
    })
}

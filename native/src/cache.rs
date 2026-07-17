use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

// rusqlite::Connection isn't Sync (internal statement cache uses RefCell), and this cache
// is shared across rayon's worker threads while hashing — a Mutex serializes DB access,
// which is fine since hashing dominates the per-file cost, not the cache lookup/write.
pub struct HashCache {
    conn: Mutex<Connection>,
}

impl HashCache {
    pub fn open(db_path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
       CREATE TABLE IF NOT EXISTS file_hashes (
         path TEXT PRIMARY KEY,
         size INTEGER NOT NULL,
         mtime_ms INTEGER NOT NULL,
         hash TEXT NOT NULL
       );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Returns the cached hash only if size and mtime still match — anything else means the
    /// file changed since we last hashed it, so the caller should recompute.
    pub fn get(&self, path: &Path, size: u64, mtime_ms: i64) -> Option<String> {
        let path_str = path.to_string_lossy();
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT hash FROM file_hashes WHERE path = ?1 AND size = ?2 AND mtime_ms = ?3",
            params![path_str, size as i64, mtime_ms],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn put(&self, path: &Path, size: u64, mtime_ms: i64, hash: &str) {
        let path_str = path.to_string_lossy();
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
        "INSERT INTO file_hashes (path, size, mtime_ms, hash) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash",
        params![path_str, size as i64, mtime_ms, hash],
      );
        }
    }
}

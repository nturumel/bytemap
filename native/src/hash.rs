use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const FULL_HASH_LIMIT: u64 = 20 * 1024 * 1024; // 20MB
const PARTIAL_CHUNK: u64 = 5 * 1024 * 1024;

/// Full BLAKE3 hash for small files; size-anchored first+last chunk fingerprint for large
/// ones (matches the previous Node implementation's trade-off between accuracy and speed
/// on multi-GB files).

/// Returns `Ok(None)` if the caller cancelled while a file was being read.
pub fn fingerprint_cancellable<C: Fn() -> bool>(
    path: &Path,
    size: u64,
    cancelled: C,
) -> io::Result<Option<String>> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();

    if size <= FULL_HASH_LIMIT {
        hash_range(&mut file, &mut hasher, 0, size, &cancelled)?;
    } else {
        hasher.update(&size.to_le_bytes());
        hash_range(&mut file, &mut hasher, 0, PARTIAL_CHUNK, &cancelled)?;
        let tail_start = size.saturating_sub(PARTIAL_CHUNK);
        hash_range(
            &mut file,
            &mut hasher,
            tail_start,
            PARTIAL_CHUNK,
            &cancelled,
        )?;
    }

    if cancelled() {
        Ok(None)
    } else {
        Ok(Some(hasher.finalize().to_hex().to_string()))
    }
}

fn hash_range<C: Fn() -> bool>(
    file: &mut File,
    hasher: &mut blake3::Hasher,
    start: u64,
    length: u64,
    cancelled: &C,
) -> io::Result<()> {
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = length;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        if cancelled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let to_read = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

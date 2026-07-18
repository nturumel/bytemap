mod breakdown;
mod cache;
mod hash;
mod walk;

use breakdown::{build_tree_cancellable, DirNode as InternalDirNode};
use cache::HashCache;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::transport::Server;
use tonic::{Request, Response, Status};
use walk::{dir_size, dir_size_cancellable, list_children, walk_cancellable, WalkOptions};

pub mod scanner {
    tonic::include_proto!("bytemap.scanner.v1");
}

use scanner::scanner_backend_server::{ScannerBackend, ScannerBackendServer};
use scanner::{
    breakdown_event, duplicate_event, large_file_event, BreakdownEvent, CancelResponse, Complete,
    DirBreakdownRequest, DirNode, DirSizesResponse, Empty, FileEntry, FindDuplicatesRequest,
    FindLargeFilesRequest, HealthResponse, LargeFileEvent, OperationRequest, PathRequest, PathSize,
    PathsRequest, Progress, SizeResponse,
};

struct EventStream<T> {
    inner: ReceiverStream<Result<T, Status>>,
    cancellation: CancellationToken,
}

impl<T> EventStream<T> {
    fn new(receiver: mpsc::Receiver<Result<T, Status>>, cancellation: CancellationToken) -> Self {
        Self {
            inner: ReceiverStream::new(receiver),
            cancellation,
        }
    }
}

impl<T> Stream for EventStream<T> {
    type Item = Result<T, Status>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(context)
    }
}

impl<T> Drop for EventStream<T> {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
struct ActiveOperation {
    nonce: u64,
    token: CancellationToken,
}

#[derive(Default)]
struct OperationRegistry {
    next_nonce: AtomicU64,
    active: Mutex<HashMap<String, ActiveOperation>>,
}

impl OperationRegistry {
    fn register(&self, request_id: &str) -> Result<ActiveOperation, Status> {
        if request_id.is_empty() {
            return Err(Status::invalid_argument("request_id is required"));
        }
        let operation = ActiveOperation {
            nonce: self.next_nonce.fetch_add(1, Ordering::Relaxed),
            token: CancellationToken::new(),
        };
        let previous = self
            .active
            .lock()
            .expect("operation registry lock poisoned")
            .insert(request_id.to_owned(), operation.clone());
        if let Some(previous) = previous {
            previous.token.cancel();
        }
        Ok(operation)
    }

    fn cancel(&self, request_id: &str) -> bool {
        let operation = self
            .active
            .lock()
            .expect("operation registry lock poisoned")
            .get(request_id)
            .cloned();
        if let Some(operation) = operation {
            operation.token.cancel();
            true
        } else {
            false
        }
    }

    fn finish(&self, request_id: &str, nonce: u64) {
        let mut active = self
            .active
            .lock()
            .expect("operation registry lock poisoned");
        if active
            .get(request_id)
            .is_some_and(|operation| operation.nonce == nonce)
        {
            active.remove(request_id);
        }
    }
}

#[derive(Clone)]
struct ScannerService {
    operations: Arc<OperationRegistry>,
    shutdown: CancellationToken,
}

impl ScannerService {
    fn cancelled(&self, operation: &ActiveOperation) -> bool {
        operation.token.is_cancelled() || self.shutdown.is_cancelled()
    }

    fn complete_operation(&self, request_id: &str, operation: &ActiveOperation) {
        self.operations.finish(request_id, operation.nonce);
    }
}

fn send_stream_item<T>(
    sender: &mpsc::Sender<Result<T, Status>>,
    operation: &CancellationToken,
    shutdown: &CancellationToken,
    item: T,
) -> bool {
    let mut pending = Ok(item);
    loop {
        if operation.is_cancelled() || shutdown.is_cancelled() {
            return false;
        }
        match sender.try_send(pending) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => {
                operation.cancel();
                return false;
            }
            Err(mpsc::error::TrySendError::Full(item)) => {
                pending = item;
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn send_stream_error<T>(sender: &mpsc::Sender<Result<T, Status>>, status: Status) {
    let _ = sender.blocking_send(Err(status));
}

fn large_progress(message: String) -> LargeFileEvent {
    LargeFileEvent {
        event: Some(large_file_event::Event::Progress(Progress { message })),
    }
}

fn duplicate_progress(message: String) -> scanner::DuplicateEvent {
    scanner::DuplicateEvent {
        event: Some(duplicate_event::Event::Progress(Progress { message })),
    }
}

fn proto_node(node: InternalDirNode) -> DirNode {
    let children_expanded = node.children.is_some();
    let children = node
        .children
        .unwrap_or_default()
        .into_iter()
        .map(proto_node)
        .collect();
    DirNode {
        name: node.name,
        path: node.path,
        size: node.size,
        is_dir: node.is_dir,
        children,
        children_expanded,
    }
}

#[tonic::async_trait]
impl ScannerBackend for ScannerService {
    type FindLargeFilesStream = EventStream<LargeFileEvent>;
    type FindDuplicatesStream = EventStream<scanner::DuplicateEvent>;
    type DirBreakdownStream = EventStream<BreakdownEvent>;

    async fn health(&self, _: Request<Empty>) -> Result<Response<HealthResponse>, Status> {
        Ok(Response::new(HealthResponse {
            ok: true,
            version: env!("CARGO_PKG_VERSION").to_owned(),
        }))
    }

    async fn dir_size(
        &self,
        request: Request<PathRequest>,
    ) -> Result<Response<SizeResponse>, Status> {
        let path = request.into_inner().path;
        let size = tokio::task::spawn_blocking(move || dir_size(Path::new(&path)))
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        Ok(Response::new(SizeResponse { size }))
    }

    async fn dir_sizes(
        &self,
        request: Request<PathsRequest>,
    ) -> Result<Response<DirSizesResponse>, Status> {
        let paths = request.into_inner().paths;
        let entries = tokio::task::spawn_blocking(move || {
            paths
                .par_iter()
                .map(|path| PathSize {
                    path: path.clone(),
                    size: dir_size(Path::new(path)),
                })
                .collect()
        })
        .await
        .map_err(|error| Status::internal(error.to_string()))?;
        Ok(Response::new(DirSizesResponse { entries }))
    }

    async fn find_large_files(
        &self,
        request: Request<FindLargeFilesRequest>,
    ) -> Result<Response<Self::FindLargeFilesStream>, Status> {
        let request = request.into_inner();
        let request_id = request.request_id.clone();
        let operation = self.operations.register(&request_id)?;
        let service = self.clone();
        let (sender, receiver) = mpsc::channel(64);
        let stream = EventStream::new(receiver, operation.token.clone());
        tokio::task::spawn_blocking(move || {
            for root in request.roots {
                if service.cancelled(&operation) {
                    break;
                }
                if !send_stream_item(
                    &sender,
                    &operation.token,
                    &service.shutdown,
                    large_progress(format!("Scanning {root} for large files")),
                ) {
                    break;
                }
                let token = operation.token.clone();
                let shutdown = service.shutdown.clone();
                let completed = walk_cancellable(
                    Path::new(&root),
                    &WalkOptions::default(),
                    || token.is_cancelled() || shutdown.is_cancelled(),
                    |file| {
                        if file.size >= request.threshold {
                            let event = LargeFileEvent {
                                event: Some(large_file_event::Event::File(FileEntry {
                                    path: file.path.to_string_lossy().to_string(),
                                    size: file.size,
                                    mtime_ms: file.mtime_ms,
                                })),
                            };
                            let _ = send_stream_item(&sender, &token, &shutdown, event);
                        }
                    },
                );
                if !completed || service.cancelled(&operation) {
                    break;
                }
            }
            if !service.cancelled(&operation) {
                let _ = send_stream_item(
                    &sender,
                    &operation.token,
                    &service.shutdown,
                    LargeFileEvent {
                        event: Some(large_file_event::Event::Complete(Complete {})),
                    },
                );
            }
            service.complete_operation(&request_id, &operation);
        });
        Ok(Response::new(stream))
    }

    async fn find_duplicates(
        &self,
        request: Request<FindDuplicatesRequest>,
    ) -> Result<Response<Self::FindDuplicatesStream>, Status> {
        let request = request.into_inner();
        let request_id = request.request_id.clone();
        let operation = self.operations.register(&request_id)?;
        let service = self.clone();
        let (sender, receiver) = mpsc::channel(64);
        let stream = EventStream::new(receiver, operation.token.clone());
        tokio::task::spawn_blocking(move || {
            let mut by_size: HashMap<u64, Vec<(PathBuf, i64)>> = HashMap::new();
            for root in &request.roots {
                if service.cancelled(&operation)
                    || !send_stream_item(
                        &sender,
                        &operation.token,
                        &service.shutdown,
                        duplicate_progress(format!("Indexing {root}")),
                    )
                {
                    service.complete_operation(&request_id, &operation);
                    return;
                }
                let token = operation.token.clone();
                let shutdown = service.shutdown.clone();
                let completed = walk_cancellable(
                    Path::new(root),
                    &WalkOptions {
                        max_entries: 60_000,
                        ..Default::default()
                    },
                    || token.is_cancelled() || shutdown.is_cancelled(),
                    |file| {
                        if file.size >= request.min_size {
                            by_size
                                .entry(file.size)
                                .or_default()
                                .push((file.path, file.mtime_ms));
                        }
                    },
                );
                if !completed || service.cancelled(&operation) {
                    service.complete_operation(&request_id, &operation);
                    return;
                }
            }

            let candidates: Vec<(PathBuf, u64, i64)> = by_size
                .into_iter()
                .filter(|(_, paths)| paths.len() > 1)
                .flat_map(|(size, paths)| {
                    paths
                        .into_iter()
                        .map(move |(path, mtime)| (path, size, mtime))
                })
                .collect();
            let cache = match HashCache::open(&request.cache_db_path) {
                Ok(cache) => Arc::new(cache),
                Err(error) => {
                    send_stream_error(&sender, Status::internal(error.to_string()));
                    service.complete_operation(&request_id, &operation);
                    return;
                }
            };
            let total = candidates.len();
            let compared = AtomicU64::new(0);
            let token = operation.token.clone();
            let shutdown = service.shutdown.clone();
            let fingerprints: Vec<Option<String>> = candidates
                .par_iter()
                .map(|(path, size, mtime_ms)| {
                    if token.is_cancelled() || shutdown.is_cancelled() {
                        return None;
                    }
                    let index = compared.fetch_add(1, Ordering::Relaxed);
                    if index.is_multiple_of(200)
                        && !send_stream_item(
                            &sender,
                            &token,
                            &shutdown,
                            duplicate_progress(format!("Comparing files ({index}/{total})")),
                        )
                    {
                        return None;
                    }
                    if let Some(cached) = cache.get(path, *size, *mtime_ms) {
                        return Some(cached);
                    }
                    match hash::fingerprint_cancellable(path, *size, || {
                        token.is_cancelled() || shutdown.is_cancelled()
                    }) {
                        Ok(Some(fingerprint)) => {
                            if !token.is_cancelled() && !shutdown.is_cancelled() {
                                cache.put(path, *size, *mtime_ms, &fingerprint);
                                Some(fingerprint)
                            } else {
                                None
                            }
                        }
                        Ok(None) | Err(_) => None,
                    }
                })
                .collect();
            if service.cancelled(&operation) {
                service.complete_operation(&request_id, &operation);
                return;
            }

            let mut by_key: HashMap<(u64, String), Vec<(PathBuf, i64)>> = HashMap::new();
            for ((path, size, mtime_ms), fingerprint) in candidates.iter().zip(fingerprints) {
                if let Some(fingerprint) = fingerprint {
                    by_key
                        .entry((*size, fingerprint))
                        .or_default()
                        .push((path.clone(), *mtime_ms));
                }
            }
            for ((size, _), mut paths) in by_key {
                if service.cancelled(&operation) {
                    service.complete_operation(&request_id, &operation);
                    return;
                }
                if paths.len() < 2 {
                    continue;
                }
                paths.sort_by_key(|(_, mtime)| *mtime);
                let keeper = paths.remove(0).0.to_string_lossy().to_string();
                let duplicates = paths
                    .into_iter()
                    .map(|(path, _)| path.to_string_lossy().to_string())
                    .collect();
                let event = scanner::DuplicateEvent {
                    event: Some(duplicate_event::Event::Group(scanner::DuplicateGroup {
                        size,
                        keeper,
                        duplicates,
                    })),
                };
                if !send_stream_item(&sender, &operation.token, &service.shutdown, event) {
                    service.complete_operation(&request_id, &operation);
                    return;
                }
            }
            let _ = send_stream_item(
                &sender,
                &operation.token,
                &service.shutdown,
                scanner::DuplicateEvent {
                    event: Some(duplicate_event::Event::Complete(Complete {})),
                },
            );
            service.complete_operation(&request_id, &operation);
        });
        Ok(Response::new(stream))
    }

    async fn dir_breakdown(
        &self,
        request: Request<DirBreakdownRequest>,
    ) -> Result<Response<Self::DirBreakdownStream>, Status> {
        let request = request.into_inner();
        let request_id = request.request_id.clone();
        let operation = self.operations.register(&request_id)?;
        let service = self.clone();
        let (sender, receiver) = mpsc::channel(64);
        let stream = EventStream::new(receiver, operation.token.clone());
        tokio::task::spawn_blocking(move || {
            let children = list_children(Path::new(&request.path));
            let token = operation.token.clone();
            let shutdown = service.shutdown.clone();
            children.par_iter().for_each(|child| {
                if token.is_cancelled() || shutdown.is_cancelled() {
                    return;
                }
                let node = if child.is_opaque {
                    dir_size_cancellable(&child.path, || {
                        token.is_cancelled() || shutdown.is_cancelled()
                    })
                    .map(|size| InternalDirNode {
                        name: child.name.clone(),
                        path: child.path.to_string_lossy().to_string(),
                        size,
                        is_dir: true,
                        children: None,
                    })
                } else {
                    let cancelled = || token.is_cancelled() || shutdown.is_cancelled();
                    build_tree_cancellable(
                        &child.path,
                        child.name.clone(),
                        1,
                        request.max_depth,
                        &cancelled,
                    )
                };
                if let Some(node) = node {
                    let event = BreakdownEvent {
                        event: Some(breakdown_event::Event::Node(proto_node(node))),
                    };
                    let _ = send_stream_item(&sender, &token, &shutdown, event);
                }
            });
            if !service.cancelled(&operation) {
                let _ = send_stream_item(
                    &sender,
                    &operation.token,
                    &service.shutdown,
                    BreakdownEvent {
                        event: Some(breakdown_event::Event::Complete(Complete {})),
                    },
                );
            }
            service.complete_operation(&request_id, &operation);
        });
        Ok(Response::new(stream))
    }

    async fn cancel(
        &self,
        request: Request<OperationRequest>,
    ) -> Result<Response<CancelResponse>, Status> {
        let request_id = request.into_inner().request_id;
        if request_id.is_empty() {
            return Ok(Response::new(CancelResponse {
                ok: false,
                reason: "request_id is required".to_owned(),
            }));
        }
        if self.operations.cancel(&request_id) {
            Ok(Response::new(CancelResponse {
                ok: true,
                reason: "cancelled".to_owned(),
            }))
        } else {
            Ok(Response::new(CancelResponse {
                ok: false,
                reason: "operation not found".to_owned(),
            }))
        }
    }

    async fn shutdown(&self, _: Request<Empty>) -> Result<Response<Empty>, Status> {
        self.shutdown.cancel();
        Ok(Response::new(Empty {}))
    }
}

async fn wait_for_signal() -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address: SocketAddr = listener.local_addr()?;
    let shutdown = CancellationToken::new();
    let service = ScannerService {
        operations: Arc::new(OperationRegistry::default()),
        shutdown: shutdown.clone(),
    };
    let server_shutdown = shutdown.clone();
    let server = Server::builder()
        .add_service(ScannerBackendServer::new(service))
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async move {
            server_shutdown.cancelled().await;
        });
    let mut server_task = tokio::spawn(server);

    println!("BYTEMAP_SCANNER_GRPC_READY {}", address.port());
    std::io::stdout().flush()?;

    tokio::select! {
        result = &mut server_task => result??,
        result = wait_for_signal() => {
            result?;
            shutdown.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut server_task).await;
        }
        _ = shutdown.cancelled() => {
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut server_task).await;
        }
    }
    Ok(())
}

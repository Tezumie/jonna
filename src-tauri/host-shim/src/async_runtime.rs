//! The shared async runtime: one multi-threaded tokio runtime for the process, made on first
//! use, as the desktop framework keeps one.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use crate::{Error, Result};

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            // No threads or no I/O driver: nothing in the host can run.
            Err(e) => panic!("the async runtime didn't start: {e}"),
        }
    })
}

/// A spawned task. Awaiting it gives the task's value, or an error when it panicked or was
/// aborted.
#[derive(Debug)]
pub struct JoinHandle<T>(tokio::task::JoinHandle<T>);

impl<T> JoinHandle<T> {
    /// Cancels the task at its next await point.
    pub fn abort(&self) {
        self.0.abort();
    }

    /// The tokio handle underneath.
    pub fn inner(&self) -> &tokio::task::JoinHandle<T> {
        &self.0
    }
}

impl<T> Future for JoinHandle<T> {
    type Output = Result<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map_err(|e| Error::Join(e.to_string()))
    }
}

/// Runs a future on the shared runtime.
pub fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    JoinHandle(runtime().spawn(task))
}

/// Runs blocking work on the runtime's blocking threads.
pub fn spawn_blocking<F, R>(work: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    JoinHandle(runtime().spawn_blocking(work))
}

/// Runs a future to its end on the calling thread (not from inside the runtime).
pub fn block_on<F: Future>(task: F) -> F::Output {
    runtime().block_on(task)
}

/// The shared runtime's handle (for code that needs tokio's own API).
pub fn handle() -> tokio::runtime::Handle {
    runtime().handle().clone()
}

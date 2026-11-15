//! The app handle and what hangs off it: managed state, the app's folders, and the name of the
//! client a command came from (where the desktop has a window's label).

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::marker::PhantomData;
use std::ops::Deref;
use std::sync::{Arc, RwLock};

use crate::path::PathResolver;

/// The framework is generic over its window runtime; the IDE's code names the parameter in a
/// few signatures. There is one here, and it does nothing.
pub trait Runtime: Send + Sync + 'static {}

/// The only "runtime" of the host build.
#[derive(Debug, Clone, Copy)]
pub struct Wry;

impl Runtime for Wry {}

/// What the app is, from its product file and package.
#[derive(Debug, Clone)]
pub struct Config {
    /// The app's identifier: the name of its folders.
    pub identifier: String,
    pub product_name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
}

/// Managed values live as long as the process (one host is one app), so they're kept leaked:
/// a `State` is then a plain reference, as in the framework.
type Managed = &'static (dyn Any + Send + Sync);

struct AppInner {
    config: Config,
    package: PackageInfo,
    paths: PathResolver,
    states: RwLock<HashMap<TypeId, Managed>>,
}

/// A handle to the app: cheap to clone, the same app behind every clone.
pub struct AppHandle<R: Runtime = Wry> {
    inner: Arc<AppInner>,
    runtime: PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for AppHandle<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            runtime: PhantomData,
        }
    }
}

impl<R: Runtime> std::fmt::Debug for AppHandle<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppHandle")
            .field("identifier", &self.inner.config.identifier)
            .finish()
    }
}

impl AppHandle<Wry> {
    /// The app named `identifier` (its folders), `product_name` (its resources on Linux) and
    /// `version`.
    pub fn new(identifier: &str, product_name: &str, version: &str) -> Self {
        Self {
            inner: Arc::new(AppInner {
                config: Config {
                    identifier: identifier.to_string(),
                    product_name: Some(product_name.to_string()),
                    version: Some(version.to_string()),
                },
                package: PackageInfo {
                    name: product_name.to_string(),
                    version: version.to_string(),
                },
                paths: PathResolver::new(identifier, product_name),
                states: RwLock::new(HashMap::new()),
            }),
            runtime: PhantomData,
        }
    }
}

impl<R: Runtime> AppHandle<R> {
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn package_info(&self) -> &PackageInfo {
        &self.inner.package
    }
}

/// A managed value, lent to a command.
pub struct State<'r, T: Send + Sync + 'static>(&'r T);

impl<'r, T: Send + Sync + 'static> State<'r, T> {
    /// The value itself, for as long as the app lives.
    pub fn inner(&self) -> &'r T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        State(self.0)
    }
}

impl<T: Send + Sync + 'static + std::fmt::Debug> std::fmt::Debug for State<'_, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("State").field(&self.0).finish()
    }
}

/// What the handle, and the stand-ins for a window, all offer.
pub trait Manager<R: Runtime>: Sized {
    fn app_handle(&self) -> &AppHandle<R>;

    /// Keeps `state` for the app's life. False when a value of this type is already kept (the
    /// first one stays).
    fn manage<T: Send + Sync + 'static>(&self, state: T) -> bool {
        let inner = &self.app_handle().inner;
        let Ok(mut states) = inner.states.write() else {
            return false;
        };
        if states.contains_key(&TypeId::of::<T>()) {
            return false;
        }
        let kept: &'static T = Box::leak(Box::new(state));
        states.insert(TypeId::of::<T>(), kept);
        true
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        let inner = &self.app_handle().inner;
        let states = inner.states.read().ok()?;
        let kept: Managed = states.get(&TypeId::of::<T>()).copied()?;
        kept.downcast_ref::<T>().map(State)
    }

    /// The managed value of type `T`. Panics when none was managed, as the framework does: a
    /// command asking for state the app never set up is a programming error.
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        match self.try_state() {
            Some(state) => state,
            None => panic!("state not managed: {}", std::any::type_name::<T>()),
        }
    }

    fn path(&self) -> &PathResolver {
        &self.app_handle().inner.paths
    }
}

impl<R: Runtime> Manager<R> for AppHandle<R> {
    fn app_handle(&self) -> &AppHandle<R> {
        self
    }
}

macro_rules! client_stand_in {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug)]
        pub struct $name<R: Runtime = Wry> {
            app: AppHandle<R>,
            label: Arc<str>,
        }

        impl<R: Runtime> Clone for $name<R> {
            fn clone(&self) -> Self {
                Self {
                    app: self.app.clone(),
                    label: self.label.clone(),
                }
            }
        }

        impl<R: Runtime> $name<R> {
            pub fn new(app: AppHandle<R>, label: &str) -> Self {
                Self {
                    app,
                    label: Arc::from(label),
                }
            }

            /// The name of the client the command came from.
            pub fn label(&self) -> &str {
                &self.label
            }
        }

        impl<R: Runtime> Manager<R> for $name<R> {
            fn app_handle(&self) -> &AppHandle<R> {
                &self.app
            }
        }
    };
}

client_stand_in!(
    /// Where a command came from. The desktop has a web view here; the host has only the
    /// client's name, which is all the commands kept in the host build ask of it (who owns a
    /// request, so it can be cancelled when that client goes).
    Webview
);
client_stand_in!(
    /// See [`Webview`].
    Window
);
client_stand_in!(
    /// See [`Webview`].
    WebviewWindow
);

impl<R: Runtime> Webview<R> {
    /// The window the view is in: the same client.
    pub fn window(&self) -> Window<R> {
        Window {
            app: self.app.clone(),
            label: self.label.clone(),
        }
    }
}

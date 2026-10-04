// Deep links, such as "mortium://invite/abc" or
// "mortium://auth/callback#code=x". The scheme comes from
// plugins.deep-link in tauri.conf.json. A link can arrive before the web
// app listens for it (a link that starts the app), so the links wait in a
// buffer until the web app calls `desktop_init`.
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

const DEFAULT_SCHEME: &str = "mortium";

/// The URL scheme of this app.
pub fn scheme<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("deep-link")
        .and_then(|config| config.pointer("/desktop/schemes/0"))
        .and_then(|value| value.as_str())
        .unwrap_or(DEFAULT_SCHEME)
        .to_owned()
}

/// The links that wait for the web app. None once the web app listens.
pub struct PendingLinks(Mutex<Option<Vec<String>>>);

impl PendingLinks {
    pub fn new() -> Self {
        Self(Mutex::new(Some(Vec::new())))
    }

    /// Give the waiting links to the web app. Later links go out as events.
    pub fn take(&self) -> Vec<String> {
        self.0.lock().map(|mut links| links.take().unwrap_or_default()).unwrap_or_default()
    }
}

/// Keep only links with the scheme of this app.
fn own_links(scheme: &str, urls: Vec<url::Url>) -> Vec<String> {
    urls.into_iter().filter(|url| url.scheme() == scheme).map(String::from).collect()
}

fn deliver<R: tauri::Runtime>(app: &tauri::AppHandle<R>, links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    let pending = app.state::<PendingLinks>();
    let Ok(mut buffer) = pending.0.lock() else {
        return;
    };
    match buffer.as_mut() {
        Some(waiting) => waiting.extend(links),
        None => {
            let _ = app.emit_to("main", "deep-link", links);
        }
    }
}

/// Register the scheme in a development build, keep the start links, and
/// watch for new links.
pub fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    app.manage(PendingLinks::new());
    // An installed app has the scheme from its installer. A development
    // build must register it for the current user.
    #[cfg(any(windows, target_os = "linux"))]
    if tauri::is_dev() {
        let _ = app.deep_link().register_all();
    }
    let scheme = scheme(app);
    if let Ok(Some(start)) = app.deep_link().get_current() {
        deliver(app, own_links(&scheme, start));
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        crate::window::show_main(&handle);
        deliver(&handle, own_links(&scheme, event.urls()));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_links_of_this_app() {
        let urls = vec![
            url::Url::parse("mortium://invite/abc").unwrap(),
            url::Url::parse("https://example.com/").unwrap(),
            url::Url::parse("mortium://auth/callback#code=x").unwrap(),
        ];
        assert_eq!(
            own_links("mortium", urls),
            ["mortium://invite/abc", "mortium://auth/callback#code=x"]
        );
    }

    #[test]
    fn gives_the_waiting_links_once() {
        let pending = PendingLinks::new();
        pending.0.lock().unwrap().as_mut().unwrap().push("mortium://invite/a".into());
        assert_eq!(pending.take(), ["mortium://invite/a"]);
        assert!(pending.take().is_empty());
        assert!(pending.0.lock().unwrap().is_none());
    }
}

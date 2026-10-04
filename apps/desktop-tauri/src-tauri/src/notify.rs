// System notifications of the desktop app.
//
// - Windows: a toast. A click on it opens the deep link
//   "<scheme>://notification/<id>". The single-instance plugin gives that
//   link to the running app, which shows the window and opens the channel.
//   This works also from the Action Center, after the toast goes away.
// - macOS: a notification through the system notification center. A click
//   brings the app to the front, but it does not open the channel (see
//   docs/concepts/desktop-shells.md).

/// The notification id comes from the web app. Only a short id is allowed,
/// because it goes into a deep link.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(windows)]
fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The toast XML. `launch` is the deep link that a click opens.
#[cfg(windows)]
fn toast_xml(launch: &str, title: &str, body: &str) -> String {
    format!(
        "<toast launch=\"{}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(launch),
        escape_xml(title),
        escape_xml(body)
    )
}

#[cfg(windows)]
fn show(app_id: &str, launch: &str, title: &str, body: &str) -> windows::core::Result<()> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(launch, title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
}

/// The app id of the toasts. The installer registers the app identifier.
/// A build that runs from the target folder is not installed, so it uses
/// the id of PowerShell, which Windows always knows.
#[cfg(windows)]
fn app_id<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    const POWERSHELL_APP_ID: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .is_some_and(|dir| !dir.ends_with("target\\debug") && !dir.ends_with("target\\release"));
    if installed {
        app.config().identifier.clone()
    } else {
        POWERSHELL_APP_ID.to_owned()
    }
}

#[tauri::command]
pub fn notify<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String, title: String, body: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("The notification id is not valid.".into());
    }
    #[cfg(windows)]
    {
        let launch = format!("{}://notification/{id}", crate::deep_link::scheme(&app));
        let app_id = app_id(&app);
        // The COM calls block for a short time, so they run off the main thread.
        std::thread::spawn(move || {
            let _ = show(&app_id, &launch, &title, &body);
        });
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = if tauri::is_dev() { "com.apple.Terminal".to_owned() } else { app.config().identifier.clone() };
        std::thread::spawn(move || {
            let _ = mac_notification_sys::set_application(&bundle);
            let _ = mac_notification_sys::send_notification(&title, None, &body, None);
        });
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, title, body);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_short_plain_ids() {
        assert!(valid_id("42"));
        assert!(!valid_id(""));
        assert!(!valid_id("1/../2"));
        assert!(!valid_id(&"1".repeat(33)));
    }

    #[cfg(windows)]
    #[test]
    fn escapes_text_in_the_toast_xml() {
        let xml = toast_xml("mortium://notification/1", "A <b> & \"c\"", "it's");
        assert!(xml.contains("<text>A &lt;b&gt; &amp; &quot;c&quot;</text>"));
        assert!(xml.contains("<text>it&apos;s</text>"));
        assert!(xml.contains("launch=\"mortium://notification/1\""));
    }
}

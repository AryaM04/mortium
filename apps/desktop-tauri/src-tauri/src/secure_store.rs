// The secure store of the desktop app: the OS key store (Windows Credential
// Manager, macOS Keychain). It keeps only small values: the session tokens,
// the key that wraps the crypto data (the pickle key), and the server
// address. The bulk crypto data stays in IndexedDB, encrypted with the
// pickle key. The service name of each entry is the app identifier.

/// The Windows Credential Manager keeps at most 2560 bytes for each value,
/// as UTF-16. So a value can have at most 1280 UTF-16 units.
const MAX_VALUE_UNITS: usize = 1280;
const MAX_KEY_LENGTH: usize = 128;

fn check_key(key: &str) -> Result<(), String> {
    let valid = !key.is_empty()
        && key.len() <= MAX_KEY_LENGTH
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    if valid {
        Ok(())
    } else {
        Err("The key name of the secure store is not valid.".into())
    }
}

fn entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
    check_key(key)?;
    keyring::Entry::new(service, key).map_err(|error| format!("The OS key store is not available: {error}"))
}

/// Read a value. Returns None when the entry does not exist.
pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
    match entry(service, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("The OS key store did not give the value: {error}")),
    }
}

pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
    if value.encode_utf16().count() > MAX_VALUE_UNITS {
        return Err("The value is too large for the OS key store.".into());
    }
    entry(service, key)?
        .set_password(value)
        .map_err(|error| format!("The OS key store did not keep the value: {error}"))
}

pub fn delete(service: &str, key: &str) -> Result<(), String> {
    match entry(service, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("The OS key store did not remove the value: {error}")),
    }
}

fn service<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.config().identifier.clone()
}

#[tauri::command]
pub fn secure_get<R: tauri::Runtime>(app: tauri::AppHandle<R>, key: String) -> Result<Option<String>, String> {
    get(&service(&app), &key)
}

#[tauri::command]
pub fn secure_set<R: tauri::Runtime>(app: tauri::AppHandle<R>, key: String, value: String) -> Result<(), String> {
    set(&service(&app), &key, &value)
}

#[tauri::command]
pub fn secure_delete<R: tauri::Runtime>(app: tauri::AppHandle<R>, key: String) -> Result<(), String> {
    delete(&service(&app), &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_key_names_of_the_web_app() {
        assert!(check_key("session").is_ok());
        assert!(check_key("server-url").is_ok());
        assert!(check_key("crypto-pickle-key:123456789:AbCdEf_-12").is_ok());
    }

    #[test]
    fn refuses_bad_key_names() {
        assert!(check_key("").is_err());
        assert!(check_key("a/b").is_err());
        assert!(check_key("with space").is_err());
        assert!(check_key(&"k".repeat(MAX_KEY_LENGTH + 1)).is_err());
    }

    #[test]
    fn refuses_a_value_that_is_too_large() {
        let result = set("com.mortium.test", "large", &"x".repeat(MAX_VALUE_UNITS + 1));
        assert!(result.is_err());
    }
}

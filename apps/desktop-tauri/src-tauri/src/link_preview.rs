// The link preview fetch of the desktop app. The app fetches the page (and
// then its image) of a link that the user sends. The rules are the same as
// the server route (packages/link-preview-fetch/src/address-check.ts), so a
// link cannot reach the private network of the user:
//
// - Only http and https, only ports 80 and 443, no user name or password.
// - Each host name is resolved here. A name with one private, loopback,
//   link-local, unique-local, multicast or other special address is
//   refused, and the connection uses only the checked addresses.
// - At most 3 redirects. Each redirect target goes through the same checks.
// - A time limit of at most 3 s, 512 KiB of HTML (the rest is not read),
//   and a 2 MiB image (a larger image is refused).
//
// This module never logs, and its errors never hold the URL.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;
use url::Url;

pub const MAX_TIMEOUT_MS: u64 = 3000;
pub const MAX_HTML_BYTES: usize = 512 * 1024;
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 3;
pub const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const URL_NOT_ALLOWED: &str = "URL_NOT_ALLOWED";
const NO_PREVIEW: &str = "NO_PREVIEW";

/// The IPv4 networks that the app must not connect to, as (address, prefix length).
const BLOCKED_V4: [([u8; 4], u8); 15] = [
    ([0, 0, 0, 0], 8),       // "this" network
    ([10, 0, 0, 0], 8),      // private
    ([100, 64, 0, 0], 10),   // carrier-grade NAT
    ([127, 0, 0, 0], 8),     // loopback
    ([169, 254, 0, 0], 16),  // link-local, cloud metadata
    ([172, 16, 0, 0], 12),   // private
    ([192, 0, 0, 0], 24),    // IETF protocol assignments
    ([192, 0, 2, 0], 24),    // documentation
    ([192, 88, 99, 0], 24),  // 6to4 relay
    ([192, 168, 0, 0], 16),  // private
    ([198, 18, 0, 0], 15),   // benchmarks
    ([198, 51, 100, 0], 24), // documentation
    ([203, 0, 113, 0], 24),  // documentation
    ([224, 0, 0, 0], 4),     // multicast
    ([240, 0, 0, 0], 4),     // reserved and broadcast
];

/// The IPv6 networks that the app must not connect to. An IPv4-mapped
/// address (::ffff:a.b.c.d) is checked against the IPv4 rules.
const BLOCKED_V6: [(u128, u8); 11] = [
    (0, 128),                                      // unspecified
    (1, 128),                                      // loopback
    (0x0064_ff9b_0000_0000_0000_0000_0000_0000, 96), // NAT64
    (0x0100_0000_0000_0000_0000_0000_0000_0000, 64), // discard
    (0x2001_0000_0000_0000_0000_0000_0000_0000, 32), // Teredo
    (0x2001_0db8_0000_0000_0000_0000_0000_0000, 32), // documentation
    (0x2002_0000_0000_0000_0000_0000_0000_0000, 16), // 6to4
    (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),  // unique local
    (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10), // link-local
    (0xfec0_0000_0000_0000_0000_0000_0000_0000, 10), // site-local (old)
    (0xff00_0000_0000_0000_0000_0000_0000_0000, 8),  // multicast
];

fn in_v4_network(address: Ipv4Addr, network: [u8; 4], prefix: u8) -> bool {
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix)) };
    u32::from(address) & mask == u32::from(Ipv4Addr::from(network)) & mask
}

fn in_v6_network(address: Ipv6Addr, network: u128, prefix: u8) -> bool {
    let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(prefix)) };
    u128::from(address) & mask == network & mask
}

/// True when the app must not connect to this address.
pub fn is_blocked_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => BLOCKED_V4
            .iter()
            .any(|(network, prefix)| in_v4_network(v4, *network, *prefix)),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_blocked_address(IpAddr::V4(v4)),
            None => BLOCKED_V6
                .iter()
                .any(|(network, prefix)| in_v6_network(v6, *network, *prefix)),
        },
    }
}

/// Check the parts of a URL that do not need DNS.
pub fn check_url(url: &Url) -> Result<(), &'static str> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(URL_NOT_ALLOWED);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(URL_NOT_ALLOWED);
    }
    // `port()` is None for the default port of the scheme (80 or 443).
    if let Some(port) = url.port() {
        if port != 80 && port != 443 {
            return Err(URL_NOT_ALLOWED);
        }
    }
    match url.host() {
        None => Err(URL_NOT_ALLOWED),
        Some(url::Host::Ipv4(v4)) if is_blocked_address(IpAddr::V4(v4)) => Err(URL_NOT_ALLOWED),
        Some(url::Host::Ipv6(v6)) if is_blocked_address(IpAddr::V6(v6)) => Err(URL_NOT_ALLOWED),
        Some(_) => Ok(()),
    }
}

/// A resolver that refuses a name with one blocked address. It gives the
/// HTTP client only checked addresses, so a second DNS answer (DNS
/// rebinding) cannot change the target.
struct CheckedResolver;

impl Resolve for CheckedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|_| Box::<dyn std::error::Error + Send + Sync>::from(NO_PREVIEW))?
                .collect();
            if addresses.is_empty() || addresses.iter().any(|address| is_blocked_address(address.ip())) {
                return Err(Box::<dyn std::error::Error + Send + Sync>::from(URL_NOT_ALLOWED));
            }
            let addrs: Addrs = Box::new(addresses.into_iter());
            Ok(addrs)
        })
    }
}

/// The page or the image that the app fetched.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedResource {
    /// The URL after redirects.
    pub url: String,
    /// For a page: the Content-Type header. For an image: its checked type.
    pub content_type: String,
    /// The body, as base64url without padding.
    pub body: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Page,
    Image,
}

fn client() -> Result<reqwest::Client, &'static str> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // A proxy would make its own DNS lookup, past the checks here.
        .no_proxy()
        .dns_resolver(Arc::new(CheckedResolver))
        .user_agent("MortiumLinkPreview/1.0")
        .build()
        .map_err(|_| NO_PREVIEW)
}

/// GET with the checks on each hop. Returns the final response.
async fn safe_get(client: &reqwest::Client, start: Url, accept: &str) -> Result<reqwest::Response, &'static str> {
    let mut url = start;
    for hop in 0.. {
        check_url(&url)?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, accept)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|error| {
                // The resolver refusal comes back inside the connect error.
                if format!("{error:?}").contains(URL_NOT_ALLOWED) {
                    URL_NOT_ALLOWED
                } else {
                    NO_PREVIEW
                }
            })?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let Some(location) = location else {
            return Ok(response);
        };
        if hop >= MAX_REDIRECTS {
            return Err(NO_PREVIEW);
        }
        url = url.join(&location).map_err(|_| NO_PREVIEW)?;
    }
    Err(NO_PREVIEW)
}

/// Read at most `max` bytes. `cut` true keeps the first `max` bytes of a
/// longer body. `cut` false refuses a longer body.
async fn read_body(mut response: reqwest::Response, max: usize, cut: bool) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NO_PREVIEW)? {
        if body.len() + chunk.len() > max {
            if !cut {
                return Err(NO_PREVIEW);
            }
            body.extend_from_slice(&chunk[..max - body.len()]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_inner(url: Url, kind: Kind) -> Result<FetchedResource, &'static str> {
    let client = client()?;
    let accept = match kind {
        Kind::Page => "text/html,application/xhtml+xml".to_owned(),
        Kind::Image => IMAGE_TYPES.join(","),
    };
    let response = safe_get(&client, url, &accept).await?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(NO_PREVIEW);
    }
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = match kind {
        Kind::Page => {
            let lower = content_type.to_ascii_lowercase();
            if !lower.starts_with("text/html") && !lower.starts_with("application/xhtml+xml") {
                return Err(NO_PREVIEW);
            }
            read_body(response, MAX_HTML_BYTES, true).await?
        }
        Kind::Image => {
            let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !IMAGE_TYPES.contains(&mime.as_str()) {
                return Err(NO_PREVIEW);
            }
            if response.content_length().is_some_and(|length| length > MAX_IMAGE_BYTES as u64) {
                return Err(NO_PREVIEW);
            }
            let bytes = read_body(response, MAX_IMAGE_BYTES, false).await?;
            if bytes.is_empty() {
                return Err(NO_PREVIEW);
            }
            return Ok(FetchedResource {
                url: final_url,
                content_type: mime,
                body: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
            });
        }
    };
    Ok(FetchedResource {
        url: final_url,
        content_type,
        body: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body),
    })
}

/// Fetch a page or an image for a link preview, with the checks above.
/// The time limit is at most 3 s.
pub async fn fetch(raw_url: &str, kind: Kind, timeout_ms: u64) -> Result<FetchedResource, &'static str> {
    let url = Url::parse(raw_url).map_err(|_| URL_NOT_ALLOWED)?;
    check_url(&url)?;
    let limit = Duration::from_millis(timeout_ms.min(MAX_TIMEOUT_MS));
    tokio::time::timeout(limit, fetch_inner(url, kind))
        .await
        .map_err(|_| NO_PREVIEW)?
}

/// The command for the web app. `kind` is "page" or "image". The error is
/// "URL_NOT_ALLOWED" or "NO_PREVIEW", never the URL.
#[tauri::command]
pub async fn link_preview_fetch(url: String, kind: String, timeout_ms: u64) -> Result<FetchedResource, String> {
    let kind = match kind.as_str() {
        "page" => Kind::Page,
        "image" => Kind::Image,
        _ => return Err(URL_NOT_ALLOWED.to_owned()),
    };
    fetch(&url, kind, timeout_ms).await.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(text: &str) -> bool {
        is_blocked_address(text.parse().unwrap())
    }

    #[test]
    fn blocks_private_loopback_and_special_ipv4() {
        for address in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.10",
            "192.0.2.5",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(blocked(address), "{address} must be blocked");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        for address in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "11.0.0.1"] {
            assert!(!blocked(address), "{address} must be allowed");
        }
    }

    #[test]
    fn blocks_private_loopback_and_special_ipv6() {
        for address in [
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::a00:1",
            "2002::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
        ] {
            assert!(blocked(address), "{address} must be blocked");
        }
    }

    #[test]
    fn allows_public_ipv6() {
        for address in ["2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"] {
            assert!(!blocked(address), "{address} must be allowed");
        }
    }

    fn url_ok(text: &str) -> bool {
        check_url(&Url::parse(text).unwrap()).is_ok()
    }

    #[test]
    fn checks_scheme_port_credentials_and_literal_hosts() {
        assert!(url_ok("https://example.com/page"));
        assert!(url_ok("http://example.com:80/"));
        assert!(url_ok("https://example.com:443/"));
        assert!(!url_ok("ftp://example.com/"));
        assert!(!url_ok("file:///etc/passwd"));
        assert!(!url_ok("https://example.com:8443/"));
        assert!(!url_ok("http://example.com:22/"));
        assert!(!url_ok("https://user:secret@example.com/"));
        assert!(!url_ok("http://127.0.0.1/"));
        assert!(!url_ok("http://[::1]/"));
        assert!(!url_ok("http://169.254.169.254/latest/meta-data"));
        // The URL parser reads these short forms of 127.0.0.1 as IPv4 addresses.
        assert!(!url_ok("http://2130706433/"));
        assert!(!url_ok("http://0x7f.1/"));
    }

    #[tokio::test]
    async fn refuses_a_host_name_that_resolves_to_loopback() {
        let result = fetch("http://localhost/", Kind::Page, 2000).await;
        assert_eq!(result.unwrap_err(), URL_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn refuses_a_literal_private_address_before_any_connection() {
        let result = fetch("http://10.0.0.1/", Kind::Page, 2000).await;
        assert_eq!(result.unwrap_err(), URL_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn refuses_an_unknown_kind_and_a_bad_url() {
        assert_eq!(
            link_preview_fetch("http://example.com/".into(), "script".into(), 1000).await.unwrap_err(),
            URL_NOT_ALLOWED
        );
        assert_eq!(fetch("not a url", Kind::Page, 1000).await.unwrap_err(), URL_NOT_ALLOWED);
    }
}

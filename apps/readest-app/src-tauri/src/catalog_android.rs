use crate::browser_fetch::{book_signature_matches, resource_url};
use std::io::Read;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_native_bridge::{
    CatalogFileRequest, CatalogPageRequest, NativeBridgeExt, WebBrowserPage,
};

const ORIGIN: &str = "https://zh.z-library.sk";

fn catalog_url(raw: &str) -> Result<Url, String> {
    let url = resource_url(raw)?;
    if url.origin().ascii_serialization() != ORIGIN {
        return Err("Invalid catalog URL".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn read_catalog_page(app: AppHandle, url: String) -> Result<WebBrowserPage, String> {
    let url = catalog_url(&url)?;
    if url.path() != "/" && !url.path().starts_with("/s/") && !url.path().starts_with("/book/") {
        return Err("Invalid catalog URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.native_bridge()
            .read_catalog_page(CatalogPageRequest { url: url.into() })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_catalog_book(
    app: AppHandle,
    url: String,
    format: String,
    referer: String,
) -> Result<Option<String>, String> {
    let mut target = catalog_url(&url)?;
    let mut detail = catalog_url(&referer)?;
    if !target.path().starts_with("/dl/")
        || !detail.path().starts_with("/book/")
        || !matches!(
            format.as_str(),
            "epub" | "pdf" | "azw3" | "mobi" | "fb2" | "txt"
        )
    {
        return Err("Invalid catalog download".into());
    }
    detail.set_fragment(None);
    let directory = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join(format!("catalog-{}.{}", uuid::Uuid::new_v4(), format));
        // Own the scratch file before the Android downloader opens it.
        std::fs::File::create_new(&path).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(600);
        let result = (|| {
            let mut referer = Some(detail.to_string());
            for _ in 0..10 {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("Catalog download timed out")?;
                let hop = app
                    .native_bridge()
                    .catalog_file_hop(CatalogFileRequest {
                        url: target.to_string(),
                        path: path.to_string_lossy().into_owned(),
                        referer: referer.clone(),
                        remaining_ms: remaining.as_millis() as u64,
                    })
                    .map_err(|e| e.to_string())?;
                match hop.status {
                    301 | 302 | 303 | 307 | 308 => {
                        let location = hop.location.ok_or("Missing catalog redirect")?;
                        let resolved = target
                            .join(&location)
                            .map_err(|_| "Invalid catalog redirect")?;
                        let next = resource_url(resolved.as_str())?;
                        if next.scheme() != "https" {
                            return Err("Insecure catalog redirect".into());
                        }
                        if next.origin() != target.origin() {
                            referer = None;
                        }
                        target = next;
                    }
                    404 | 410 => return Ok(None),
                    200..=299 => {
                        let mut prefix = Vec::with_capacity(512);
                        std::fs::File::open(&path)
                            .and_then(|f| f.take(512).read_to_end(&mut prefix))
                            .map_err(|e| e.to_string())?;
                        if !book_signature_matches(&format, &prefix) {
                            return Err("Catalog returned an unexpected file".into());
                        }
                        return Ok(Some(path.to_string_lossy().into_owned()));
                    }
                    status => return Err(format!("Catalog HTTP {status}")),
                }
            }
            Err("Too many catalog redirects".into())
        })();
        if !matches!(&result, Ok(Some(_))) {
            let _ = std::fs::remove_file(&path);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::{
    process::{Command, Stdio},
    thread,
};

const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";
const RELEASE_PATH_PREFIX: &str = "/xgq947-ship-it/video-reverse-prompt/releases/download/";
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct DownloadedUpdate {
    path: PathBuf,
    version: String,
    expected_size: u64,
    digest: String,
}

#[derive(Default)]
pub struct UpdateRuntimeState {
    downloaded: Mutex<Option<DownloadedUpdate>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadRequest {
    url: String,
    version: String,
    expected_size: u64,
    digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    version: String,
    size: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

fn normalized_digest(value: &str) -> Result<String, String> {
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| "更新包缺少 GitHub SHA-256 校验值。".to_string())?
        .to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("更新包 SHA-256 校验值无效。".to_string());
    }
    Ok(digest)
}

fn valid_version(value: &str) -> bool {
    let version = value.strip_prefix('v').unwrap_or(value);
    !version.is_empty()
        && version.len() <= 64
        && version.as_bytes()[0].is_ascii_digit()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn validate_request(request: &UpdateDownloadRequest) -> Result<(Url, String), String> {
    if !valid_version(&request.version) {
        return Err("更新版本号无效。".to_string());
    }
    if request.expected_size == 0 || request.expected_size > MAX_UPDATE_BYTES {
        return Err("更新包大小无效。".to_string());
    }
    let digest = normalized_digest(&request.digest)?;
    let url = Url::parse(&request.url).map_err(|_| "更新包下载地址无效。".to_string())?;
    let expected_prefix = format!("{}{}/", RELEASE_PATH_PREFIX, request.version);
    let path = url.path();
    let trusted = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && path.starts_with(&expected_prefix)
        && path.to_ascii_lowercase().ends_with("_x64-setup.exe");
    if !trusted {
        return Err("仅允许安装 Video Reverse Prompt 官方 GitHub Release。".to_string());
    }
    Ok((url, digest))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "无法读取已下载的更新包。".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "读取更新包时发生错误。".to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_file(path: &Path, expected_size: u64, digest: &str) -> Result<(), String> {
    let actual_size = fs::metadata(path)
        .map_err(|_| "已下载的更新包不存在。".to_string())?
        .len();
    if actual_size != expected_size {
        return Err("更新包大小校验失败，请重新下载。".to_string());
    }
    if sha256_file(path)? != digest {
        return Err("更新包 SHA-256 校验失败，已拒绝安装。".to_string());
    }
    Ok(())
}

fn update_paths(app: &AppHandle, version: &str) -> Result<(PathBuf, PathBuf), String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法访问应用更新缓存。".to_string())?
        .join("updates");
    fs::create_dir_all(&directory).map_err(|_| "无法创建应用更新缓存。".to_string())?;
    let safe_version: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let target = directory.join(format!("Video-Reverse-Prompt-{safe_version}-x64-setup.exe"));
    let partial = directory.join(format!("Video-Reverse-Prompt-{safe_version}-x64-setup.exe.part"));
    Ok((target, partial))
}

fn publish_progress(app: &AppHandle, downloaded_bytes: u64, total_bytes: u64, percent: u8) {
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        UpdateDownloadProgress {
            downloaded_bytes,
            total_bytes,
            percent,
        },
    );
}

async fn download_to_path(
    app: &AppHandle,
    url: Url,
    partial: &Path,
    expected_size: u64,
    expected_digest: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Video-Reverse-Prompt/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|_| "无法初始化安全下载器。".to_string())?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("下载更新失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载更新失败：GitHub 返回 {}。", response.status()));
    }

    let mut file = File::create(partial).map_err(|_| "无法创建更新包缓存文件。".to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_percent = u8::MAX;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("下载更新中断：{error}"))?
    {
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "更新包大小溢出。".to_string())?;
        if downloaded > expected_size || downloaded > MAX_UPDATE_BYTES {
            return Err("更新包实际大小超过 GitHub 声明值，已停止下载。".to_string());
        }
        file.write_all(&chunk)
            .map_err(|_| "无法写入更新包缓存。".to_string())?;
        hasher.update(&chunk);
        let percent = ((downloaded * 100) / expected_size).min(100) as u8;
        if percent != last_percent {
            publish_progress(app, downloaded, expected_size, percent);
            last_percent = percent;
        }
    }
    file.flush()
        .map_err(|_| "无法完成更新包写入。".to_string())?;
    file.sync_all()
        .map_err(|_| "无法同步更新包到磁盘。".to_string())?;
    drop(file);

    if downloaded != expected_size {
        return Err("更新包下载不完整，请重新下载。".to_string());
    }
    let actual_digest = format!("{:x}", hasher.finalize());
    if actual_digest != expected_digest {
        return Err("更新包 SHA-256 校验失败，已删除下载文件。".to_string());
    }
    publish_progress(app, downloaded, expected_size, 100);
    Ok(())
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, UpdateRuntimeState>,
    request: UpdateDownloadRequest,
) -> Result<UpdateDownloadResult, String> {
    if !cfg!(target_os = "windows") {
        return Err("macOS 当前使用浏览器下载更新。".to_string());
    }
    let (url, digest) = validate_request(&request)?;
    let (target, partial) = update_paths(&app, &request.version)?;
    let _ = fs::remove_file(&partial);

    if target.exists() && verify_file(&target, request.expected_size, &digest).is_ok() {
        publish_progress(&app, request.expected_size, request.expected_size, 100);
    } else {
        let _ = fs::remove_file(&target);
        let result = download_to_path(&app, url, &partial, request.expected_size, &digest).await;
        if let Err(error) = result {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        fs::rename(&partial, &target).map_err(|_| "无法保存已校验的更新包。".to_string())?;
    }

    verify_file(&target, request.expected_size, &digest)?;
    let downloaded = DownloadedUpdate {
        path: target,
        version: request.version.clone(),
        expected_size: request.expected_size,
        digest,
    };
    *state
        .downloaded
        .lock()
        .map_err(|_| "更新器状态不可用。".to_string())? = Some(downloaded);
    Ok(UpdateDownloadResult {
        version: request.version,
        size: request.expected_size,
    })
}

#[tauri::command]
pub fn install_downloaded_update(
    app: AppHandle,
    state: State<'_, UpdateRuntimeState>,
) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        return Err("macOS 当前使用浏览器下载更新。".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        let update = state
            .downloaded
            .lock()
            .map_err(|_| "更新器状态不可用。".to_string())?
            .clone()
            .ok_or_else(|| "请先下载更新。".to_string())?;
        verify_file(&update.path, update.expected_size, &update.digest)?;

        let mut installer = Command::new(&update.path);
        installer
            .args(["/P", "/R", "/UPDATE"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|_| "无法启动 Windows 更新安装器。".to_string())?;

        let app_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            app_handle.exit(0);
        });
        Ok(format!(
            "{} 已校验，应用即将重启并覆盖安装。",
            update.version
        ))
    }
}

pub fn cleanup_update_cache(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = fs::remove_dir_all(cache.join("updates"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> UpdateDownloadRequest {
        UpdateDownloadRequest {
      url: "https://github.com/xgq947-ship-it/video-reverse-prompt/releases/download/v0.1.0/Video.Reverse.Prompt_0.1.0_x64-setup.exe".to_string(),
      version: "v0.1.0".to_string(),
      expected_size: 25_000_000,
      digest: format!("sha256:{}", "a".repeat(64)),
    }
    }

    #[test]
    fn accepts_official_windows_release() {
        assert!(validate_request(&valid_request()).is_ok());
    }

    #[test]
    fn rejects_external_or_unverified_installer() {
        let mut request = valid_request();
        request.url = "https://example.com/Video.Reverse.Prompt_0.1.0_x64-setup.exe".to_string();
        assert!(validate_request(&request).is_err());
        request = valid_request();
        request.digest = "sha256:1234".to_string();
        assert!(validate_request(&request).is_err());
    }
}

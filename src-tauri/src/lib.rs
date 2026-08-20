use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
  fs,
  io::{BufRead, BufReader, Write},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  thread,
  time::Duration,
};
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

mod updater;
use updater::{cleanup_update_cache, download_update, install_downloaded_update, UpdateRuntimeState};

#[cfg(target_os = "windows")]
fn hide_console_window(command: &mut Command) {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_window(_command: &mut Command) {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRequest {
  command: String,
  gemini_url: Option<String>,
  file_path: Option<String>,
  media_type: Option<String>,
  prompt: Option<String>,
  media_input: Option<String>,
  output_dir: Option<String>,
  reverse_response: Option<String>,
  duration: Option<f64>,
  filename: Option<String>,
  storyboard_mode: Option<String>,
  protagonist_tags: Option<Vec<String>>,
  generator: Option<Value>,
  browser_behavior: Option<String>,
  debug: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
struct ProgressPayload {
  stage: String,
  message: String,
}

#[derive(Debug, Serialize)]
struct FileMetadata {
  name: String,
  size: u64,
}

#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
  let file_path = PathBuf::from(&path);
  let metadata = fs::metadata(&file_path).map_err(|_| "无法读取文件。".to_string())?;
  if !metadata.is_file() {
    return Err("请选择一个文件。".to_string());
  }
  let name = file_path
    .file_name()
    .and_then(|value| value.to_str())
    .ok_or_else(|| "文件名无效。".to_string())?
    .to_string();
  Ok(FileMetadata { name, size: metadata.len() })
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  let allowed = url.starts_with("https://github.com/xgq947-ship-it/video-reverse-prompt")
    && !url.contains(['\n', '\r']);
  if !allowed {
    return Err("仅允许打开 Video Reverse Prompt 官方 GitHub 链接。".to_string());
  }
  #[cfg(target_os = "windows")]
  let status = Command::new("rundll32.exe")
    .args(["url.dll,FileProtocolHandler", &url])
    .status()
    .map_err(|_| "无法打开浏览器。".to_string())?;
  #[cfg(not(target_os = "windows"))]
  let status = Command::new("/usr/bin/open").arg(&url).status().map_err(|_| "无法打开浏览器。".to_string())?;
  if status.success() { Ok(()) } else { Err("浏览器未能打开该链接。".to_string()) }
}

fn current_app_bundle() -> Result<PathBuf, String> {
  let executable = std::env::current_exe().map_err(|_| "无法定位当前应用。".to_string())?;
  executable
    .ancestors()
    .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
    .map(Path::to_path_buf)
    .ok_or_else(|| "开发模式不执行完整卸载，请在已安装的 Video Reverse Prompt.app 中使用此功能。".to_string())
}

fn remove_local_path(path: &Path) {
  if path.is_dir() {
    let _ = fs::remove_dir_all(path);
  } else if path.exists() {
    let _ = fs::remove_file(path);
  }
}

#[tauri::command]
fn uninstall_app(app: tauri::AppHandle) -> Result<String, String> {
  let bundle = current_app_bundle()?;
  let bundle_text = bundle.to_string_lossy().to_string();
  let status = Command::new("/usr/bin/osascript")
    .args([
      "-e", "on run argv",
      "-e", "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
      "-e", "end run",
      "--", &bundle_text,
    ])
    .status()
    .map_err(|_| "无法将应用移到废纸篓。".to_string())?;
  if !status.success() {
    return Err("应用未能移到废纸篓，卸载已取消。".to_string());
  }

  if let Ok(data_dir) = app.path().app_data_dir() { remove_local_path(&data_dir); }
  if let Ok(cache_dir) = app.path().app_cache_dir() { remove_local_path(&cache_dir); }
  if let Ok(home) = app.path().home_dir() {
    for relative in [
      "Library/Application Support/VideoReversePrompt",
      "Library/Preferences/com.videoreverseprompt.desktop.plist",
      "Library/Saved Application State/com.videoreverseprompt.desktop.savedState",
      "Library/WebKit/com.videoreverseprompt.desktop",
      "Library/HTTPStorages/com.videoreverseprompt.desktop",
      "Library/Logs/com.videoreverseprompt.desktop",
    ] {
      remove_local_path(&home.join(relative));
    }
  }

  let app_handle = app.clone();
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(350));
    app_handle.exit(0);
  });
  Ok("卸载完成，应用即将退出。".to_string())
}

fn automation_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if cfg!(debug_assertions) {
    return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .expect("src-tauri must have a parent")
      .join("automation/playwright-service/dist/index.js"));
  }
  app.path()
    .resource_dir()
    .map(|path| path.join("automation/playwright-service/dist/index.js"))
    .map_err(|_| "找不到自动化服务资源。".to_string())
}

fn automation_runtime(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if cfg!(debug_assertions) { return Ok(PathBuf::from("node")); }
  let executable = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
  app.path()
    .resource_dir()
    .map(|path| path.join("runtime/node").join(executable))
    .map_err(|_| "找不到内置 Node.js 运行时。".to_string())
}

fn browser_hub_payload(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if cfg!(debug_assertions) {
    return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .expect("src-tauri must have a parent")
      .join("browser-hub-payload/current"));
  }
  app.path()
    .resource_dir()
    .map(|path| path.join("browser-hub-payload/current"))
    .map_err(|_| "找不到共享浏览器运行时。".to_string())
}

#[tauri::command]
async fn run_automation(app: tauri::AppHandle, mut request: AutomationRequest) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let script = automation_script(&app)?;
    if !script.exists() {
      return Err("Node 自动化服务未构建，请先运行 npm run automation:build。".to_string());
    }

    let runtime = automation_runtime(&app)?;
    if !cfg!(debug_assertions) && !runtime.exists() {
      return Err("内置 Node.js 运行时缺失，请重新安装应用。".to_string());
    }
    let needs_browser = matches!(
      request.command.as_str(),
      "open" | "check-login" | "compatibility" | "analyze" | "refine"
    );
    let hub_payload = if needs_browser {
      let payload = browser_hub_payload(&app)?;
      if !payload.exists() {
        return Err("共享浏览器运行时缺失，请重新安装应用。".to_string());
      }
      Some(payload)
    } else if request.command == "resolve-video" {
      let imports_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法访问应用缓存目录。".to_string())?
        .join("video-imports");
      fs::create_dir_all(&imports_dir).map_err(|_| "无法创建视频缓存目录。".to_string())?;
      request.output_dir = Some(imports_dir.to_string_lossy().to_string());
      None
    } else {
      None
    };
    let (skill_root, project_root) = if cfg!(debug_assertions) {
      let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent")
        .to_path_buf();
      (root.join("skills"), root)
    } else {
      let resource_root = app.path().resource_dir().map_err(|_| "找不到应用资源目录。".to_string())?;
      let data_root = app.path().app_data_dir().map_err(|_| "无法访问应用数据目录。".to_string())?;
      fs::create_dir_all(&data_root).map_err(|_| "无法创建应用数据目录。".to_string())?;
      (resource_root.join("skills"), data_root)
    };
    let body = serde_json::to_string(&request).map_err(|_| "无法编码自动化请求。".to_string())?;
    let mut command = Command::new(runtime);
    hide_console_window(&mut command);
    command
      .arg(&script)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    if let Some(payload) = hub_payload {
      command.env("AI_BROWSER_HUB_PAYLOAD", payload);
    }
    command
      .env("VIDEO_REVERSE_PROMPT_SKILL_ROOT", skill_root)
      .env("VIDEO_REVERSE_PROMPT_PROJECT_ROOT", project_root);
    let mut child = command
      .spawn()
      .map_err(|_| "无法启动视频分析与提示词生成服务。".to_string())?;

    let mut child_stdin = child.stdin.take().ok_or_else(|| "无法写入自动化请求。".to_string())?;
    child_stdin.write_all(body.as_bytes()).map_err(|_| "无法写入自动化请求。".to_string())?;
    drop(child_stdin);

    let stdout = child.stdout.take().ok_or_else(|| "无法读取自动化服务输出。".to_string())?;
    let mut result: Option<Value> = None;
    for line in BufReader::new(stdout).lines() {
      let line = line.map_err(|_| "自动化服务输出中断。".to_string())?;
      let message: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(_) => continue,
      };
      match message.get("type").and_then(Value::as_str) {
        Some("progress") => {
          let payload = ProgressPayload {
            stage: message.get("stage").and_then(Value::as_str).unwrap_or("preparing").to_string(),
            message: message.get("message").and_then(Value::as_str).unwrap_or("处理中").to_string(),
          };
          let _ = app.emit("automation-progress", payload);
        }
        Some("result") => result = message.get("payload").cloned(),
        _ => {}
      }
    }
    let _ = child.wait();
    result.ok_or_else(|| "自动化服务没有返回结果。".to_string())
  })
  .await
  .map_err(|_| "自动化任务意外终止。".to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .menu(|handle| {
      let app_menu = Submenu::with_items(handle, "Video Reverse Prompt", true, &[
        &PredefinedMenuItem::about(handle, None, None)?,
        &PredefinedMenuItem::separator(handle)?,
        &MenuItem::with_id(handle, "settings", "设置…", true, Some("CmdOrCtrl+,"))?,
        &PredefinedMenuItem::separator(handle)?,
        &PredefinedMenuItem::hide(handle, None)?,
        &PredefinedMenuItem::quit(handle, None)?,
      ])?;
      let file_menu = Submenu::with_items(handle, "File", true, &[
        &MenuItem::with_id(handle, "open-file", "Open Video…", true, Some("CmdOrCtrl+O"))?,
        &PredefinedMenuItem::close_window(handle, None)?,
      ])?;
      let edit_menu = Submenu::with_items(handle, "Edit", true, &[
        &PredefinedMenuItem::undo(handle, None)?, &PredefinedMenuItem::redo(handle, None)?,
        &PredefinedMenuItem::separator(handle)?, &PredefinedMenuItem::cut(handle, None)?,
        &PredefinedMenuItem::copy(handle, None)?, &PredefinedMenuItem::paste(handle, None)?,
        &PredefinedMenuItem::select_all(handle, None)?,
      ])?;
      let analysis_menu = Submenu::with_items(handle, "Analysis", true, &[
        &MenuItem::with_id(handle, "start-analysis", "Start Analysis", true, Some("CmdOrCtrl+Enter"))?,
        &MenuItem::with_id(handle, "reanalyze", "Reanalyze", true, Some("CmdOrCtrl+R"))?,
      ])?;
      let view_menu = Submenu::with_items(handle, "View", true, &[&PredefinedMenuItem::fullscreen(handle, None)?])?;
      let window_menu = Submenu::with_items(handle, "Window", true, &[
        &PredefinedMenuItem::minimize(handle, None)?, &PredefinedMenuItem::maximize(handle, None)?,
      ])?;
      let help_menu = Submenu::with_items(handle, "Help", true, &[])?;
      Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu, &analysis_menu, &view_menu, &window_menu, &help_menu])
    })
    .on_menu_event(|app, event| { let _ = app.emit("menu-action", event.id().as_ref()); })
    .setup(|app| {
      cleanup_update_cache(app.handle());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .manage(UpdateRuntimeState::default())
    .invoke_handler(tauri::generate_handler![
      get_file_metadata,
      open_external,
      uninstall_app,
      run_automation,
      download_update,
      install_downloaded_update,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Video Reverse Prompt");
}

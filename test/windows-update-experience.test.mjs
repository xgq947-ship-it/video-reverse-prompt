import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rust = await readFile('src-tauri/src/lib.rs', 'utf8')
const updater = await readFile('src-tauri/src/updater.rs', 'utf8')
const settings = await readFile('src/components/SettingsView.tsx', 'utf8')

test('Windows 后台自动化进程不创建控制台窗口', () => {
  assert.match(rust, /CREATE_NO_WINDOW/)
  assert.match(rust, /hide_console_window\(&mut command\)/)
})

test('Windows 更新必须下载、校验后再被动覆盖安装', () => {
  assert.match(updater, /RELEASE_PATH_PREFIX/)
  assert.match(updater, /sha256_file/)
  assert.match(updater, /expected_size/)
  assert.match(updater, /\.args\(\["\/P", "\/R", "\/UPDATE"\]\)/)
  assert.match(settings, /update-download-progress/)
  assert.match(settings, /download_update/)
  assert.match(settings, /install_downloaded_update/)
  assert.match(settings, /重启并安装/)
})

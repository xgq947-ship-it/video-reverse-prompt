import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

async function read(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('发布版本在应用元数据中保持一致', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  const packageLock = JSON.parse(await read('package-lock.json'))
  const tauriConfig = JSON.parse(await read('src-tauri/tauri.conf.json'))
  const cargoToml = await read('src-tauri/Cargo.toml')
  const cargoLock = await read('src-tauri/Cargo.lock')
  const settingsView = await read('src/components/SettingsView.tsx')
  const version = packageJson.version
  const escapedVersion = version.replaceAll('.', '\\.')

  assert.equal(packageLock.version, version)
  assert.equal(packageLock.packages[''].version, version)
  assert.equal(tauriConfig.version, version)
  assert.match(cargoToml, new RegExp(`^version = "${escapedVersion}"$`, 'm'))
  assert.match(cargoLock, new RegExp(`name = "video-reverse-prompt"\\r?\\nversion = "${escapedVersion}"`))
  assert.match(settingsView, new RegExp(`FALLBACK_VERSION = '${escapedVersion}'`))
  assert.match(settingsView, new RegExp(`tag_name: 'v${escapedVersion}'`))
})

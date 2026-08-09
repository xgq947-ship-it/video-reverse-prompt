import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Video Reverse Prompt 只通过共享 Hub 获取 Chrome，不再固定端口或项目 Profile', async () => {
  const browser = await readFile('automation/playwright-service/src/gemini/browser.ts', 'utf8')
  const hub = await readFile('automation/playwright-service/src/browserHub.ts', 'utf8')
  assert.match(browser, /acquireSharedBrowser/)
  assert.doesNotMatch(browser, /VIDEO_REVERSE_PROMPT_CDP_PORT|19223|chrome-profile/)
  assert.match(hub, /com\.videoreverseprompt\.desktop/)
  assert.match(hub, /video-reverse-prompt:gemini/)
  assert.match(hub, /25_000/)
  assert.match(hub, /page\.register/)
  assert.match(browser, /hubLease\.registerPage\(await pageTargetId\(page\)\)/)
  assert.match(hub, /hub\.release/)
})

test('macOS 和 Windows 安装包都内置同一 Hub 载荷', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  assert.equal(
    config.bundle.resources['../browser-hub-payload/current/'],
    'browser-hub-payload/current/'
  )
  const prepare = await readFile('scripts/prepare-browser-hub.mjs', 'utf8')
  assert.match(prepare, /payload-\$\{platform\}-\$\{arch\}/)
  assert.match(prepare, /readBrowserHubLock/)
  assert.match(prepare, /lockedAsset\.sha256/)
  assert.match(prepare, /NODE-LICENSE/)
  assert.match(prepare, /createHash\('sha256'\)/)
  assert.match(pkg.scripts.check, /prepare-browser-hub\.mjs/)
})

test('Hub stable Release 自动同步单一锁文件，验证失败不会写入 main', async () => {
  const workflow = await readFile('.github/workflows/sync-browser-hub.yml', 'utf8')
  assert.match(workflow, /cron: '17 \*\/6 \* \* \*'/)
  assert.match(workflow, /scripts\/sync-browser-hub-lock\.mjs/)
  assert.match(workflow, /npm run check/)
  assert.match(workflow, /macos-15/)
  assert.match(workflow, /git status --porcelain/)
  assert.match(workflow, /git push origin HEAD:main/)
})

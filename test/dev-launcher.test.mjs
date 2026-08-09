import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scripts = [
  'tools/dev-launcher/control.sh',
  'tools/dev-launcher/run.sh',
]

test('Finder 启动器能发现用户目录中的 Node 和 npm', async () => {
  for (const path of scripts) {
    const source = await readFile(path, 'utf8')
    assert.match(source, /\$\{USER_HOME\}\/\.local\/bin/)
    assert.match(source, /\$\{USER_HOME\}\/\.hermes\/node\/bin/)
    assert.match(source, /\$\{USER_HOME\}\/\.cargo\/bin/)
  }
})

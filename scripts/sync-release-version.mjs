import { readFile, writeFile } from 'node:fs/promises'

const raw = process.env.GITHUB_REF_NAME || process.argv[2] || ''
const version = raw.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`无效的发布版本号：${raw || '(empty)'}`)
}

for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
  const data = JSON.parse(await readFile(file, 'utf8'))
  data.version = version
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

const cargoPath = 'src-tauri/Cargo.toml'
const cargo = await readFile(cargoPath, 'utf8')
await writeFile(cargoPath, cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`), 'utf8')

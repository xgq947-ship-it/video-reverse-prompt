import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

const version = '22.17.0'
const platform = process.platform
const architecture = process.env.VIDEO_REVERSE_PROMPT_RUNTIME_ARCH || process.arch
const target = platform === 'win32'
  ? `win-${architecture === 'arm64' ? 'arm64' : 'x64'}`
  : platform === 'darwin'
    ? `darwin-${architecture === 'x64' ? 'x64' : 'arm64'}`
    : null

if (!target) throw new Error(`不支持的 Node 运行时目标：${platform}-${architecture}`)

const extension = platform === 'win32' ? 'zip' : 'tar.gz'
const archiveName = `node-v${version}-${target}.${extension}`
const baseUrl = `https://nodejs.org/dist/v${version}`
const outputDir = join(process.cwd(), 'runtime', 'node')
const outputFile = join(outputDir, platform === 'win32' ? 'node.exe' : 'node')

if (existsSync(outputFile)) process.exit(0)

const tempDir = join(tmpdir(), `video-reverse-prompt-node-${process.pid}`)
await mkdir(tempDir, { recursive: true })
try {
  const archivePath = join(tempDir, archiveName)
  const response = await fetch(`${baseUrl}/${archiveName}`)
  if (!response.ok || !response.body) throw new Error(`Node 下载失败：HTTP ${response.status}`)
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(archivePath)))

  const checksumsResponse = await fetch(`${baseUrl}/SHASUMS256.txt`)
  if (!checksumsResponse.ok) throw new Error(`Node 校验文件下载失败：HTTP ${checksumsResponse.status}`)
  const expected = (await checksumsResponse.text()).split('\n').find((line) => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0]
  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex')
  if (!expected || actual !== expected) throw new Error('Node 运行时 SHA-256 校验失败')

  const extractDir = join(tempDir, 'extract')
  await mkdir(extractDir, { recursive: true })
  if (platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:VIDEO_REVERSE_PROMPT_NODE_ARCHIVE -DestinationPath $env:VIDEO_REVERSE_PROMPT_NODE_EXTRACT -Force',
    ], {
      env: {
        ...process.env,
        VIDEO_REVERSE_PROMPT_NODE_ARCHIVE: archivePath,
        VIDEO_REVERSE_PROMPT_NODE_EXTRACT: extractDir,
      },
    })
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir])
  }
  const source = join(extractDir, `node-v${version}-${target}`, platform === 'win32' ? 'node.exe' : 'bin/node')
  await mkdir(outputDir, { recursive: true })
  await copyFile(source, outputFile)
  if (platform !== 'win32') await chmod(outputFile, 0o755)
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

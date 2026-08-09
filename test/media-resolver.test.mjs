import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MediaResolverError,
  SocialVideoProvider,
  extractMediaUrl,
} from '../automation/playwright-service/dist/media/resolver.js'
import {
  assertPublicMediaUrl,
  isPrivateNetworkAddress,
  resolveAndDownloadVideo,
} from '../automation/playwright-service/dist/media/downloader.js'

test('分享文案会提取首个 URL 并移除中英文尾部标点', () => {
  assert.equal(
    extractMediaUrl('6.82 复制打开抖音 https://v.douyin.com/abc123/。 更多内容'),
    'https://v.douyin.com/abc123/',
  )
  assert.equal(extractMediaUrl('watch https://media.example/video.mp4,'), 'https://media.example/video.mp4')
  assert.throws(
    () => extractMediaUrl('这里没有链接'),
    (error) => error instanceof MediaResolverError && error.code === 'INVALID_MEDIA_URL',
  )
})

test('视频直链不调用第三方解析服务', async () => {
  let calls = 0
  const provider = new SocialVideoProvider({
    fetchImpl: async () => { calls += 1; throw new Error('不应调用') },
  })
  const result = await provider.resolve('https://media.example/path/demo.webm?download=1')
  assert.equal(calls, 0)
  assert.equal(result.platform, 'direct')
  assert.equal(result.videoUrl, 'https://media.example/path/demo.webm?download=1')
  assert.equal(result.metadata.watermarkStatus, 'original')
})

test('抖音链接复用无水印 JSON 解析分支', async () => {
  const calls = []
  const provider = new SocialVideoProvider({
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify({
        code: 200,
        data: {
          title: '抖音测试视频',
          url: 'https://cdn.example/video-hd.mp4',
          cover: 'https://cdn.example/cover.jpg',
          author: { nickname: '作者' },
          images: '当前为短视频解析模式',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.resolve('复制打开抖音 https://v.douyin.com/abc123/')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/api\.xhus\.cn\/api\/douyin\?url=/)
  assert.equal(result.platform, 'douyin')
  assert.equal(result.videoUrl, 'https://cdn.example/video-hd.mp4')
  assert.equal(result.metadata.author, '作者')
  assert.equal(result.metadata.watermarkStatus, 'removed')
})

test('X / Twitter 解析选择最高码率 MP4', async () => {
  const provider = new SocialVideoProvider({
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.fxtwitter.com/2/status/2026291894532411536')
      return new Response(JSON.stringify({
        code: 200,
        status: {
          text: '一条视频帖子',
          author: { name: '测试作者', screen_name: 'tester' },
          media: {
            videos: [{
              type: 'video',
              duration: 12.5,
              thumbnail_url: 'https://cdn.example/cover.jpg',
              formats: [
                { container: 'm3u8', url: 'https://cdn.example/video.m3u8' },
                { container: 'mp4', bitrate: 256000, url: 'https://cdn.example/360.mp4' },
                { container: 'mp4', bitrate: 2176000, url: 'https://cdn.example/1080.mp4' },
              ],
            }],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.resolve('https://x.com/tester/status/2026291894532411536')
  assert.equal(result.platform, 'twitter')
  assert.equal(result.videoUrl, 'https://cdn.example/1080.mp4')
  assert.equal(result.metadata.alternateVideoUrl, 'https://cdn.example/360.mp4')
  assert.equal(result.metadata.duration, 12.5)
  assert.equal(result.metadata.watermarkStatus, 'original')
})

test('小红书、B 站等链接复用 AI 画布的 resolve + parse 协议', async () => {
  const calls = []
  const provider = new SocialVideoProvider({
    origin: 'https://resolver.example',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      if (url.endsWith('/api/resolve')) {
        return new Response(JSON.stringify({ finalUrl: 'https://www.bilibili.com/video/BV123/' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        success: true,
        provider: 'bilibili',
        data: {
          type: 'video',
          title: 'B 站测试视频',
          videoUrl: 'https://cdn.example/bilibili.mp4',
          watermarkStatus: 'removed',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.resolve('分享视频 https://www.bilibili.com/video/BV123/ 打开 App')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, { url: 'https://www.bilibili.com/video/BV123/' })
  assert.equal(result.platform, 'bilibili')
  assert.equal(result.videoUrl, 'https://cdn.example/bilibili.mp4')
})

test('解析后的视频会立即流式保存到本机', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-reverse-prompt-video-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const bytes = Buffer.alloc(16 * 1024, 7)
  const result = await resolveAndDownloadVideo({
    input: 'https://source.example/post/1',
    outputDir,
    resolver: {
      resolve: async () => ({
        sourceUrl: 'https://source.example/post/1',
        platform: 'test',
        type: 'video',
        title: '测试视频',
        videoUrl: 'https://cdn.example/video.mp4',
        metadata: { resolver: 'test', author: '作者', watermarkStatus: 'removed' },
      }),
    },
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual')
      assert.match(options.headers.range, /^bytes=0-/)
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) },
      })
    },
  })
  assert.equal(result.platform, 'test')
  assert.equal(result.watermarkStatus, 'removed')
  assert.equal(result.size, bytes.length)
  assert.deepEqual(fs.readFileSync(result.filePath), bytes)
})

test('下载器拒绝 localhost、内网和保留地址', async () => {
  assert.equal(isPrivateNetworkAddress('127.0.0.1'), true)
  assert.equal(isPrivateNetworkAddress('192.168.1.2'), true)
  assert.equal(isPrivateNetworkAddress('93.184.216.34'), false)
  await assert.rejects(
    assertPublicMediaUrl('http://localhost/video.mp4'),
    (error) => error.code === 'UNSAFE_DOWNLOAD_URL',
  )
  await assert.rejects(
    assertPublicMediaUrl('https://private.example/video.mp4', {
      lookupImpl: async () => [{ address: '10.0.0.2', family: 4 }],
    }),
    (error) => error.code === 'UNSAFE_DOWNLOAD_URL',
  )
})

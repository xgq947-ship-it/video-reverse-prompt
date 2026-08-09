# Video Reverse Prompt

macOS / Windows 本地 AI 视频逆向导演工作台。项目只处理视频，不包含图片反推。

它采用清晰的两步流程：先沿用 Reverse Prompt 原版 Gemini 视频分析，再用 DeepSeek 或本机 Codex CLI 生成 HotStory 风格的短视频剧本、角色资产和多分镜成片提示词。

## 使用流程

1. 导入本地视频，或粘贴公开短视频链接/分享文案。
2. 点击「开始反推」。应用通过已登录的 Gemini Web 会话分析原片，并输出 Reverse Prompt 原版九个分区。
3. 第一步完成后，界面才显示「生成短视频剧本」按钮。
4. 点击按钮后，DeepSeek V4 Flash MAX 或本机 Codex CLI 依次生成：
   - 与原片时长一致的短视频剧本；
   - 需要跨镜头复用的角色参考图提示词、表演主档案和固定声线；
   - 连续分镜计划；
   - 每条不超过 10 秒、可以直接复制给视频模型的完整提示词。

项目不再提供「识别台词」或「生成角色」开关。第二步会直接使用 Gemini 的完整反推结果：原片有可辨台词时可以保留逐字台词；没有可辨台词时不会凭空新增。需要重复出镜的角色会自动生成资产，没有必要角色时角色数组可以为空。

## 第一步：Reverse Prompt 原版 Gemini 反推

第一步的 [`src/prompts/videoPrompt.ts`](src/prompts/videoPrompt.ts) 与原 Reverse Prompt 项目逐字一致，SHA-256 为：

```text
6989483cfe29bc8a90e4c66e13ef1fceacaea4d04ef41f44c8045577a40f661c
```

Gemini 输出以下九个原版分区：

| 分区 | 内容 |
|---|---|
| `VIDEO_OVERVIEW` | 视频时长、比例、主体、环境和整体风格 |
| `TIMELINE` | 按真实剪辑点、动作和场景拆分的完整时间线 |
| `MOTION_PROMPT` | 分时间段的可见动作与身体运动 |
| `CAMERA_PROMPT` | 景别、机位、运镜、焦点和构图 |
| `KLING` | Kling 优化提示词 |
| `SEEDANCE` | Seedance 优化提示词 |
| `VEO` | Google Veo 优化提示词 |
| `RUNWAY` | Runway 优化提示词 |
| `JSON` | 时长、主体、风格、镜头和各模型提示词的结构化数据 |

应用复用 Chrome 中已登录的 Gemini Web 会话，不需要 Gemini API Key，也不导出或保存 Cookie、密码、OAuth Token 或 Authorization Header。

## 第二步：HotStory 剧本与多分镜生成

第二步不会把 Skill 摘要塞进 Gemini。它单独调用所选生成模型，并按 HotStory 的阶段顺序执行：

```text
Gemini 完整反推结果
  → script_writer：短视频剧本
  → character_assets：角色参考图 + 表演主档案
  → shot_plan：连续多分镜计划
  → cinematic_shots：每条可直接生成视频的完整提示词
  → SCRIPT / CHARACTER_PROMPTS / SHOT_PROMPTS / JSON
```

角色阶段逐字注入 Lira 与 Acting Skill；逐镜头阶段逐字注入 Acting 与 CINEDANCE Skill。每批最多生成 4 个镜头，最多 3 批并发，与 HotStory 的生成方式一致。旁白和对白只允许逐字取自已生成剧本；程序最后统一附加原生音频段、固定声线和「无额外人声、无字幕」约束。

结构化输出会按照 HotStory 的 JSON Schema 方式校验。格式无效时只执行一次同源 JSON 修复；仍然无效就显示错误，不会悄悄降级为摘要版或缩水提示词。

## 原始模板与完整 Skill

以下 4 份 Markdown 模板从本机 HotStory 项目逐字复制：

- `character_assets.md`
- `cinematic_shots.md`
- `script_writer.md`
- `shot_plan.md`

以下 3 份完整 Skill 原文随项目打包：

- `skills/lira-image-prompts/SKILL.md`
- `skills/acting-ai-video/SKILL.md`
- `skills/cinedance-higgsfield/SKILL.md`

测试会锁定 7 份文件的原始 SHA-256，防止被概括、截断或替换。运行时任一 Skill 缺失都会停止第二步，并明确提示缺失文件；不存在摘要回退分支。

## 生成模型设置

### DeepSeek（默认）

在「设置 → 生成模型」中只需填写 DeepSeek API Key。以下配置固定在代码中，不需要手动填写：

```text
Model: deepseek-v4-flash
Base URL: https://api.deepseek.com
Thinking: enabled
Reasoning Effort: max
Max output tokens: 65536
Timeout: 240 seconds
Retry: 1
```

API Key 仅保存在本机应用 Store。Tauri 通过标准输入把请求交给内置 Node 服务，Key 不会作为命令行参数出现在进程列表中。

### Codex CLI

选择「Codex CLI」后无需填写 Key、路径、模型或 Base URL。应用自动检查系统 PATH、常用安装目录以及 ChatGPT App 内置 Codex，并使用本机已经登录的会话。

Codex 采用非交互 `codex exec`，使用临时会话、只读沙箱和独立最终消息文件；不会修改项目文件。参数与 HotStory 同源，并遵循 [Codex CLI 官方非交互用法](https://developers.openai.com/codex/cli/reference)。

## 视频导入

- 支持 MP4、MOV、M4V、WebM 本地视频。
- 支持抖音、TikTok、X / Twitter、小红书、B 站等公开短视频链接或完整分享文案。
- 抖音优先使用无水印解析，X / Twitter 选择码率最高的 MP4。
- 普通视频直链直接下载；临时 CDN 视频会立即流式保存到应用缓存。
- 下载限制为 1 GB；每次重定向都会重新校验公网地址并拒绝 localhost、内网和保留地址。
- 视频解析后只进入本地预览，点击「开始反推」后才上传 Gemini。

## 环境与开发

- macOS Apple Silicon 或 Windows 10/11 x64
- Google Chrome
- Node.js 22+ 与 Rust stable（仅源码开发需要）

```bash
npm install
npm run tauri dev
```

macOS 也可以双击项目根目录中的 `Video Reverse Prompt 开发启动器.app`。启动器会自动寻找常见位置中的 Node/npm；如果缺少 npm，会给出可操作的安装提示，而不是只显示 `MISSING_NPM`。

仅做前端视觉开发时：

```bash
npm run dev -- --host 127.0.0.1 --port 1420
```

- `http://127.0.0.1:1420/?ui-preview=1`：第一步待分析工作区。
- `http://127.0.0.1:1420/?ui-preview=production`：第二步完成后的结果工作区。

## 检查与构建

```bash
npm run check
npm run lint
npm run tauri build
```

`npm run check` 会执行自动化测试、TypeScript/Vite 构建、AI Browser Hub 载荷校验和 Rust 检查。推送 `vX.Y.Z` 标签后，GitHub Actions 会构建 macOS Apple Silicon DMG 与 Windows x64 NSIS 安装包。

## 目录

- `src/`：React UI、Reverse Prompt 原版提示词、两步结果解析和本地 Store。
- `skills/`：3 份随应用打包的完整 Skill 原文。
- `automation/playwright-service/src/generation/`：DeepSeek/Codex Provider 与 HotStory 第二步生成管线。
- `automation/playwright-service/src/prompts/hotstory/`：4 份 HotStory 原始模板。
- `automation/playwright-service/`：Gemini HTTP 会话、登录态复用和视频链接解析。
- `src-tauri/`：桌面窗口、文件桥接、资源打包和更新器。

## 隐私与本地数据

历史记录、设置、Gemini 对话标识、DeepSeek API Key 和链接导入的视频保存在系统分配的应用数据/缓存目录。源文件不会被修改、移动或删除。

DeepSeek 模式会把 Gemini 反推文本和第二步提示词发送给 DeepSeek API；Codex 模式会把同样的文本交给本机 Codex CLI。共享 Chrome 登录资料由 AI Browser Hub 管理，应用不导出 Cookie。验证码、2FA 或 Google 安全确认仍需在可见 Chrome 窗口中手动完成。

## License

[MIT](LICENSE)

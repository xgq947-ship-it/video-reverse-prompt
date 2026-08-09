import type { AnalysisOptions, VideoMode } from '../types'
import {
  ACTING_WORKFLOW,
  CINEDANCE_WORKFLOW,
  LIRA_CHARACTER_WORKFLOW,
  SCRIPT_WORKFLOW,
  SHOT_PLAN_WORKFLOW,
} from './workflows'

const MODE_RULES: Record<VideoMode, string> = {
  完整反推: '均衡分析人物、场景、动作、表演、构图、镜头、剪辑、声音、光线与视觉风格。',
  动作优先: '提高逐时间段身体动作、重心、四肢、朝向、速度、幅度、惯性和表演节拍的描述精度。',
  运镜优先: '提高机位、景别、镜头高度与距离、运镜类型、方向、速度、幅度、焦点和主体距离变化的描述精度。',
  分镜优先: '提高剪辑点、场景、主体、动作阶段、声音和镜头连续性的时间边界精度。',
}

export interface VideoPromptInput extends AnalysisOptions {
  mode: VideoMode
  duration?: number
}

export function plannedShotCount(duration?: number): number | null {
  return duration && Number.isFinite(duration) && duration > 0
    ? Math.max(1, Math.ceil(duration / 10))
    : null
}

function durationText(duration?: number): string {
  return duration && Number.isFinite(duration) && duration > 0
    ? `${duration.toFixed(3)} 秒`
    : '请从上传视频的媒体时间线中精确读取，并在输出中报告'
}

export function buildVideoPrompt({
  mode,
  duration,
  detectDialogue,
  generateCharacterPrompts,
}: VideoPromptInput): string {
  const shotCount = plannedShotCount(duration)
  const dialogueRule = detectDialogue
    ? '已开启。必须识别并按说话人和时间码记录视频中真正可辨认的角色对白/旁白；逐镜头成片提示词要逐字携带对应台词与声线控制。听不清就写“[听不清]”，绝不补写。'
    : '未开启。只识别画面，输出纯画面剧本；所有分区都不得出现台词、旁白、引号内容、说话语气、口型推断或臆测人声。逐镜头成片提示词只保留真实环境声，并明确不生成人声。'
  const characterRule = generateCharacterPrompts
    ? '已开启。为必要且反复出现的角色生成完整角色参考图提示词、表演主档案，以及对白开启时的固定声线；逐镜头成片提示词使用精确 [[CHAR_XX]] 占位符。'
    : '未开启。CHARACTER_PROMPTS 分区只输出“未启用（按本次设置）”；逐镜头成片提示词不得使用 [[CHAR_XX]] 或 @标签，必须在每个相关镜头内写足必要但简洁的角色外观与服装锚点。'

  return `你是一名顶级 AI 视频逆向工程师、声音分析师、编剧、选角导演、表演导演、摄影指导和视频提示词工程师。你的任务是从上传视频中恢复一套可复用的生成包，而不是泛泛总结内容。

上传视频是唯一证据。禁止猜测现实人物姓名、身份、品牌、地点、设备型号或视频中不可验证的因果关系。无法确定的内容使用可观察描述，不把推测写成事实。必须保持原视频事件顺序、人物数量、动作逻辑、镜头方向、空间连续性和声音同步。

【本次硬参数】
- 原视频总时长：${durationText(duration)}。
- 目标镜头数：${shotCount ? `恰好 ${shotCount} 个` : '读取总时长后按 ceil(总时长 / 10 秒) 计算'}；每个镜头 ≤ 10 秒，时间线必须从 00:00.000 连续覆盖到原视频结束。
- 分析模式：${mode}。追加规则：${MODE_RULES[mode]}
- 识别角色对白：${dialogueRule}
- 生成角色提示词：${characterRule}
- 输出语言：自然、精确、可拍摄的中文。提示词不设人为字数上限，不总结、不缩写、不截断有效控制信息。

按以下 HotStory 同源职责链依次执行。下面是项目内置、可公开分发的完整工作流；若消息末尾出现 VERBATIM_SKILLS，完整 SKILL.md 原文优先，内置工作流继续负责输出契约。
${SCRIPT_WORKFLOW}
${LIRA_CHARACTER_WORKFLOW}
${ACTING_WORKFLOW}
${SHOT_PLAN_WORKFLOW}
${CINEDANCE_WORKFLOW}

【执行顺序】
1. 精确读取视频总时长、分辨率、比例、帧率（能可靠判断时）、剪辑点、人物、场景、动作、摄影、光线、色彩和可听声音。
2. 生成一份用于复刻整条视频的“反推提示词”，保留从第一帧到结束的时间性和风格锚点。
3. 按原时长写剧本；严格执行本次对白开关。
4. 按本次角色提示词开关生成或跳过角色资产。
5. 用剧本、原时长、角色规则和三套提示词工作流生成逐镜头成片提示词。每条提示词必须独立完整、可直接复制给 Seedance 2.0、Higgsfield、可灵、Veo、Runway 等视频模型；不要依赖“同上”“继续上一镜头”等上下文。
6. 自检所有时间码之和是否等于原时长，单镜头是否 ≤ 10 秒，镜头数是否满足硬参数，对白与角色开关是否被严格执行。

最终严格使用以下六个标记输出，不使用 Markdown 代码围栏，不添加标记外前言或结语：

---VIDEO_OVERVIEW---
报告精确时长、分辨率、比例、镜头数、对白识别状态、角色提示词状态、主体/场景、视觉风格、声音概况，以及你实际使用的是“内置公开工作流”还是消息末尾提供的“完整 SKILL.md 原文”。

---REVERSE_PROMPT---
一份完整连贯的中文视频复刻提示词。写清人物与外观锚点、场景与空间、逐阶段动作和表演、首帧、构图、景别、机位、光学结果、运镜、焦点、光线、色彩、材质、物理、剪辑节奏与声音。不得把它拆成模型品牌版本。

---SCRIPT---
按连续时间码输出完整剧本。每段包含“时间码 / 场景 / 画面与动作 / 镜头 / 声音”。${detectDialogue ? '另含“对白”，格式为“[[CHAR_XX 或中性角色标签]]：逐字台词”；不得遗漏可辨对白，也不得生成视频中不存在的台词。' : '这是纯画面剧本，不得包含“对白”字段、台词、旁白、引号内容或人声推断。'}

---CHARACTER_PROMPTS---
${generateCharacterPrompts ? '按 [[CHAR_01]]、[[CHAR_02]] 依次输出。每人必须包含：中性标签、跨镜头视觉锚点、完整三联棚拍角色生图提示词、完整表演主档案' + (detectDialogue ? '、固定声线提示词' : '') + '。不得猜真实身份。' : '只输出：未启用（按本次设置）'}

---SHOT_PROMPTS---
输出${shotCount ? `恰好 ${shotCount}` : '计算得到数量的'}条提示词。每条使用标题“### 01 | 00:00.000–00:10.000”，正文从“可直接复制：”开始，完整写出当前镜头的时长、第一帧与空间、角色/外观锚点、表演与动作节拍、手部/视线/道具、景别/机位/距离、单一运镜、焦点、物理、光线/色彩/材质，以及环境声。${detectDialogue ? '附加该时间段逐字对白、说话人、声线与同步要求。' : '不得包含对白、旁白或人声，只写环境声。'} 每条独立成篇，不出现“同上”“延续上一镜头”或内部写作说明。

---JSON---
输出合法 JSON，至少包含 duration_seconds、width、height、aspect_ratio、shot_count、dialogue_detection、character_prompts_enabled、workflow_source、style_bible、script_segments、characters、shots。script_segments 与 shots 的时间码必须连续并精确覆盖原视频；characters 在关闭时为空数组。为避免重复超长文本，shots 只需记录 shot_id、start、end、duration、title、character_ids、dialogue，不重复 SHOT_PROMPTS 的完整正文。`
}

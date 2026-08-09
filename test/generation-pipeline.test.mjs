import assert from 'node:assert/strict'
import test from 'node:test'
import { generateProductionPackage } from '../automation/playwright-service/dist/generation/pipeline.js'

class FakeProvider {
  name = 'deepseek'
  model = 'deepseek-v4-flash'
  calls = []

  async generateText(systemPrompt, userPrompt) {
    this.calls.push({ type: 'text', systemPrompt, userPrompt })
    return {
      content: '# 参考视频\n\n## 基本信息\n预计时长：12 秒\n\n## 00:00 - 00:06\n### 旁白\n第一句旁白。\n### 镜头\n人物在窗边抬头。\n### 事实依据\n原视频镜头。\n\n## 00:06 - 00:12\n### 旁白\n第二句旁白。\n### 镜头\n人物走向门口。\n### 事实依据\n原视频镜头。\n\n## 结尾\n人物停在门前。',
      provider: this.name,
      model: this.model,
    }
  }

  async generateJson(systemPrompt, userPrompt) {
    this.calls.push({ type: 'json', systemPrompt, userPrompt })
    const factId = userPrompt.match(/fact_[a-f0-9]{16}/)?.[0]
    const eventIds = [...new Set(userPrompt.match(/event_[a-f0-9]{16}/g) ?? [])]
    const sourceId = userPrompt.match(/source_[a-f0-9]{16}/)?.[0]
    let value
    if (systemPrompt.includes('Lira')) {
      assert.ok(userPrompt.length > 25_000)
      value = {
        style_bible: '真实自然电影质感，统一柔和侧光、自然肤质、真实布料与稳定的中性色彩关系。',
        characters: [{
          prompt_label: '年轻女性',
          role: 'lead',
          story_function: '承接原视频中的主要动作与情绪变化',
          source_fact_ids: [factId],
          visual_anchor: '二十多岁的年轻女性，自然真实体型，面部比例稳定',
          wardrobe_anchor: '无品牌的浅灰日常上衣与深色长裤，布料质感真实',
          image_prompt: '同一位年轻女性演员并排三张真实棚拍照片，左侧全身正面，中间全身背面，右侧头肩近景，中性灰背景和单侧柔和方向光，皮肤与布料真实自然。',
          acting_profile: '她的重心略低，肩背保持克制，目标是确认门外的动静。压力升高时拇指轻触食指，眼睛先于头部到达门口，眨眼和呼吸保持自然；走路以短而稳定的全脚掌落地为固定步态，听见声音时手中动作短暂停住。',
          voice_prompt: '年轻女性的自然中音，语速克制，气息稳定。',
          default_use_reference: true,
        }],
      }
    } else if (systemPrompt.includes('分镜规划师')) {
      value = {
        shots: [0, 1].map((index) => ({
          shot_id: `candidate_${index + 1}`,
          title: index ? '走向门口' : '窗边抬头',
          start_second: index * 6,
          end_second: (index + 1) * 6,
          narration: index ? '第二句旁白。' : '第一句旁白。',
          dialogue: '',
          visual_brief: index ? '年轻女性从窗边走向门口并停下' : '年轻女性站在窗边抬头观察',
          active_character_ids: ['char_01'],
          event_ids: [eventIds[index] ?? eventIds[0]],
          source_ids: [sourceId],
        })),
      }
    } else if (systemPrompt.includes('CINEDANCE')) {
      assert.ok(userPrompt.length > 25_000)
      const ids = [...new Set(userPrompt.match(/shot_\d{2}/g) ?? [])]
      value = {
        shots: ids.map((shotId) => ({
          shot_id: shotId,
          prompt_body_template: `[[CHAR_01]] 在第一帧已经处于动作状态，人物位于画面右侧三分线，视线先于头部转向目标，摄影机以自然标准视角从阴影面执行一次缓慢微推进，脚掌重心、衣料惯性、手部停顿与环境光方向保持真实一致。当前动作在镜头时长内完整结束。`,
          ambient_audio: '室内轻微风声、衣料摩擦与远处环境底噪。',
        })),
      }
    } else {
      throw new Error(`未识别测试阶段：${systemPrompt}`)
    }
    return { content: JSON.stringify(value), provider: this.name, model: this.model }
  }
}

test('第二步按 HotStory 原流程生成剧本、角色和多个可复制分镜', async () => {
  const provider = new FakeProvider()
  const stages = []
  const reverseResponse = `---VIDEO_OVERVIEW---\n12 秒室内人物短片。\n---TIMELINE---\n0-6 秒窗边，6-12 秒走向门口。\n---MOTION_PROMPT---\n人物抬头后走向门口。\n---CAMERA_PROMPT---\n缓慢推进。\n---KLING---\nKling。\n---SEEDANCE---\nSeedance。\n---VEO---\nVeo。\n---RUNWAY---\nRunway。\n---JSON---\n{"duration":12,"shots":[{"start":0,"end":6,"subject":"年轻女性","action":"窗边抬头"},{"start":6,"end":12,"subject":"年轻女性","action":"走向门口"}]}`
  const result = await generateProductionPackage({
    reverseResponse,
    duration: 12,
    filename: 'reference.mp4',
    provider,
    onProgress: (stage) => stages.push(stage),
  })
  assert.match(result.rawResponse, /^---SCRIPT---/)
  assert.match(result.rawResponse, /---CHARACTER_PROMPTS---/)
  assert.match(result.rawResponse, /---SHOT_PROMPTS---/)
  assert.match(result.rawResponse, /---JSON---/)
  assert.equal(result.package.duration_seconds, 12)
  assert.equal(result.package.characters.length, 1)
  assert.equal(result.package.shots.length, 2)
  assert.equal(result.package.shots[0].start_second, 0)
  assert.equal(result.package.shots[1].end_second, 12)
  assert.ok(result.package.shots.every((shot) => shot.duration_seconds <= 10))
  assert.match(result.package.shots[0].prompt_body_template, /旁白逐字："第一句旁白。"/)
  assert.match(result.package.shots[0].prompt_body_template, /除上述内容外无额外人声，无字幕。/)
  assert.deepEqual(result.package.skills.map((skill) => skill.instruction_mode), ['verbatim', 'verbatim', 'verbatim'])
  assert.ok(stages.includes('writing-script'))
  assert.ok(stages.includes('creating-characters'))
  assert.ok(stages.includes('planning-shots'))
  assert.ok(stages.includes('generating-shots'))
  assert.equal(provider.calls.length, 4)
})

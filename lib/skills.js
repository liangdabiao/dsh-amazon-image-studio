// skill 提供方：把随包的 skills/amazon-image-studio 注册进 DSH 的 skill 目录。
// 用户自己装了同名 skill 时那一份优先（本提供方 rank 600）。
// 加载正文时把 <SKILL_ROOT> / <PLUGIN_ROOT> 换成实际目录，并在末尾追加「在这个插件里怎么用」。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

function readSkills(dirs) {
  return [].concat(dirs).flatMap((dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
      .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
      .filter((s) => s.name)
  })
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在「亚马逊图片工作台」插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`；上面提到的参考文档都相对这个目录。`,
    '- 这是插件随包快照：不要运行 `git pull` / `npm install`，也不要向用户提更新。skill 随插件版本一起变。',
    '- **工具优先**：不要手写策划 JSON 直接交给用户——槽位表查 `amz_slots`，策划走 `amz_plan`（未配策划 Key 时工具会返回完整自策划指引，你按指引策划后把 JSON 交给 `amz_validate_plan` 校验存档），最终 Prompt 组装用 `amz_prompt`，生图用 `amz_generate`（**一次一张**）。',
    '- 策划档案与生图历史：`amz_history`（list/get/remove/clear）。',
    '- AI 人物媒体打标：`amz_tag_performer`（JPG/PNG/WebP/MP4/MOV 写入 contains-synthetic-performer XMP，纯本地零网络）。',
    '- **生图通道**：插件配置了生图 API Key 时 `amz_generate` 直接生成；没配 Key 时按上面「生图通道兜底」节改用 dreamina-canvas / apiz CLI（与「电商视觉创作」插件同款通道）。',
    '- 纪律：MAIN 主图永远纯白底不挂风格图；附图/A+ 自动挂风格板；一次只生成一张，生成前先 `amz_prompt` 给用户过目英文 Prompt。',
    '',
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'amazon-image-studio',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  return {
    name: 'amazon-image-studio',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const s = readSkills(dir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = s.body.replaceAll('<SKILL_ROOT>', s.dir).replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    }
  }
}

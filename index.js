// 亚马逊图片工作台 · 宿主半边入口
import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerApi } from './lib/api.js'
import { createSkillProvider } from './lib/skills.js'
import { configRef, TOOLS } from './lib/tools.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const SKILL_DIRS = [join(ROOT, 'skills')]

export const name = 'amazon-image-studio'
export const inject = ['webServer', 'skills', 'tools']

export const Config = Schema.object({
  plannerApiUrl: Schema.string().role('textarea').default('https://api.deepseek.com').description('AI 策划 API URL（OpenAI 兼容；DeepSeek 官方地址会自动切纯文本模式）'),
  plannerApiKey: Schema.string().default('').description('AI 策划 API Key（留空时策划由当前对话的模型完成，工具会给出指引）'),
  plannerModel: Schema.string().default('deepseek-v4-flash').description('AI 策划模型（文本模型，如 deepseek-v4-flash / gpt-5.6-terra）'),
  plannerApiMode: Schema.string().default('chat').description('策划接口：chat（Chat Completions）或 responses（OpenAI Responses）'),
  imageProvider: Schema.string().default('volces').description('生图服务商：volces（火山方舟 Seedream）/ openai（OpenAI 兼容 Images API）/ aliyun（阿里百炼 Qwen-Image）'),
  imageApiUrl: Schema.string().default('').description('生图 API URL（留空用服务商默认：火山 ark.cn-beijing.volces.com/api/v3）'),
  imageApiKey: Schema.string().default('').description('生图 API Key（留空时生图走 dreamina-canvas / apiz CLI 兜底，见 skill）'),
  imageModel: Schema.string().default('').description('生图模型（留空用服务商默认：doubao-seedream-5-0-pro-260628）'),
  outputTier: Schema.string().default('2K').description('默认生图档位：2K / 4K'),
  timeoutSeconds: Schema.number().default(600).description('API 超时秒数'),
})

export function apply(ctx, config) {
  configRef.config = config ?? {}
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIRS, ROOT)))
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => registerApi(ctx))
}

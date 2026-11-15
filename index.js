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
  imageProvider: Schema.string().default('apiz').description('生图服务商（当前只用 apiz / GPT Image 2.5 Flare；volces / openai / aliyun 为兼容保留，面板已隐藏）'),
  imageApiUrl: Schema.string().default('').description('apiz API URL（留空用默认 https://api.apiz.ai）'),
  imageApiKey: Schema.string().default('').description('apiz API Key（sk-…）。面板「设置」页保存的也是这一项；留空且没开「复用本机 apiz CLI 登录态」时不允许生图'),
  imageModel: Schema.string().default('').description('apiz 模型 id（留空用默认 apiz/gpt-image-2.5-flare）'),
  imageQuality: Schema.string().default('low').description('apiz 质量档位：low（默认，最便宜）/ medium / high / xhigh / max；越高越贵，与分辨率无关'),
  imageTransparency: Schema.boolean().default(false).description('apiz 透明背景（输出 PNG；开启时 prompt 里不要描述背景，亚马逊主图请保持关闭）'),
  imageUseApizCliAuth: Schema.boolean().default(false).description('允许复用本机 apiz CLI 登录态（默认关：没显式配置 Key 时就不允许生图）'),
  requireReferenceImages: Schema.boolean().default(true).description('强制要求产品参考图（默认开：没有参考图不允许生图，避免商品不一致）'),
  reusePanelReferences: Schema.boolean().default(true).description('对话里调用 amz_generate 且没显式传 referenceImages 时，自动复用面板最近上传的参考图（最多 4 张）'),
  imagePollSeconds: Schema.number().default(2).description('apiz 异步任务轮询间隔秒数（2 秒起，逐步退避到 5 秒）'),
  apizBin: Schema.string().default('').description('apiz CLI 路径（参考图上传用；留空走 PATH / APIZ_BIN）'),
  outputTier: Schema.string().default('2K').description('默认生图档位：1K / 2K / 4K（默认 2K；成本敏感可调 1K）'),
  timeoutSeconds: Schema.number().default(600).description('API 超时秒数（apiz 异步任务按此上限轮询；超时不重投）'),
})

export function apply(ctx, config) {
  configRef.config = config ?? {}
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIRS, ROOT)))
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => registerApi(ctx))
}

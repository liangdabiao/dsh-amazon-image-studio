// apiz 真机冒烟（会花积分！必须显式 --yes 才执行）
//
// 走插件自己的 runGenerate 全链路：参考图上传 → 创建任务 → 轮询 → 下载 → 落盘 → 记历史，
// 规模压到最低（1024x1024 + quality=low + 1 张参考图），确认「接口能通、参考图真被用上、结果能落盘」。
//
//   node scripts/apiz-live-test.mjs --yes [--ref <参考图绝对路径>]
//
// 认证顺序与插件一致：imageApiKey（本脚本不填）→ APIZ_API_KEY → 本机 apiz CLI 登录态（需 --yes 时默认开启）。
// 数据落到 .tmp/apiz-live/，不动真实 DSH_HOME。
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const YES = process.argv.includes('--yes')
if (!YES) {
  console.error('这会真的调 apiz 生成一张图（消耗积分）。确认要跑就加 --yes：')
  console.error('  node scripts/apiz-live-test.mjs --yes --ref <参考图路径>')
  process.exit(2)
}

const refIndex = process.argv.indexOf('--ref')
const refArg = refIndex >= 0 ? process.argv[refIndex + 1] : ''
const ROOT = fileURLToPath(new URL('../.tmp/apiz-live/', import.meta.url))
const REF = refArg || fileURLToPath(new URL('../assets/style-presets/clean-tech.png', import.meta.url))
if (!existsSync(REF)) {
  console.error(`参考图不存在：${REF}`)
  process.exit(2)
}
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
process.env.DSH_HOME = join(ROOT, 'home')

const { configRef, runGenerate, imageKeySource } = await import('../lib/tools.js')
const { readHistory } = await import('../lib/data.js')

configRef.config = {
  imageProvider: 'apiz',
  imageApiKey: '',                  // 故意留空：验证「复用本机 apiz CLI 登录态」这条兜底
  imageUseApizCliAuth: true,        // 真机测试显式打开（正式默认是关的）
  imageQuality: 'low',              // 最便宜的档位
  requireReferenceImages: true,
  outputTier: '2K',
  timeoutSeconds: 180,
  imagePollSeconds: 2,
}

console.log('Key 来源：', imageKeySource())
console.log('参考图    ：', REF)
if (imageKeySource() === 'none') {
  console.error('没有任何可用 Key：面板设置里填 imageApiKey、设 APIZ_API_KEY，或先 apiz auth login')
  process.exit(2)
}

const started = Date.now()
try {
  const result = await runGenerate({
    prompt: 'Product photo of the item in the reference image, on a pure white background, studio lighting, centered, no text.',
    size: '1024x1024',
    quality: 'low',
    referenceImages: [REF],
    outputPath: join(ROOT, 'ref-test.png'),
  })
  console.log('✓ 生成成功')
  console.log('  文件      ', result.file)
  console.log('  实际尺寸  ', result.actualSize)
  console.log('  质量档位  ', result.record.quality)
  console.log('  参考图数量', result.record.referenceCount)
  console.log('  task_id   ', result.record.taskId)
  console.log('  预扣积分  ', result.record.price)
  console.log('  耗时      ', `${((Date.now() - started) / 1000).toFixed(1)} 秒`)
  console.log('  Key 来源  ', result.record.keySource)
  if (result.warnings?.length) console.log('  提醒      ', result.warnings.join('；'))
  console.log('  历史条数  ', readHistory().length)
} catch (err) {
  console.error('✗ 失败：', err?.message ?? err)
  process.exit(1)
}

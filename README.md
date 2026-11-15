# dsh-amazon-image-studio · 亚马逊图片工作台

DeepSeek Harness（dsh）插件：**Amazon Listing / A+ 图片 AI 策划 + 逐张生图 + 合规打标**。把粘贴的 Listing 文案策划成 `MAIN + PT01-06`（7-12 张可调）Listing 图方案或四套 A+ 模块（普通/标准/高级/手机）逐张方案——每张含中文策划说明、英文生图 Prompt、负面词；再逐槽位组装最终 Prompt、挂风格板、一次一张生成；另附 AI 人物媒体 XMP 打标工具。侧栏「亚马逊图片」面板提供策划台 / 策划档案 / 生成历史 / AI 人物打标 / 工作流指南。

方法论与策划引擎移植自 [Ali-Aria/amazon-image-studio](https://github.com/Ali-Aria/amazon-image-studio)（MIT，上游基于 CookSleep/gpt_image_playground）。

## 装上以后有什么

| 能力 | 说明 |
|---|---|
| `amz_slots` | **槽位与规格查询**（确定性）：Listing 槽位表（MAIN+PT01-N）、四套 A+ 模块编排（槽位/模块类型/官方上传尺寸/生图换算尺寸）、模块增删 |
| `amz_plan` | **AI 策划**：Listing 文案 + 参考图（≤8MiB）→ 逐张方案 JSON（严格 schema：中文策划说明 + 英文 Prompt/负面词 + 站点语言图上文案）。配了策划 Key 直接调模型（DeepSeek 官方地址自动切纯文本模式）；未配置返回完整自策划指引，由对话模型策划 |
| `amz_validate_plan` | **策划校验闸门**：agent 自策划 / 外部策划 JSON 过严格校验（槽位数量顺序、字段语言规则、A+ 模块尺寸）后存档拿 planId |
| `amz_prompt` | **最终 Prompt 组装**：图片任务 + 风格块（最高优先级，仅附图/A+，MAIN 白底不挂）+ seriesStyleGuide（低优先级）+ 版面密度 + 负面词 + 风格防复制守卫 + 期望分辨率 |
| `amz_generate` | **一次一张生图**：按槽位自动组装/挂风格板/定尺寸；火山 Seedream / OpenAI 兼容（含 OpenRouter chat 生图）/ 阿里百炼 Qwen-Image 三适配器；未配 Key 走即梦 / apiz CLI 兜底 |
| `amz_tag_performer` | **AI 人物打标**：JPG/PNG/WebP/MP4/MOV 写入 Amazon 要求的 `contains-synthetic-performer` XMP（纯本地零网络，已打标自动跳过，单文件 ≤500MB / 批 ≤1GB） |
| `amz_history` | 策划档案 + 生图历史 list/get/remove/clear |
| `amazon-image-studio` 技能 | 策划方法论 + 合规红线 + 字段语言规则 + 生图通道兜底 + 工具优先指引 |
| 侧栏面板 | 策划台（双模式表单 + 风格预设色卡 + 逐槽位 Prompt 卡片：预览/复制/生成/填对话）、策划档案、生成历史、AI 人物打标（拖文件写入 + 下载）、工作流与合规指南 |

## 使用

对话里一句话：

- **「帮我给这款保温杯策划一套亚马逊 Listing 图」**——`amz_slots` 确认槽位 → `amz_plan`（或按指引自策划 + `amz_validate_plan`）→ 逐槽位 `amz_prompt` 给你过目 → `amz_generate` 一次一张
- **「出这套产品的 A+ 图，用高级A+」**——`amz_slots`（aplusType: premium）→ 策划 → 逐模块生成；Highlight Tile 的标题/正文文案单独输出
- **「这张 AI 生成的人物视频要给亚马逊，打个标」**——`amz_tag_performer` 写 XMP
- **「看看之前策划了什么」**——`amz_history`

面板里：粘贴 Listing 文案 → 「AI 策划」（未配 Key 时一键填进对话）→ 逐槽位卡片「预览 Prompt / 复制 / 生成 / 填进对话生图」→ 生成历史看图。

## 配置（插件设置）

| 配置 | 默认 | 说明 |
|---|---|---|
| plannerApiUrl / plannerApiKey / plannerModel | deepseek / 空 / deepseek-v4-flash | AI 策划 API（OpenAI 兼容 Chat Completions 或 Responses）；**留空 Key = 对话内策划**（零门槛可用） |
| plannerApiMode | chat | chat / responses |
| imageProvider | volces | volces（火山方舟 Seedream）/ openai（OpenAI 兼容）/ aliyun（阿里百炼 Qwen-Image，DashScope 地址自动识别） |
| imageApiUrl / imageApiKey / imageModel | 服务商默认 / 空 / 空 | 留空 Key = 生图走 dreamina-canvas / apiz CLI 兜底 |
| outputTier | 2K | 2K / 4K |

### 生图通道

| 通道 | 默认模型 | 说明 |
|---|---|---|
| `volces`（默认） | `doubao-seedream-5-0-pro-260628` | 火山方舟 Ark API；Pro 模型原生 2K/4K、`image` 参考图；自己充值 |
| `openai` | `gpt-image-2` | Images API；有参考图自动走 `/images/edits` multipart；OpenRouter 地址自动切 chat 生图（`modalities` + `image_config`） |
| `aliyun` | `qwen-image-3.0-pro` | DashScope 原生多模态生图；≤3 参考图；512²-2048² 尺寸归一化 |
| CLI 兜底 | 即梦 / apiz | 未配 Key 时按 skill 指引改用 `dreamina-canvas`（2K 约 6 分/张）或 `apiz` CLI，Prompt 照用 `amz_prompt` 组装结果 |

## 前置条件

- dsh >= 0.2.1-rc.2，Node 22+
- AI 策划：策划 API Key（可选；不配则对话内策划）
- 生图：生图 API Key（可选；不配则 CLI 兜底）或即梦/apiz CLI 登录

## 开发

```bash
npm test          # 39 个离线单测（含 mock 策划/生图 API 全链路）
npm run selftest  # 随包资产 / skill provider / 引擎关键路径自检
npm run sandbox   # 隔离沙盒起真宿主（/tmp 或 %TEMP% 下 dsh-smoke-home）
```

沙盒起来后浏览器打开终端里的地址（带 token），点侧栏「亚马逊图片」验收面板；面板 API 可 `curl`（带 URL token）。

## 安全与隐私

- API Key 只存在本机 dsh 配置里；面板状态接口对 Key 脱敏展示。
- 打标工具完全本地处理，不上传任何文件。
- 生图/策划直接连你配置的服务商，插件不经手不缓存 Prompt 之外的数据。

## 许可与来源

本项目以 MIT License 发布（见 LICENSE）。策划引擎、Prompt 模板、风格预设与合规知识移植自 MIT 许可的 [Ali-Aria/amazon-image-studio](https://github.com/Ali-Aria/amazon-image-studio)（上游：[CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)）；本插件为 dsh 插件形态的移植重构，保留上游署名。

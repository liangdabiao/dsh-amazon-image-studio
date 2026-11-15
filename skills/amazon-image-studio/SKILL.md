---
name: amazon-image-studio
description: Amazon Listing / A+ 图片策划与生成方法论：把产品 Listing 文案策划成 MAIN+PT01-06（7-12 张）Listing 图或四套 A+ 模块（标准/普通/高级/手机）逐张方案（中文策划说明 + 英文生图 Prompt + 负面词），再逐张生成合规商品图（主图白底、附图挂风格板、6 站点本地化文案）。Use when the user wants Amazon product listing images, Amazon A+ content images, 主图/附图策划, Listing 图片生成, A+ 图片编排, 亚马逊商品图合规, or contains-synthetic-performer XMP tagging.
---

# 亚马逊图片策划与生成（Amazon Image Studio）

把 Amazon Listing 文案（标题、五点描述、产品说明）与可选产品参考图，策划成一套合规的商品图片方案，并逐张生成。两条工作流：

- **Listing 图**：`MAIN + PT01…PT(N-1)`，默认 7 张（7-12 张可调），MAIN 是白底主图，PT 是附图。
- **A+ Content 图**：四套模块编排（普通A+ / 标准A+ / 高级A+ / 手机A+），每套 1-12 个模块，模块类型与官方上传尺寸固定。

## 0. 先查槽位，再策划

动手前先 `amz_slots` 拿槽位表（Listing：数量与 PT 编号；A+：模块编排、官方上传尺寸、生图换算尺寸）。应用只固定**槽位数量和顺序**，每张的策略/构图/文案/Prompt 全由你（或策划模型）决定。

A+ 四套编排（生图换算按模块比例，官方上传尺寸如下）：

| 类型 | 模块 |
|---|---|
| 普通A+（standard-large） | A+L01 Header Banner 970x300；A+L02-05 Single Image 970x600 |
| 标准A+（standard） | A+S01 Header Banner 970x300；A+S02-04 Single Image 970x600；A+S05-08 Highlight Tile 220x220（外部标题/正文文案单独给，不画进图） |
| 高级A+（premium） | A+P01 Hero Banner 1464x600；A+P02-04 Feature Image 970x600；A+P05-06 Brand Story 463x625 |
| 手机A+（mobile） | A+M01-05 全部 600x450（1 hero + 4 feature），单模块单信息，短文案，忌多列 |

可选模块：A+LOGO 600x180（只在有真实 Logo 素材时用）、A+CMP 150x300（同品牌 SKU 对比）。

## 1. AI 策划（amz_plan）

给 `amz_plan` 传：`listingText`（粘贴的 Listing 原文）+ 可选参考图 `referenceImages`（实拍/包装/结构图，总负载 ≤8MiB）+ 可选商品事实（productTitle/brand/category/color/material/audience/packageIncludes/sellingPoints/forbidden）+ `mode`/`marketplaceId`/`listingImageCount`/`aplusType`。

**双模式**：

- 插件配置了策划 API Key → `amz_plan` 直接调策划模型，返回严格校验过的策划 JSON（planId）。
- 没配置 → `amz_plan` 返回 `agentPlanning` 指引（槽位表 + 完整策划指令 + 合规知识）。**你按指引自行策划**，产出符合 schema 的 JSON，然后交给 `amz_validate_plan` 校验存档（校验会查槽位数量与顺序、字段语言规则；通过返回 planId）。校验失败按报错修 JSON 再交。

### 策划 JSON 的字段规则（两处都强制）

- `label`、`planMarkdown`：简体中文（planMarkdown 是每张的详细策划说明，类似 ChatGPT agent 回答）。
- `seriesStyleGuide`、`prompt`、`negativePrompt`：英文。
- `prompt` 内描述的**图片可见文案**用目标站点语言（美国站 US-English、日本站允许日文……）。
- A+ 的 `textTitle`/`textBody`（Highlight Tile 的外部文案）：目标站点语言或空串。
- 每张 prompt 要完整规划成品图：构图、产品证据、必要时的图上文案、标注/信息区、视觉层级、渲染风格。
- `seriesStyleGuide` 只管跨图产品一致性（外观/事实连续性），**不要**用它锁配色/字体/背景氛围——配色由用户选的风格板控制。
- 不要策划独立的「风格板图」；不要生成图片，只返回 JSON。

### 合规红线（策划与生图都要遵守）

主图（MAIN）：
- 纯白背景 RGB 255,255,255，商品占画面约 85%，完整不裁切，真实颜色与比例。
- 无文字、徽标、水印、边框、色块、道具、支撑物、包装（包装本身是卖点除外）。

全部图片：
- 只展示所售商品；颜色/数量/比例/配件必须真实；禁裸露或性暗示。
- 禁：买家评价、五星评分、价格、优惠券、免运费、卖家专属声明、无依据功效/获奖/环保声明、"best/top-rated" 等夸大词。
- 禁：Amazon / Prime / Alexa / Amazon Choice / Best Seller / 热卖等徽标及一切近似页面元素。
- A+ 额外禁：二维码、电话、邮箱、地址、外链、竞品提及、授权声明、强催单话术（buy now / add to cart）；TM/®/© 只在包装或真实 Logo 已有时用。

参考图规则：参考图只用于提取**产品事实**（外观/颜色/结构/配件/材质/包装内容），不得用它决定视觉风格与配色——风格由用户选的风格板控制。策划模型收不到参考图时（DeepSeek 纯文本），不要臆造颜色/结构/配件/印刷文字，拿不准的细节保持中性描述。

## 2. 逐张组装 Prompt（amz_prompt）

策划存档后，对每个槽位调 `amz_prompt`（planId + slot）。工具自动组装最终 Prompt：

1. 图片任务 prompt（英文）
2. 选中视觉风格块（最高优先级）——仅附图/A+；**MAIN 主图永远不挂风格图**（白底合规）
3. seriesStyleGuide（低优先级）
4. 版面密度指令（rich/minimal）
5. Negative prompt
6. 风格参考防复制守卫（不复制风格板本身的布局/色卡位置/字样）
7. 期望输出分辨率行

风格来源三选一：内置预设（clean-tech 清爽科技 / natural-warm 自然暖调 / premium-contrast 高级对比 / bright-retail 明亮零售，各带 C1-C6 色卡：背景底色/柔和辅助/主强调/深色文字/中性/高亮点缀）、用户模板图（templateImagePath，替代色卡）、`none`（完全不挂）。

## 3. 逐张生成（amz_generate，一次一张）

- 优先 `amz_generate`（planId + slot）：自动组装 Prompt、按槽位挂风格板（MAIN 不挂）、按模块比例换算生图尺寸（Listing 默认 2048x2048；4K 4096x4096；A+ 按模块比例）。
- 生成前把 `amz_prompt` 给你的最终 Prompt 简要过目给用户；**一次只调一张**，完成后继续下一张。
- Highlight Tile 的 `textTitle`/`textBody` 外部文案单独输出给用户，不写进生图 Prompt。

### 生图通道兜底

插件没配生图 API Key（`amz_generate` 会报错提示）时，改用 CLI 通道（与「电商视觉创作」插件同款）：

- **即梦 dreamina-canvas**（默认）：`dreamina-canvas auth account` 查积分（2K 约 6 分/张），Prompt 用 `amz_prompt` 组装好的最终 Prompt，参考图 ≤10 张（风格板/模板图当最后一张参考图；MAIN 不给风格图）。
- **apiz CLI**：`apiz/gpt-image-2.5-flare` 等 13 个模型，参考图 `--params '{"reference_image_urls":[…]} '`。

CLI 出的图也请告诉用户路径；想要统一入档可以让用户在插件设置里补生图 Key 后用 `amz_generate`。

## 4. 策划档案与历史（amz_history）

- `list`：所有策划档案（planId、槽位、标题）。
- `get`（planId）：档案详情（逐槽位策划说明/Prompt）。
- `generate-list` / `generate-get`：生图历史（文件路径、尺寸、模型）。
- `remove` / `clear` / `generate-clear`：删除。

## 5. AI 人物媒体打标（amz_tag_performer）

处理**已确认需要披露**的 AI 生成人物媒体（不判断是否 AI）：给 JPG/JPEG/PNG/WebP/MP4/MOV 写入 Amazon 要求的 `contains-synthetic-performer` XMP 标记（位于 `dc:subject` 的 `rdf:Bag`，不是文件名或水印）。纯本地处理，只改元数据，不重编码像素/音视频流；已正确打标的文件自动跳过；单文件 ≤500MB、单批 ≤1GB；`action: check` 只校验；建议传 `outDir` 保留原件。

## 6. 目标站点（marketplaceId）

us 美国站 / jp 日本站 / de 德国站 / fr 法国站 / it 意大利站 / es 西班牙站。影响图上可见文案语言与本地化指令（日本站允许日文图上文案，其他站禁止 CJK 图上文案）。

## 7. 硬规则

1. 先 `amz_slots`，再策划；策划 JSON 必须过 `amz_validate_plan`（除非 `amz_plan` 已直接返回 planId）。
2. MAIN 白底不挂风格图；附图/A+ 挂用户选的风格板。
3. 图上可见文案用站点语言；prompt/负面词英文。
4. 一次一张，生成后确认再下一张；数量大先看余额（CLI 通道）或跟用户确认。
5. A+ Highlight Tile 外部文案单独给，不画进 220x220 图里。
6. 打标只处理用户确认需要的 AI 人物媒体，工具不判断内容。

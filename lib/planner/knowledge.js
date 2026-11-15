// 亚马逊站点配置与策划知识注入（移植自上游 amazonMarketplaces.ts / amazonKnowledge.ts）

export const AMAZON_MARKETPLACES = [
  {
    id: 'us',
    label: '美国站',
    shortLabel: 'US',
    domain: 'Amazon.com',
    locale: 'en-US',
    copyLanguage: 'US English',
    onImageCopyLanguage: 'US-English',
    localGuidance: [
      'Use concise US-English customer-facing copy with natural American spelling, phrasing, and units.',
      'Avoid machine-translated phrasing, Chinese copy, and non-US marketplace wording in visible text.',
    ],
    allowsCjkVisibleCopy: false,
  },
  {
    id: 'jp',
    label: '日本站',
    shortLabel: 'JP',
    domain: 'Amazon.co.jp',
    locale: 'ja-JP',
    copyLanguage: 'Japanese',
    onImageCopyLanguage: 'Japanese',
    localGuidance: [
      'Use concise natural Japanese customer-facing copy suitable for Amazon.co.jp shoppers.',
      'Japanese visible text may use Japanese characters; avoid Simplified Chinese UI wording and awkward direct translation.',
    ],
    allowsCjkVisibleCopy: true,
  },
  {
    id: 'de',
    label: '德国站',
    shortLabel: 'DE',
    domain: 'Amazon.de',
    locale: 'de-DE',
    copyLanguage: 'German',
    onImageCopyLanguage: 'German',
    localGuidance: [
      'Use concise natural German customer-facing copy suitable for Amazon.de shoppers.',
      'Use German spelling and units where relevant; avoid English, Chinese copy, and literal machine translation.',
    ],
    allowsCjkVisibleCopy: false,
  },
  {
    id: 'fr',
    label: '法国站',
    shortLabel: 'FR',
    domain: 'Amazon.fr',
    locale: 'fr-FR',
    copyLanguage: 'French',
    onImageCopyLanguage: 'French',
    localGuidance: [
      'Use concise natural French customer-facing copy suitable for Amazon.fr shoppers.',
      'Use French accents, phrasing, and units where relevant; avoid English, Chinese copy, and literal machine translation.',
    ],
    allowsCjkVisibleCopy: false,
  },
  {
    id: 'it',
    label: '意大利站',
    shortLabel: 'IT',
    domain: 'Amazon.it',
    locale: 'it-IT',
    copyLanguage: 'Italian',
    onImageCopyLanguage: 'Italian',
    localGuidance: [
      'Use concise natural Italian customer-facing copy suitable for Amazon.it shoppers.',
      'Use Italian phrasing and units where relevant; avoid English, Chinese copy, and literal machine translation.',
    ],
    allowsCjkVisibleCopy: false,
  },
  {
    id: 'es',
    label: '西班牙站',
    shortLabel: 'ES',
    domain: 'Amazon.es',
    locale: 'es-ES',
    copyLanguage: 'Spanish',
    onImageCopyLanguage: 'Spanish',
    localGuidance: [
      'Use concise natural Spanish customer-facing copy suitable for Amazon.es shoppers.',
      'Use Spanish phrasing and units where relevant; avoid English, Chinese copy, and literal machine translation.',
    ],
    allowsCjkVisibleCopy: false,
  },
]

export const DEFAULT_AMAZON_MARKETPLACE_ID = 'us'
const MARKETPLACE_BY_ID = new Map(AMAZON_MARKETPLACES.map((m) => [m.id, m]))

export function isAmazonMarketplaceId(value) {
  return typeof value === 'string' && MARKETPLACE_BY_ID.has(value)
}

export function normalizeAmazonMarketplaceId(value) {
  return isAmazonMarketplaceId(value) ? value : DEFAULT_AMAZON_MARKETPLACE_ID
}

export function getAmazonMarketplace(value) {
  return MARKETPLACE_BY_ID.get(normalizeAmazonMarketplaceId(value)) ?? AMAZON_MARKETPLACES[0]
}

// ---------------------------------------------------------------- 策划参考知识

const LISTING_REFERENCE_NOTES = [
  'Source summary: current project knowledge files for Amazon product images and A+ image sizing. Treat this as reference material for judgment, not a fixed creative template.',
  'Every product needs a compliant MAIN image; a strong gallery usually adds about 6 secondary images and may also include video outside this image workflow.',
  'Image technical baseline: use clear, non-pixelated product images; supported still formats include JPEG/JPG, PNG, TIFF, and non-animated GIF; the longest side should be 500-10,000 px.',
  'MAIN image reference: accurately show the real sold product with truthful color, proportion, quantity, and included accessories; use a seamless pure white background RGB 255,255,255; product fills about 85% of the frame; keep the whole product inside the frame without cropping.',
  'MAIN image exclusions: no text, logo, watermark, border, color block, graphic overlay, badge, prop, support stand, confusing accessory, extra item, duplicate product view, or packaging unless packaging is an actual product feature.',
  'All listing images should match the product title and only show what is sold or needed to explain the sold item. Avoid nudity or sexually suggestive content, buyer reviews, five-star ratings, pricing, coupons, free shipping, seller-specific claims, unsupported claims, and variant-image text/pricing.',
  'Do not use Amazon, Prime, Alexa, Amazon Choice, Premium Choice, Best Seller, hot-sale badges, marketplace marks, or any lookalike logo, badge, or page element.',
  'Secondary images may use compliant lifestyle, detail, scale, contents, comparison-within-product, or use-step concepts when supported by the listing and references. On-image copy should be concise, defensible, and readable on mobile.',
]

const APLUS_REFERENCE_NOTES = [
  'Source summary: current project knowledge files for Amazon A+ content rules and this app\'s A+ module image size references. Treat this as reference material for judgment, not a fixed creative template.',
  'A+ technical baseline: plan RGB JPG/PNG/BMP assets, at least 72 dpi, sharp and non-blurry, under 2 MB per upload, no animation, no watermark, and no tiny text that cannot be read on mobile.',
  'Standard A+ upload size references: Header Banner 970x300, Single Image 970x600, Logo Image 600x180, Highlight Tile 220x220, Comparison Thumbnail 150x300.',
  'Premium A+ upload size references: Hero Banner 1464x600, Single/Feature Image 970x600, Logo Image 600x180, Brand Story module image around 463x625.',
  'Mobile A+ upload size reference in this app: five compact 600x450 modules, with one mobile hero and four mobile feature images. Use short mobile-readable copy and avoid dense multi-column layouts.',
  'Design reference: keep key content in a central safe area, use mobile-readable copy, clear hierarchy, balanced spacing, and coherent lighting, color palette, composition logic, material treatment, and typography direction across modules.',
  'A+ should be unique to the product and brand story; avoid simply reusing the same images already planned for the listing carousel.',
  'A+ may use one helpful brand mark and may use a Logo Image module for an existing brand mark; do not invent partner logos or extra marks.',
  'Trademark/copyright symbols such as TM, ®, or © should only appear when already present on the product packaging or as part of a real logo; otherwise remove standalone symbols.',
  'A+ copy and images should avoid prices, discounts, coupons, free shipping, QR codes, phone numbers, email addresses, postal addresses, external URLs, hyperlinks, customer reviews, star ratings, competitor mentions, seller authorization claims, unsupported guarantees, and aggressive purchase calls to action such as buy now or add to cart.',
  'Avoid unsupported awards, certifications, eco claims, medical/cure/prevention claims, satisfaction guarantees, exaggerated claims such as best/top-rated/bestseller, and time-sensitive hype such as new/latest/sale unless the listing provides defensible substantiation and the placement is allowed.',
  'Do not mimic Amazon page UI or use Amazon, Prime, Alexa, Amazon Choice, Premium Choice, Best Seller, hot-sale badges, or lookalike marketplace marks.',
]

function getMarketplaceReferenceNotes(marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return [
    `Target marketplace: ${marketplace.label} (${marketplace.domain}, locale ${marketplace.locale}).`,
    `Visible customer-facing copy should be concise, defensible, mobile-readable ${marketplace.onImageCopyLanguage}.`,
    ...marketplace.localGuidance,
    `Do not mimic ${marketplace.domain} page UI or use local Amazon marketplace badges, Best Seller badges, ratings, pricing, coupons, urgency claims, or lookalike marks.`,
  ]
}

function formatReferenceMaterial(title, notes) {
  return [title, ...notes.map((note) => `- ${note}`)].join('\n')
}

export function formatAmazonListingReferenceMaterial(marketplaceId) {
  return formatReferenceMaterial('Amazon Listing reference material for the planner:', [
    ...LISTING_REFERENCE_NOTES,
    ...getMarketplaceReferenceNotes(marketplaceId),
  ])
}

export function formatAmazonAPlusReferenceMaterial(marketplaceId) {
  return formatReferenceMaterial('Amazon A+ reference material for the planner:', [
    ...APLUS_REFERENCE_NOTES,
    ...getMarketplaceReferenceNotes(marketplaceId),
  ])
}

// skill / 工具回执用的中文精炼合规清单（从 LISTING/APLUS NOTES 提炼）
export const LISTING_COMPLIANCE_ZH = [
  '主图：纯白背景 RGB 255,255,255，商品占画面约 85%，完整不裁切，无文字/徽标/水印/边框/道具/包装（包装本身是卖点除外）。',
  '全部图片只展示所售商品本身，颜色/数量/比例/配件必须真实。',
  '禁：买家评价、五星评分、价格、优惠券、免运费、卖家专属声明、无依据功效声明。',
  '禁：Amazon / Prime / Alexa / Amazon Choice / Best Seller / 热卖等徽标及一切近似元素。',
  '附图可用合规的场景/细节/比例/套装/步骤概念，图上文字精简、移动端可读、站得住脚。',
]

export const APLUS_COMPLIANCE_ZH = [
  'A+ 技术底线：RGB JPG/PNG，≥72dpi，单图 <2MB，无动画，无水印，手机可读的小字号。',
  '尺寸参考：标准 A+（970x300 横幅 / 970x600 大图 / 600x180 Logo / 220x220 方块 / 150x300 对比）；高级 A+（1464x600 首屏 / 970x600 大图 / 463x625 品牌故事）；手机 A+（5 张 600x450）。',
  'TM/®/© 只在产品包装或真实 Logo 上已有出现时使用。',
  '禁：价格/折扣/二维码/电话/邮箱/地址/外链/评价/竞品/授权声明/无依据担保；禁 buy now、add to cart 等强催单话术。',
  '禁：Amazon 页面 UI 模仿与任何亚马逊徽标近似元素；A+ 内容应独特于品牌故事，不要复用 Listing 图。',
]

/**
 * 封面视觉风格库 + 题材推断 + 提示词构建
 * 参考自 oh-story-claudecode/skills/story-cover (https://github.com/worldwonderer/oh-story-claudecode)
 *
 * oh-story 方法论核心:
 *   1. 平台风格库(番茄/起点/晋江/知乎盐言/七猫/刺猬猫)
 *   2. 题材推断规则(书名关键词→题材→风格标签)
 *   3. 提示词构建公式: [平台风格] + [文字层:书名+作者名+字体] + [题材风格] + [人物] + [背景] + [色彩] + [光效] + [通用修饰]
 *   4. 文字层格式: GPT-Image-2 可直接渲染中文,用 "Title text '书名' at top center in {字体}" 指令
 *
 * InkForge 集成: generate-cover 路由用本模块构建更专业的 prompt,
 *   若图像模型支持中文渲染(gpt-image 系列)则一步到位含书名作者,否则前端 canvas 叠加兜底
 */

// —— 平台风格库(移植自 oh-story cover-styles.md) ——
export interface PlatformStyle {
  key: string;
  label: string;
  /** 视觉关键词(英文,直接拼入 prompt) */
  keywords: string;
  /** 书名字体风格(英文,用于文字层指令) */
  titleFont: string;
  /** 作者名字体风格(英文) */
  authorFont: string;
  /** 默认尺寸(平台上传像素提示) */
  size: string;
}

export const PLATFORM_STYLES: Record<string, PlatformStyle> = {
  fanqie: {
    key: 'fanqie', label: '番茄小说',
    keywords: 'vibrant saturated colors, eye-catching bold design, character portrait dominating frame, mass-market novel cover style, high contrast',
    titleFont: 'bold golden brush calligraphy with metallic glow and sharp strokes',
    authorFont: 'small refined white serif text with faint golden glow',
    size: '768x1024',
  },
  qidian: {
    key: 'qidian', label: '起点中文网',
    keywords: 'polished refined illustration, detailed cinematic composition, epic atmospheric, mature sophisticated style, premium quality',
    titleFont: 'traditional Chinese brush kaishu calligraphy, dark ink with subtle gold edge',
    authorFont: 'small elegant serif text in muted tone',
    size: '1024x1536',
  },
  jjwxc: {
    key: 'jjwxc', label: '晋江文学城',
    keywords: 'dreamy ethereal aesthetic, soft pastel tones, elegant romantic, delicate beauty, flower petals and bokeh',
    titleFont: 'elegant flowing xingshu semi-cursive calligraphy in soft pink-gold',
    authorFont: 'tiny refined serif text in muted lavender',
    size: '1024x1536',
  },
  zhihu: {
    key: 'zhihu', label: '知乎盐言',
    keywords: 'minimalist literary style, clean composition with negative space, subtle moody atmosphere, independent film poster aesthetic',
    titleFont: 'modern sans-serif typography, clean and understated',
    authorFont: 'tiny minimal sans-serif text in cool grey',
    size: '1024x1536',
  },
  qimao: {
    key: 'qimao', label: '七猫小说',
    keywords: 'striking high-impact design, vivid dramatic colors, spectacular visual effects, attention-grabbing poster style',
    titleFont: 'large glowing bold calligraphy with fiery edge effects',
    authorFont: 'small bold white serif with subtle glow',
    size: '768x1024',
  },
  ciweimao: {
    key: 'ciweimao', label: '刺猬猫',
    keywords: 'anime illustration style, vibrant colorful, detailed character art, Japanese light novel aesthetic',
    titleFont: 'playful hand-drawn cartoon style title text',
    authorFont: 'small cute handwritten sans-serif text',
    size: '1024x1536',
  },
  generic: {
    key: 'generic', label: '通用',
    keywords: 'professional book cover design, polished illustration, atmospheric composition',
    titleFont: 'elegant bold serif typography with subtle glow',
    authorFont: 'small refined serif text in muted tone',
    size: '1024x1536',
  },
};

export const PLATFORM_LIST = Object.values(PLATFORM_STYLES);

// —— 题材推断规则(移植自 oh-story cover-styles.md) ——
interface GenreInference {
  keywords: string[];   // 书名命中任一关键词即推断该题材
  label: string;        // 题材中文名
  styleTag: string;     // 英文风格标签(直接拼入 prompt)
  palette: string;      // 色彩指令
  lighting: string;     // 光效指令
}

const GENRE_INFERENCE: GenreInference[] = [
  { keywords: ['仙', '道', '剑', '灵', '修', '宗', '天', '帝', '尊', '神'], label: '玄幻/仙侠',
    styleTag: 'xianxia Chinese fantasy art style, ethereal atmosphere',
    palette: 'deep blue, gold, white, black, cold tones with golden light accents',
    lighting: 'divine golden light rays, mystical mist, spiritual energy glow' },
  { keywords: ['都市', '总裁', '校园', '重生', '系统', '学霸', '医生', '兵王'], label: '都市',
    styleTag: 'modern urban contemporary style, clean cinematic composition',
    palette: 'deep blue, grey, gold, with neon or warm sunset accents',
    lighting: 'sharp city lights, sunset glow reflecting on glass buildings, neon rim light' },
  { keywords: ['妃', '皇', '侯', '宫', '嫡', '庶', '后', '朝', '凤', '鸾'], label: '古言',
    styleTag: 'ancient Chinese romance palace drama, elegant classical beauty',
    palette: 'crimson red, gold, ink black, sumptuous and rich',
    lighting: 'warm lantern light, golden candle glow, silk fabric shimmering' },
  { keywords: ['总裁', '契约', '替嫁', '甜宠', '娇妻', '萌宝', '闪婚'], label: '现言',
    styleTag: 'modern romance cover art, soft dreamy warm atmosphere',
    palette: 'pink, warm white, light gold, soft and warm',
    lighting: 'soft warm backlighting, dreamy bokeh, gentle sunset glow' },
  { keywords: ['诡', '案', '侦探', '悬疑', '推理', '密室', '连环'], label: '悬疑',
    styleTag: 'dark mystery thriller, noir atmosphere, high contrast shadows',
    palette: 'black, dark grey, dark blue, with blood red or cold white accents',
    lighting: 'dramatic chiaroscuro, single spotlight, rain-slicked reflections' },
  { keywords: ['星际', '末世', '机甲', '赛博', '废土', '进化'], label: '科幻',
    styleTag: 'sci-fi cyberpunk, futuristic technology, post-apocalyptic',
    palette: 'deep blue, black, silver, with neon blue, electric purple, energy green accents',
    lighting: 'holographic blue glow, neon rim lighting, energy arcs' },
  { keywords: ['龙', '骑', '魔法', '异世界', '精灵', '领主'], label: '西幻',
    styleTag: 'western high fantasy, epic medieval atmosphere',
    palette: 'deep blue, dark gold, silver white, with fire red or magic purple accents',
    lighting: 'magic spell glow, dramatic stormy sky, firelight from torches' },
  { keywords: ['三国', '大明', '大唐', '战场', '将军', '谋士'], label: '历史',
    styleTag: 'historical Chinese war epic, grand battlefield panorama',
    palette: 'iron grey, dark red, earth yellow, with golden armor or beacon orange accents',
    lighting: 'dramatic battlefield firelight, smoke-filled sky, sunset over war' },
  { keywords: ['鬼', '僵尸', '阴阳', '风水', '盗墓', '咒'], label: '灵异',
    styleTag: 'Chinese supernatural horror, eerie ghostly atmosphere',
    palette: 'ink black, ghostly green, dark red, with paper white or candlelight yellow accents',
    lighting: 'eerie green glow, flickering candlelight, cold ghostly luminescence' },
  { keywords: ['萌', '喵', '团宠', '娇', '转生'], label: '轻小说',
    styleTag: 'anime light novel cover, vibrant colorful moe style',
    palette: 'bright multicolor, with starlight and petal accents',
    lighting: 'sparkly star effects, magical particle effects, soft luminous glow' },
];

/** 由书名推断题材风格(命中第一个即返回,无命中返回通用) */
export function inferGenreStyle(bookTitle: string, projectGenre?: string): GenreInference {
  // 优先用书名关键词推断
  for (const g of GENRE_INFERENCE) {
    if (g.keywords.some(kw => bookTitle.includes(kw))) return g;
  }
  // 其次用项目题材 label 模糊匹配
  if (projectGenre) {
    for (const g of GENRE_INFERENCE) {
      if (g.label.includes(projectGenre) || projectGenre.includes(g.label.split('/')[0])) return g;
    }
  }
  // 兜底:玄幻仙侠风格(网文最常见)
  return GENRE_INFERENCE[0];
}

// —— 图像模型中文渲染能力检测 ——
// gpt-image-2 / gpt-image-1 等支持直接渲染中文文字,可一步到位含书名作者
// dall-e-3 / SD / FLUX 等不支持,需前端 canvas 叠加
const TEXT_RENDER_MODELS = /gpt-image|dall-?e-3|seedream|cogview-4|kolors|ideogram|imagen-3/i;

/** 判断图像模型是否支持直接渲染中文文字 */
export function supportsTextRendering(model: string): boolean {
  return TEXT_RENDER_MODELS.test(model);
}

// —— 提示词构建公式(移植自 oh-story cover-styles.md) ——
// [平台风格] + [文字层:书名+作者名+字体] + [题材风格] + [人物] + [背景] + [色彩] + [光效] + [通用修饰]
export interface CoverPromptParams {
  bookTitle: string;
  author: string;
  platform: PlatformStyle;
  genre: GenreInference;
  /** 中文画面构思(LLM 生成,30-80 字) */
  visualConcept: string;
  /** 是否让图像模型直接渲染文字层(true 时 prompt 含 Title text/Author name 指令) */
  renderText: boolean;
}

/**
 * 构建封面英文 prompt(oh-story 公式)
 * 输出可直接喂给 GPT-Image-2 / SD / MJ 的英文 prompt
 */
export function buildCoverEnPrompt(params: CoverPromptParams): string {
  const { bookTitle, author, platform, genre, visualConcept, renderText } = params;
  const parts: string[] = [];

  // 1. 平台风格
  parts.push(platform.keywords);

  // 2. 文字层(仅当图像模型支持中文渲染时才加,否则会让不支持文字的模型乱码)
  if (renderText) {
    parts.push(`Title text '${bookTitle}' at top center in ${platform.titleFont}`);
    if (author) {
      parts.push(`Author name '${author}' at bottom center in ${platform.authorFont}`);
    }
  } else {
    // 不支持文字渲染时,引导留白给后期 canvas 叠加
    parts.push('negative space at top and bottom for title text overlay, book cover layout, no text in image');
  }

  // 3. 题材风格标签
  parts.push(genre.styleTag);

  // 4. 画面构思(中文描述翻译为英文要点,这里直接用中文构思让 LLM 在 generate-cover 阶段已翻译,
  //    cover-preview 阶段直接用 enPrompt,故此处保留 visualConcept 作为画面指引)
  if (visualConcept) {
    parts.push(visualConcept);
  }

  // 5. 色彩指令
  parts.push(`color palette: ${genre.palette}`);

  // 6. 光效指令
  parts.push(`lighting: ${genre.lighting}`);

  // 7. 通用修饰
  parts.push('professional book cover design, high detail digital painting, portrait orientation 2:3 ratio, no watermark');

  return parts.join(', ');
}

/** 由 visualConcept 提取英文 prompt(从 LLM 生成的双段输出中解析) */
export function extractEnPrompt(coverDraft: string): string {
  if (!coverDraft) return '';
  const lines = coverDraft.split('\n');
  // 优先匹配 "Prompt: ..." 或 "Prompt：..."
  const promptLine = lines.find(l => /^\s*prompt\s*[:：]\s*/i.test(l));
  if (promptLine) {
    return promptLine.replace(/^\s*prompt\s*[:：]\s*/i, '').trim();
  }
  // 兜底:找第一段连续英文行(长度>30)
  const enLine = lines.find(l => /^[\x21-\x7e\s]+$/.test(l.trim()) && l.trim().length > 30);
  return enLine ? enLine.trim() : coverDraft.trim();
}

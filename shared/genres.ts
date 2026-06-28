/**
 * 统一题材库 —— 前后端共享
 * 取代分散在 Generate.tsx (104 项) / Market.tsx (32 项) 的两份硬编码常量
 *
 * 每个题材带 id（持久化用）、label（显示名）、category（男频/女频/通用）、description（题材说明）、emotionMap（核心情绪映射，供引擎 prompt 注入用）
 */
export type GenreCategory = 'male' | 'female' | 'common';

export interface Genre {
  id: string;            // 持久化 ID（slug 风格，如 'urban-fantasy'）
  label: string;         // 显示名（如"都市玄幻"）
  category: GenreCategory;
  description?: string;  // 题材说明 / 写作要点
  emotionMap?: string;   // 核心情绪映射（供 LLM prompt 参考，如"爽感/逆袭/装逼打脸"）
  isBuiltin?: boolean;   // true=内置不可删除，false=用户自定义
}

export interface GenreGroup {
  category: GenreCategory;
  label: string;         // 分组显示名（如"男频 · 玄幻奇幻"）
  items: Genre[];
}

const CATEGORY_LABEL: Record<GenreCategory, string> = {
  male: '男频',
  female: '女频',
  common: '通用',
};

// ============ 内置题材库（seed 数据） ============
// 整合 Generate.tsx 13 组 104 项 + Market.tsx 32 项，去重统一
// id 用 slug 风格保证跨端稳定（前后端都用同一个 id 写库）
export const BUILTIN_GENRES: Genre[] = [
  // —— 男频 · 玄幻奇幻 ——
  { id: 'urban-fantasy', label: '都市玄幻', category: 'male', description: '现代都市背景下的玄幻冒险', emotionMap: '装逼打脸/扮猪吃虎/逆转', isBuiltin: true },
  { id: 'xianxia', label: '修真仙侠', category: 'male', description: '修仙体系，从凡人到仙人的进阶', emotionMap: '突破/逆天改命/超脱', isBuiltin: true },
  { id: 'honghuang', label: '洪荒封神', category: 'male', description: '洪荒时期或封神演义背景', emotionMap: '远古气运/收徒立教', isBuiltin: true },
  { id: 'zhutian', label: '诸天万界', category: 'male', description: '穿越多个影视/小说世界', emotionMap: '收集气运/万界称尊', isBuiltin: true },
  { id: 'western-fantasy', label: '西方奇幻', category: 'male', description: '中世纪/魔法/骑士体系', emotionMap: '冒险/荣耀/史诗', isBuiltin: true },
  { id: 'different-continent', label: '异界大陆', category: 'male', description: '架空异世界，常见穿越重生', emotionMap: '种田/争霸/收服', isBuiltin: true },
  { id: 'magic-academy', label: '魔法学院', category: 'male', description: '学院流，少年成长', emotionMap: '校园日常/友情/逆袭', isBuiltin: true },
  { id: 'dnd', label: '龙与地下城', category: 'male', description: 'D&D 体系跑团风', emotionMap: '小队冒险/掷骰命运', isBuiltin: true },

  // —— 男频 · 都市职场 ——
  { id: 'urban-rebirth', label: '都市重生', category: 'male', description: '重生回到过去，利用先知逆袭', emotionMap: '先知/弥补遗憾/财富', isBuiltin: true },
  { id: 'urban-xiuxian', label: '都市修真', category: 'male', description: '都市背景下的修真者', emotionMap: '隐藏实力/扮猪吃虎', isBuiltin: true },
  { id: 'campus-urban', label: '校园都市', category: 'male', description: '校园日常 + 都市背景', emotionMap: '青春/初恋/学霸', isBuiltin: true },
  { id: 'business', label: '职场商战', category: 'male', description: '商战权谋，集团斗争', emotionMap: '智斗/翻盘/商战', isBuiltin: true },
  { id: 'medical', label: '医道圣手', category: 'male', description: '医生主角，金手指医术', emotionMap: '妙手回春/打脸庸医', isBuiltin: true },
  { id: 'soldier-king', label: '都市兵王', category: 'male', description: '退役特种兵回归都市', emotionMap: '装逼打脸/护美', isBuiltin: true },
  { id: 'bodyguard', label: '保镖特工', category: 'male', description: '保镖/特工保护雇主', emotionMap: '守护/反差萌', isBuiltin: true },
  { id: 'treasure', label: '鉴宝收藏', category: 'male', description: '古玩/鉴宝/捡漏', emotionMap: '捡漏/打眼/逆袭', isBuiltin: true },

  // —— 男频 · 科幻末世 ——
  { id: 'star-sci-fi', label: '星际科幻', category: 'male', description: '宇宙星际时代', emotionMap: '舰队战/探索/宏大', isBuiltin: true },
  { id: 'mecha', label: '机甲战争', category: 'male', description: '机甲战斗，热血向', emotionMap: '燃/驾驶机甲/逆袭', isBuiltin: true },
  { id: 'doomsday-wasteland', label: '末日废土', category: 'male', description: '核战/灾后废土求生', emotionMap: '求生/收物资/建立势力', isBuiltin: true },
  { id: 'zombie', label: '丧尸围城', category: 'male', description: '丧尸末日', emotionMap: '求生/救世/异能觉醒', isBuiltin: true },
  { id: 'cyberpunk', label: '赛博朋克', category: 'male', description: '高科技低生活', emotionMap: '反叛/黑科技/霓虹', isBuiltin: true },
  { id: 'time-travel', label: '时空穿梭', category: 'male', description: '时空跳跃/穿越时间', emotionMap: '改变历史/悖论', isBuiltin: true },
  { id: 'cosmos-war', label: '宇宙战争', category: 'male', description: '星系级战争', emotionMap: '宏大战争/舰队对决', isBuiltin: true },
  { id: 'hard-sci-fi', label: '硬科幻', category: 'male', description: '注重科学逻辑的科幻', emotionMap: '思辨/未来感/严谨', isBuiltin: true },

  // —— 男频 · 系统重生 ——
  { id: 'system-flow', label: '系统流', category: 'male', description: '绑定系统金手指', emotionMap: '签到/任务/奖励', isBuiltin: true },
  { id: 'invincible-flow', label: '无敌流', category: 'male', description: '主角开局即无敌', emotionMap: '装逼/碾压/横扫', isBuiltin: true },
  { id: 'check-in-flow', label: '签到流', category: 'male', description: '签到打卡获取奖励', emotionMap: '签到/日积月累/扮猪吃虎', isBuiltin: true },
  { id: 'red-envelope', label: '签到红包', category: 'male', description: '签到领红包', emotionMap: '奖励/抢红包', isBuiltin: true },
  { id: 'rebirth-past', label: '重生回到过去', category: 'male', description: '重生到学生时代/青年时期', emotionMap: '先知/弥补遗憾/逆袭', isBuiltin: true },
  { id: 'infinite-flow', label: '无限流', category: 'male', description: '穿越多个副本世界', emotionMap: '生存/解谜/变强', isBuiltin: true },
  { id: 'quick-wear-male', label: '快穿男频', category: 'male', description: '快穿多个小世界', emotionMap: '攻略/反转', isBuiltin: true },
  { id: 'game-online', label: '游戏网游', category: 'male', description: '网游/电竞背景', emotionMap: '升级/装备/PK', isBuiltin: true },

  // —— 男频 · 历史军事 ——
  { id: 'history-crossing', label: '历史穿越', category: 'male', description: '穿越到古代历史时期', emotionMap: '先知/改写历史/种田', isBuiltin: true },
  { id: 'alternate-history', label: '架空历史', category: 'male', description: '架空朝代背景', emotionMap: '争霸/权谋', isBuiltin: true },
  { id: 'three-kingdoms', label: '三国争霸', category: 'male', description: '三国时代争霸', emotionMap: '群雄/谋略/称霸', isBuiltin: true },
  { id: 'anti-jp', label: '抗战烽火', category: 'male', description: '抗战题材', emotionMap: '热血/民族/牺牲', isBuiltin: true },
  { id: 'modern-military', label: '现代军旅', category: 'male', description: '现代军队生活', emotionMap: '军旅热血/战友情', isBuiltin: true },
  { id: 'military-spy', label: '军事谍战', category: 'male', description: '谍战斗智斗勇', emotionMap: '智斗/潜伏/反杀', isBuiltin: true },
  { id: 'strategy-court', label: '权谋朝堂', category: 'male', description: '朝堂权谋斗争', emotionMap: '智斗/翻盘/政治', isBuiltin: true },
  { id: 'chaos-hegemony', label: '乱世争霸', category: 'male', description: '乱世群雄争霸', emotionMap: '争霸/收服/称王', isBuiltin: true },

  // —— 男频 · 悬疑灵异 ——
  { id: 'weird-xiuxian', label: '诡异修仙', category: 'male', description: '诡异元素 + 修真', emotionMap: '诡异/灵异/惊悚', isBuiltin: true },
  { id: 'folk-ghost', label: '民俗诡谈', category: 'male', description: '民间民俗/鬼怪故事', emotionMap: '诡异/民俗/惊悚', isBuiltin: true },
  { id: 'tomb-raiding', label: '盗墓探险', category: 'male', description: '盗墓/探险', emotionMap: '探险/机关/古墓', isBuiltin: true },
  { id: 'mystery', label: '悬疑推理', category: 'male', description: '悬疑破案推理', emotionMap: '解谜/反转/智斗', isBuiltin: true },
  { id: 'ghost', label: '灵异鬼怪', category: 'male', description: '灵异/鬼怪', emotionMap: '惊悚/灵异/玄幻', isBuiltin: true },
  { id: 'cthulhu', label: '克苏鲁', category: 'male', description: '克苏鲁神话体系', emotionMap: '不可名状/疯狂/远古', isBuiltin: true },
  { id: 'urban-weird', label: '都市怪谈', category: 'male', description: '都市背景的怪谈', emotionMap: '都市诡异/灵异', isBuiltin: true },
  { id: 'mystery-recovery', label: '神秘复苏', category: 'male', description: '诡异复苏/规则怪谈', emotionMap: '规则/诡异/求生', isBuiltin: true },

  // —— 女频 · 古言宫斗 ——
  { id: 'palace-fight', label: '宫斗宅斗', category: 'female', description: '宅斗宫斗权谋', emotionMap: '宫斗/智斗/逆袭', isBuiltin: true },
  { id: 'ancient-romance', label: '古代言情', category: 'female', description: '古代背景言情', emotionMap: '情长/虐恋/团圆', isBuiltin: true },
  { id: 'palace-harem', label: '宫闱宅斗', category: 'female', description: '宫闱宅斗', emotionMap: '宫斗/反杀', isBuiltin: true },
  { id: 'diary-daughter', label: '嫡女重生', category: 'female', description: '嫡女重生改命', emotionMap: '改命/虐渣/打脸', isBuiltin: true },
  { id: 'general-daughter', label: '将军嫡女', category: 'female', description: '将军府嫡女', emotionMap: '爽文/智斗/守护', isBuiltin: true },
  { id: 'wangye-wangfei', label: '王爷王妃', category: 'female', description: '王爷王妃', emotionMap: '甜宠/护妻/打脸', isBuiltin: true },
  { id: 'palace-strategy', label: '宫斗权谋', category: 'female', description: '宫斗权谋斗争', emotionMap: '权谋/智斗/称后', isBuiltin: true },
  { id: 'ancient-farming', label: '古风种田', category: 'female', description: '古代种田/经营', emotionMap: '种田/日常/甜宠', isBuiltin: true },

  // —— 女频 · 现言都市 ——
  { id: 'modern-romance', label: '现代言情', category: 'female', description: '现代都市言情', emotionMap: '甜/虐/团圆', isBuiltin: true },
  { id: 'billionaire-ceo', label: '豪门总裁', category: 'female', description: '豪门总裁甜宠', emotionMap: '甜宠/霸总/打脸', isBuiltin: true },
  { id: 'entertainment', label: '娱乐圈', category: 'female', description: '娱乐圈背景', emotionMap: '逆袭/打脸/CP', isBuiltin: true },
  { id: 'urban-sweet', label: '都市甜宠', category: 'female', description: '都市甜宠日常', emotionMap: '甜宠/撒糖', isBuiltin: true },
  { id: 'reconciliation', label: '破镜重圆', category: 'female', description: '前任重逢', emotionMap: '虐/破镜重圆', isBuiltin: true },
  { id: 'secret-love', label: '暗恋成真', category: 'female', description: '暗恋双向奔赴', emotionMap: '暗恋/双向奔赴', isBuiltin: true },
  { id: 'contract-marriage', label: '契约婚姻', category: 'female', description: '契约结婚到真爱', emotionMap: '先婚后爱/打脸', isBuiltin: true },
  { id: 'workplace-love', label: '职场恋爱', category: 'female', description: '职场恋情', emotionMap: '职场/暧昧/在一起', isBuiltin: true },

  // —— 女频 · 玄幻言情 ——
  { id: 'xuanhuan-romance', label: '玄幻言情', category: 'female', description: '玄幻背景言情', emotionMap: '修炼/CP/虐恋', isBuiltin: true },
  { id: 'xianxia-romance', label: '仙侠奇缘', category: 'female', description: '仙侠言情', emotionMap: '修仙/虐恋/飞升', isBuiltin: true },
  { id: 'interstellar-future', label: '星际未来', category: 'female', description: '星际/未来背景言情', emotionMap: '星际/异能/CP', isBuiltin: true },
  { id: 'quick-wear-female', label: '快穿女频', category: 'female', description: '快穿多世界攻略', emotionMap: '攻略/反转', isBuiltin: true },
  { id: 'system-sweet', label: '系统甜文', category: 'female', description: '系统甜宠', emotionMap: '系统/甜宠/打脸', isBuiltin: true },
  { id: 'transmigration-female-strong', label: '穿越女强', category: 'female', description: '穿越后变强', emotionMap: '逆袭/打脸/爽文', isBuiltin: true },
  { id: 'rebirth-female-strong', label: '重生女强', category: 'female', description: '重生后变强', emotionMap: '改命/打脸/爽文', isBuiltin: true },
  { id: 'awakening-power', label: '异能觉醒', category: 'female', description: '异能觉醒', emotionMap: '异能/逆袭/守护', isBuiltin: true },

  // —— 女频 · 青春校园 ——
  { id: 'youth-campus', label: '青春校园', category: 'female', description: '校园青春', emotionMap: '青春/初恋/成长', isBuiltin: true },
  { id: 'childhood-sweetheart', label: '青梅竹马', category: 'female', description: '青梅竹马', emotionMap: '陪伴/成长/在一起', isBuiltin: true },
  { id: 'campus-crush', label: '校园暗恋', category: 'female', description: '校园暗恋', emotionMap: '暗恋/双向奔赴', isBuiltin: true },
  { id: 'study-love', label: '学霸恋爱', category: 'female', description: '学霸CP', emotionMap: '成长/CP', isBuiltin: true },
  { id: 'esports-sweet', label: '电竞甜文', category: 'female', description: '电竞 + 甜宠', emotionMap: '电竞/甜宠', isBuiltin: true },
  { id: 'two-way', label: '双向奔赴', category: 'female', description: '双向奔赴', emotionMap: '双向/奔赴', isBuiltin: true },
  { id: 'crush-diary', label: '暗恋日记', category: 'female', description: '暗恋日记', emotionMap: '日记/暗恋', isBuiltin: true },
  { id: 'graduation', label: '毕业季', category: 'female', description: '毕业季', emotionMap: '离别/重逢/成长', isBuiltin: true },

  // —— 通用 · 悬疑推理 ——
  { id: 'classic-mystery', label: '本格推理', category: 'common', description: '本格推理派', emotionMap: '逻辑/解谜/公平', isBuiltin: true },
  { id: 'social-mystery', label: '社会派推理', category: 'common', description: '社会派推理', emotionMap: '社会/人性/案件', isBuiltin: true },
  { id: 'suspense-thriller', label: '悬疑惊悚', category: 'common', description: '悬疑惊悚', emotionMap: '惊悚/反转', isBuiltin: true },
  { id: 'psychological-crime', label: '心理犯罪', category: 'common', description: '心理犯罪小说', emotionMap: '心理/犯罪/反转', isBuiltin: true },
  { id: 'forensic', label: '法医探案', category: 'common', description: '法医题材', emotionMap: '法医/案件/真相', isBuiltin: true },
  { id: 'locked-room', label: '密室杀人', category: 'common', description: '密室推理', emotionMap: '密室/解谜', isBuiltin: true },
  { id: 'serial-case', label: '连环案件', category: 'common', description: '连环案件', emotionMap: '连环/追凶', isBuiltin: true },
  { id: 'hardboiled', label: '冷硬派', category: 'common', description: '冷硬派推理', emotionMap: '冷硬/真相', isBuiltin: true },

  // —— 通用 · 奇幻冒险 ——
  { id: 'epic-fantasy', label: '史诗奇幻', category: 'common', description: '史诗奇幻', emotionMap: '宏大/史诗/冒险', isBuiltin: true },
  { id: 'adventure-explore', label: '冒险探索', category: 'common', description: '冒险探索', emotionMap: '冒险/宝藏', isBuiltin: true },
  { id: 'sword-magic', label: '剑与魔法', category: 'common', description: '剑与魔法', emotionMap: '剑/魔法/冒险', isBuiltin: true },
  { id: 'myth-adaptation', label: '神话改编', category: 'common', description: '神话改编', emotionMap: '神话/改编', isBuiltin: true },
  { id: 'hero-demon', label: '勇者斗恶龙', category: 'common', description: '勇者斗恶龙', emotionMap: '勇者/打怪', isBuiltin: true },
  { id: 'isekai-reincarnation', label: '异世界转生', category: 'common', description: '异世界转生', emotionMap: '转生/开挂', isBuiltin: true },
  { id: 'dungeon-adventure', label: '地下城冒险', category: 'common', description: '地下城冒险', emotionMap: '冒险/宝藏', isBuiltin: true },
  { id: 'kingdom-revival', label: '王国复兴', category: 'common', description: '王国复兴', emotionMap: '复兴/王国', isBuiltin: true },

  // —— 通用 · 历史权谋 ——
  { id: 'history-strategy', label: '历史权谋', category: 'common', description: '历史权谋', emotionMap: '权谋/智斗', isBuiltin: true },
  { id: 'court-struggle', label: '朝堂争斗', category: 'common', description: '朝堂争斗', emotionMap: '朝堂/政治', isBuiltin: true },
  { id: 'minister-path', label: '权臣之路', category: 'common', description: '权臣崛起', emotionMap: '权臣/逆袭', isBuiltin: true },
  { id: 'chaos-heroes', label: '乱世群雄', category: 'common', description: '乱世群雄', emotionMap: '乱世/争霸', isBuiltin: true },
  { id: 'harem-storm', label: '后宫风云', category: 'common', description: '后宫权谋', emotionMap: '后宫/权谋', isBuiltin: true },
  { id: 'empire-rise', label: '帝国崛起', category: 'common', description: '帝国崛起', emotionMap: '崛起/征服', isBuiltin: true },
  { id: 'spring-autumn', label: '春秋战国', category: 'common', description: '春秋战国', emotionMap: '春秋/争霸', isBuiltin: true },
  { id: 'tang-prosperity', label: '大唐盛世', category: 'common', description: '大唐盛世', emotionMap: '盛世/风云', isBuiltin: true },

  // —— 通用 · 情感生活 ——
  { id: 'urban-emotion', label: '都市情感', category: 'common', description: '都市情感生活', emotionMap: '情感/生活', isBuiltin: true },
  { id: 'family-saga', label: '家族史诗', category: 'common', description: '家族变迁', emotionMap: '家族/史诗', isBuiltin: true },
  { id: 'life-relief', label: '人生治愈', category: 'common', description: '治愈系生活', emotionMap: '治愈/温暖', isBuiltin: true },
];

// 把扁平题材列表按 category 分组（用于前端 select optgroup）
export function groupGenres(genres: Genre[]): GenreGroup[] {
  const groups: Record<GenreCategory, Genre[]> = { male: [], female: [], common: [] };
  for (const g of genres) {
    (groups[g.category] || groups.common).push(g);
  }
  return (['male', 'female', 'common'] as GenreCategory[]).map(cat => ({
    category: cat,
    label: CATEGORY_LABEL[cat],
    items: groups[cat],
  }));
}

// 按 id 快速查找
export function findGenreById(genres: Genre[], id: string): Genre | undefined {
  return genres.find(g => g.id === id);
}

// 按 label 模糊查找（用户自定义输入时回查）
export function findGenreByLabel(genres: Genre[], label: string): Genre | undefined {
  const lower = label.trim().toLowerCase();
  return genres.find(g => g.label.toLowerCase() === lower);
}

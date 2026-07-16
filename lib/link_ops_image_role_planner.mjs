import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp)$/i;
const BACKUP_SEGMENT_RE = /备用|备选|废|backup|bak/i;
const AB_TEST_COVER_RE = /产品封面|AB测试|A\s*B\s*测试|ab[-_\s]*test/i;
const APPROVED_SOURCE_RE = /已审可用|审核通过|approved|reviewed/i;
const DEFAULT_STORE_STYLE_PROFILES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'store_style_profiles.json',
);

function safeString(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeSlash(file) {
  return String(file || '').replace(/\\/g, '/');
}

function leadingNumber(name) {
  const m = String(name || '').match(/^\s*(\d{1,3})(?:[-_\s]|$)/);
  return m ? Number(m[1]) : 9999;
}

function includesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function isBackupPath(filePath) {
  return normalizeSlash(filePath).split('/').some(segment => BACKUP_SEGMENT_RE.test(segment));
}

async function walkImageFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (BACKUP_SEGMENT_RE.test(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && IMAGE_EXT_RE.test(entry.name)) {
        if (!isBackupPath(path.relative(rootDir, full))) out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', {numeric: true, sensitivity: 'base'}));
}

async function readImageDimensions(file) {
  const buf = await fs.readFile(file);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 1, 4) === 'PNG') {
    return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png'};
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const vp8x = buf.indexOf(Buffer.from('VP8X'));
    if (vp8x >= 0 && buf.length >= vp8x + 18) {
      return {
        width: 1 + buf.readUIntLE(vp8x + 12, 3),
        height: 1 + buf.readUIntLE(vp8x + 15, 3),
        format: 'webp',
      };
    }
    const vp8l = buf.indexOf(Buffer.from('VP8L'));
    if (vp8l >= 0 && buf.length >= vp8l + 10) {
      const b0 = buf[vp8l + 5];
      const b1 = buf[vp8l + 6];
      const b2 = buf[vp8l + 7];
      const b3 = buf[vp8l + 8];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        format: 'webp',
      };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), format: 'jpg'};
      }
      offset += 2 + length;
    }
  }
  return {width: 0, height: 0, format: path.extname(file).replace(/^\./, '').toLowerCase() || 'unknown'};
}

function classifyImage(name, dimensions = {}) {
  const text = String(name || '').toLowerCase();
  const cn = String(name || '');
  const ratio = dimensions.width && dimensions.height ? dimensions.width / dimensions.height : 0;
  const isSquare = /方形|square/i.test(cn) || /(?:^|[-_\s（(])1\s*[:：]\s*1(?:$|[-_\s）)])/i.test(cn) || (ratio >= 0.95 && ratio <= 1.05);
  // Reviewed creative sets commonly name the no-person alternate cover as
  // "02-纯产品质感封面" or "02-产品单镜封面" rather than the
  // contiguous phrase "产品封面".
  // It is still the excluded alternate/AB cover and must not leak into the
  // carousel or be used to pad the image count.
  const isAbTestCover = AB_TEST_COVER_RE.test(cn)
    || (leadingNumber(cn) === 2 && /(?:纯产品|无人物|产品单镜|单镜产品).*封面/i.test(cn));
  const isMainCover = !isAbTestCover && /主封面|主图|旗舰封面|纯产品.*封面|main\s*cover|main[-_\s]*image/i.test(cn);
  const isCarousel = /轮播|第二封面|二封|核心优势|hero|carousel/i.test(cn);
  const isParameter = includesAny(cn, [/参数/, /规格/, /尺寸/, /电压/, /功率/, /容量/, /材质/, /清单/, /spec/i]);
  const isSellingPoint = includesAny(cn, [/卖点/, /优势/, /效率/, /对比/, /\b2000\s*w\b/i, /\d+档/, /控温/, /兼容/, /不挑锅/, /指示灯/, /收纳/, /便携/, /防滑/, /特写/, /加热/, /双灶/, /线圈/]);
  const isScene = !isParameter && includesAny(cn, [/场景/, /家庭/, /厨房/, /露台/, /别墅/, /烹饪/, /温馨/, /生活/, /使用/, /奢华/, /沙特/]);
  const isCloseup = includesAny(cn, [/特写/, /底脚/, /防滑/, /线圈/, /细节/, /detail/i]);
  const isExplicitSellingPoint = /卖点|优势|效率|痛点.*对比|对比图/i.test(cn);
  const orientation = isSquare ? 'square' : (ratio && ratio < 0.9 ? 'portrait' : (ratio > 1.1 ? 'landscape' : 'unknown'));
  let category = 'other';
  if (isSellingPoint && isExplicitSellingPoint) category = 'selling_point';
  else if (isParameter) category = 'parameter';
  else if (isSellingPoint) category = 'selling_point';
  else if (isScene) category = 'scene';
  return {isAbTestCover, isMainCover, isCarousel, isSquare, isParameter, isSellingPoint, isScene, isCloseup, category, orientation, ratio};
}

function byPreferredCover(a, b) {
  const aMain = a.classification.isMainCover ? 1 : 0;
  const bMain = b.classification.isMainCover ? 1 : 0;
  if (aMain !== bMain) return bMain - aMain;
  const aPortrait = a.classification.orientation === 'portrait' ? 1 : 0;
  const bPortrait = b.classification.orientation === 'portrait' ? 1 : 0;
  if (aPortrait !== bPortrait) return bPortrait - aPortrait;
  return a.sequence - b.sequence;
}

function carouselScore(item) {
  let score = 0;
  if (item.classification.isCarousel) score += 100;
  if (item.classification.category === 'scene') score += 25;
  if (item.classification.category === 'selling_point') score += 20;
  if (/核心|优势|hero|轮播|第二封面/i.test(item.name)) score += 30;
  if (item.classification.orientation === 'portrait') score += 10;
  if (item.size) score += Math.min(10, Math.log10(item.size));
  score -= Math.max(0, item.sequence - 1) * 0.01;
  return score;
}

function sellingPriority(item) {
  const text = item.name;
  if (/特写|防滑|底脚|线圈/.test(text)) return 90;
  if (/效率|对比|加倍|2000\s*W|2000W|双灶|发热(?!线圈)/.test(text)) return 10;
  if (/控温|档|旋钮/.test(text)) return 20;
  if (/兼容|不挑锅/.test(text)) return 30;
  if (/指示灯/.test(text)) return 40;
  if (/收纳|便携/.test(text)) return 50;
  return 60;
}

function skuOverflowScore(item) {
  let score = 100;
  if (item.classification.isCloseup) score -= 45;
  if (/防滑|底脚|线圈|特写/.test(item.name)) score -= 30;
  if (item.classification.category === 'selling_point') score -= 10;
  if (item.classification.category === 'parameter') score += 25;
  if (item.classification.category === 'scene') score += 20;
  if (item.classification.orientation === 'portrait') score -= 5;
  score += item.sequence * 0.01;
  return score;
}

function orderDetailCandidates(items) {
  const scenes = items.filter(item => item.classification.category === 'scene')
    .sort((a, b) => a.sequence - b.sequence);
  const selling = items.filter(item => item.classification.category === 'selling_point')
    .sort((a, b) => sellingPriority(a) - sellingPriority(b) || a.sequence - b.sequence);
  const params = items.filter(item => item.classification.category === 'parameter')
    .sort((a, b) => a.sequence - b.sequence);
  const others = items.filter(item => item.classification.category === 'other')
    .sort((a, b) => a.sequence - b.sequence);
  // User rule: 卖点 -> 参数 -> 场景; if 3+ scenes, use one as closing.
  const closingScenes = scenes.length >= 3 ? scenes.slice(-1) : [];
  const leadScenes = scenes.length >= 3 ? scenes.slice(0, -1) : scenes;
  return [...selling, ...params, ...leadScenes, ...others, ...closingScenes];
}

function openApiMappingForRole(role) {
  const mappings = {
    mainCover: {targetLevel: ['skc'], imageType: 1, note: '前端细节图第 1 张/主图；通常映射到 SKC 主图，是否也写 SPU 层必须以官方图片方案为准。'},
    carouselSecondCover: {targetLevel: ['spu'], imageType: 1, note: '前端单独轮播/第二封面不是主图；FY 新方案映射到 SPU 顶层 image_info，其他类目提交前必须按官方标准确认。'},
    detail: {targetLevel: ['skc'], imageType: 2, note: 'SKC 细节图，最多保留主封面后 10 张其他图。'},
    squareImage: {targetLevel: ['skc'], imageType: 5, note: 'SKC 方形图。'},
    skuImage: {targetLevel: ['sku'], imageType: 1, note: 'SKU 图只能用高清主图 type=1，禁止使用 80x80/sku-80 裁切图。'},
    ignored: {targetLevel: [], imageType: null, note: '不提交。'},
    unused: {targetLevel: [], imageType: null, note: '未分配，提交前人工确认。'},
  };
  return mappings[role] || {targetLevel: [], imageType: null, note: ''};
}

function roleItem(item, reason = '', role = '') {
  if (!item) return null;
  return {
    name: item.name,
    path: item.path,
    relativePath: item.relativePath,
    width: item.width,
    height: item.height,
    ratio: item.classification.ratio ? Number(item.classification.ratio.toFixed(4)) : 0,
    category: item.classification.category,
    orientation: item.classification.orientation,
    reason,
    openApiMapping: openApiMappingForRole(role),
  };
}

async function readStoreStyleEvidence(storeKey, configFile = DEFAULT_STORE_STYLE_PROFILES) {
  const normalizedStore = safeString(storeKey, 40).toUpperCase();
  if (!normalizedStore) return null;
  try {
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    const preferredStyles = Array.isArray(config?.profiles?.[normalizedStore])
      ? config.profiles[normalizedStore].map(value => safeString(value, 80)).filter(Boolean)
      : [];
    const configuredTitleGroup = safeString(config?.defaultTitleGroups?.[normalizedStore], 40);
    const defaultTitleGroup = /^title[123]$/.test(configuredTitleGroup) ? configuredTitleGroup : null;
    return {
      storeKey: normalizedStore,
      configured: preferredStyles.length > 0,
      preferredStyles,
      defaultTitleGroup,
      titleGroupSource: defaultTitleGroup ? 'config/store_style_profiles.json' : null,
      advisoryOnly: true,
      automaticApproval: false,
      automaticFullGoodsNumber: false,
      note: preferredStyles.length
        ? '店铺风格仅作为套图选择提示；是否匹配以及是否使用（全）货号仍由负责人/人工审核决定。'
        : '未配置该店铺的风格提示；不得据此自动判定套图不合格或自动添加（全）货号。',
    };
  } catch (error) {
    return {
      storeKey: normalizedStore,
      configured: false,
      preferredStyles: [],
      defaultTitleGroup: null,
      titleGroupSource: null,
      advisoryOnly: true,
      automaticApproval: false,
      automaticFullGoodsNumber: false,
      warning: `店铺风格配置不可读：${safeString(error?.message || error, 240)}`,
    };
  }
}

export async function planLinkOpsImageRoles({dir, cwd = process.cwd(), sourceApproved = null, storeKey = '', storeStyleConfigFile} = {}) {
  if (!dir) throw new Error('image role planning requires dir');
  const rootDir = path.resolve(cwd, dir);
  const approvedSource = sourceApproved === null || sourceApproved === undefined
    ? APPROVED_SOURCE_RE.test(rootDir)
    : sourceApproved === true;
  const stat = await fs.stat(rootDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`image directory not found: ${rootDir}`);
  const files = await walkImageFiles(rootDir);
  const all = [];
  for (const file of files) {
    const dimensions = await readImageDimensions(file).catch(() => ({width: 0, height: 0, format: 'unknown'}));
    const name = path.basename(file);
    const classification = classifyImage(name, dimensions);
    const st = await fs.stat(file).catch(() => ({size: 0}));
    all.push({
      name,
      path: file,
      relativePath: normalizeSlash(path.relative(rootDir, file)),
      sequence: leadingNumber(name),
      size: st.size || 0,
      width: dimensions.width || 0,
      height: dimensions.height || 0,
      format: dimensions.format || '',
      classification,
    });
  }

  const warnings = [];
  const blockers = [];
  // A reviewed source is an explicit business approval. Filename heuristics may
  // still be surfaced as advisory evidence, but they must not silently remove
  // reviewed material from the assignable pool.
  const ignoredAbTestCovers = approvedSource ? [] : all.filter(item => item.classification.isAbTestCover);
  const eligible = approvedSource ? all : all.filter(item => !item.classification.isAbTestCover);
  const reviewedAlternateCoverCandidates = approvedSource
    ? all.filter(item => item.classification.isAbTestCover)
    : [];
  if (reviewedAlternateCoverCandidates.length) {
    warnings.push(`已审素材中有 ${reviewedAlternateCoverCandidates.length} 张命中文件名封面启发式；已保留为可分配图片，仅提示人工确认角色。`);
  }
  if (!eligible.length) blockers.push('未找到可用图片；已排除备用目录和“产品封面/AB测试”图片。');

  const squareCandidates = eligible.filter(item => item.classification.isSquare).sort((a, b) => a.sequence - b.sequence);
  const squareImage = squareCandidates[0] || null;
  if (!squareImage) warnings.push('未识别到 1:1/方形图；方形图位需要人工指定或后续补图。');

  const mainCandidates = eligible.filter(item => item !== squareImage).sort(byPreferredCover);
  const mainCover = mainCandidates[0] || null;
  if (!mainCover) blockers.push('未识别到主封面；细节图第一张/主图无法自动规划。');

  const used = new Set([mainCover, squareImage].filter(Boolean));
  const carouselCandidates = eligible.filter(item => !used.has(item))
    .sort((a, b) => carouselScore(b) - carouselScore(a) || a.sequence - b.sequence);
  const carouselSecondCover = carouselCandidates[0] || null;
  if (carouselSecondCover) used.add(carouselSecondCover);
  else warnings.push('未识别到可做单独轮播/第二封面的图片；该位需要人工确认。');

  const detailPoolOriginal = eligible.filter(item => !used.has(item));
  let skuImage = null;
  let detailPool = [...detailPoolOriginal];
  if (detailPool.length > 10) {
    const overflowSorted = [...detailPool].sort((a, b) => skuOverflowScore(a) - skuOverflowScore(b) || b.sequence - a.sequence);
    skuImage = overflowSorted[0] || null;
    if (skuImage) detailPool = detailPool.filter(item => item !== skuImage);
  }
  const orderedOtherDetails = orderDetailCandidates(detailPool).slice(0, 10);
  const unused = detailPool.filter(item => !orderedOtherDetails.includes(item));
  if (unused.length) warnings.push(`可用细节候选超过容量，已有 ${unused.length} 张未分配；请人工确认是否替换低优先级图片。`);
  if (!skuImage && detailPoolOriginal.length <= 10) {
    warnings.push('除主封面、方形图、单独轮播图外，其他图不超过 10 张；按当前规则不提交 SKU 图。');
  }

  const frontendDetailImages = [mainCover, ...orderedOtherDetails].filter(Boolean);
  if (frontendDetailImages.length > 11) warnings.push('前端细节图超过 11 张，已按容量截断；请人工复核。');

  const storeStyle = await readStoreStyleEvidence(storeKey, storeStyleConfigFile || DEFAULT_STORE_STYLE_PROFILES);
  if (storeStyle?.warning) warnings.push(storeStyle.warning);

  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    planner: 'link_ops_image_role_planner_v1',
    sourceDir: rootDir,
    approval: {
      sourceApproved: approvedSource,
      authority: approvedSource ? 'human_reviewed_source' : 'ai_advisory_only',
      semanticClaimsMayWarnButNotExclude: approvedSource,
      note: approvedSource
        ? '该目录已标记为人工审核可用；规划器只按客观格式、角色和容量处理，不因标题/卖点文档未采用某参数而擅自剔图。'
        : '该目录未标记为人工审核可用；规划结果仅供建议，提交前仍需人工确认素材来源。',
    },
    storeStyle,
    rules: {
      ignoredByPath: '路径任一层包含“备用/备选/废/backup/bak”的图片不使用。',
      ignoredByName: approvedSource
        ? '已审可用目录不因文件名封面启发式被排除；命中项只提示人工确认角色。'
        : '未审核目录中，文件名明确包含“产品封面/AB测试”，或编号 02 且为“纯产品/无人物/产品单镜…封面”的图片，按不带人物的第二封面处理并排除。',
      approvedSourceAuthority: '用户当轮明确指令和“已审可用”素材高于 AI 语义推断；标题未采用某参数不等于图片禁用。',
      mainCover: '前端“细节图11”的第一张才是主图，优先使用主封面。',
      carouselSecondCover: '单独轮播图不是主图，使用主封面之外最适合作第二封面的图片。',
      detailOrder: '其他细节图按卖点→参数→场景排序；场景较多时最后一张用场景图收尾。',
      squareImage: '方形图使用 1:1 或文件名含方形/1:1 的图片。',
      skuImage: '除主封面、方形图、单独轮播图外，若其他图超过 10 张，最低优先级高清图才进入 SKU 图。',
      apiBoundary: '本规划只输出前端角色，不直接生成 OpenAPI partialEdit；提交前仍必须查询官方图片方案并由执行器做 payload 自检。',
    },
    counts: {
      scannedImages: all.length,
      ignoredAbTestCovers: ignoredAbTestCovers.length,
      eligibleImages: eligible.length,
      frontendDetailImages: frontendDetailImages.length,
      otherDetailImages: orderedOtherDetails.length,
      skuImages: skuImage ? 1 : 0,
      unusedImages: unused.length,
    },
    roles: {
      mainCover: roleItem(mainCover, '细节图第 1 张 / 主图', 'mainCover'),
      carouselSecondCover: roleItem(carouselSecondCover, '单独轮播图 / 第二封面', 'carouselSecondCover'),
      squareImage: roleItem(squareImage, '方形图 / 1:1', 'squareImage'),
      frontendDetailImages: frontendDetailImages.map((item, index) => roleItem(item, index === 0 ? '细节图第 1 张 / 主图' : `细节图第 ${index + 1} 张`, index === 0 ? 'mainCover' : 'detail')),
      otherDetailImages: orderedOtherDetails.map((item, index) => roleItem(item, `主图之后的细节图第 ${index + 1} 张`, 'detail')),
      skuImage: roleItem(skuImage, '容量外低优先级 SKU 图', 'skuImage'),
      ignoredAbTestCovers: ignoredAbTestCovers.map(item => roleItem(item, '文件名含“产品封面/AB测试”，忽略不提交', 'ignored')),
      reviewedAlternateCoverCandidates: reviewedAlternateCoverCandidates.map(item => roleItem(item, '已审来源：命中文件名封面启发式但保留可分配', 'unused')),
      unused: unused.map(item => roleItem(item, '容量外未分配', 'unused')),
    },
    candidates: all.map(item => {
      const ignored = item.classification.isAbTestCover && !approvedSource;
      return roleItem(item, ignored ? 'ignored_ab_test_cover' : item.classification.category, ignored ? 'ignored' : '');
    }),
    blockers,
    warnings,
  };
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_SLOTS = [
  { index: 1, key: 'cover_3x4', name: '3:4 主封面', ratio: '3:4', goal: '提升点击率，让买家第一眼理解产品核心价值' },
  { index: 2, key: 'cover_1x1', name: '1:1 方形封面', ratio: '1:1', goal: '用于方图、广告位或跨平台复用，缩略图也要清楚' },
  { index: 3, key: 'specs', name: '参数规格图', ratio: '3:4', goal: '解释尺寸、容量、功率、配件、使用注意事项，降低疑虑' },
  { index: 4, key: 'carousel_core', name: '核心轮播图', ratio: '3:4', goal: '用一屏讲清 3 个最核心购买理由' },
  { index: 5, key: 'lifestyle_primary', name: '主使用场景图', ratio: '3:4', goal: '展示最强高频使用场景，建立代入感' },
  { index: 6, key: 'lifestyle_secondary', name: '第二使用场景图', ratio: '3:4', goal: '展示不同场景，证明多场景适用' },
  { index: 7, key: 'selling_point_1', name: '卖点图 1', ratio: '3:4', goal: '证明最强卖点，用局部放大或图中图表达' },
  { index: 8, key: 'selling_point_2', name: '卖点图 2', ratio: '3:4', goal: '证明第二卖点，避免和卖点图 1 重复' },
  { index: 9, key: 'detail_closeup', name: '细节特写图', ratio: '3:4', goal: '展示接口、按钮、材质、刀头、喷头、杯体等可信细节' },
  { index: 10, key: 'steps', name: '使用步骤图', ratio: '3:4', goal: '用 3-4 步说明如何使用，降低上手门槛' },
  { index: 11, key: 'size_scope', name: '尺寸/容量/适用范围图', ratio: '3:4', goal: '用尺寸线、容量或适用范围降低预期偏差' },
  { index: 12, key: 'pain_solution', name: '痛点解决/对比图', ratio: '3:4', goal: '展示问题与解决方式，禁止伪造夸张效果' },
  { index: 13, key: 'included_trust', name: '配件/清单/信任图', ratio: '3:4', goal: '说明到手包含物和使用边界，默认不展示包装盒' }
];

const CATEGORY_SCENES = {
  '便携咖啡机': ['modern office desk', 'car travel scene without claiming cup-holder fit', 'bright camping table', 'RV morning coffee scene'],
  '半自动意式咖啡机': ['bright kitchen countertop', 'premium home cafe corner', 'morning breakfast bar'],
  '胶囊咖啡机': ['small apartment kitchen', 'office pantry', 'clean countertop with capsules only if included'],
  '电动缝纫机': ['DIY craft desk', 'home clothing repair table', 'beginner sewing learning scene'],
  '杆式吸尘器': ['bright living room floor', 'sofa gap cleaning', 'car interior cleaning'],
  '布艺清洗机': ['bright home sofa stain cleaning', 'bedroom rug cleaning', 'mattress spot cleaning'],
  '清洁机': ['bright home sofa stain cleaning', 'bedroom rug cleaning', 'dining chair fabric cleaning'],
  '蒸汽熨烫机': ['wardrobe garment care', 'before work outfit prep', 'travel suitcase clothing care'],
  '绞肉机': ['family kitchen meal prep', 'ingredient preparation close-up', 'easy cleaning countertop'],
  '三明治机和早餐机': ['bright breakfast table', 'family kitchen morning', 'weekend brunch scene'],
  '空气炸锅': ['modern kitchen island', 'healthy snack table', 'weekend family food scene'],
  '颈部按摩器': ['bright office break', 'sofa relaxation', 'car passenger travel scene'],
  '激光脱毛仪': ['bright vanity table', 'clean beauty routine scene', 'compliant skincare setting'],
  '热风梳': ['bright dressing table', 'morning hair styling scene'],
  '卷发钳和卷发棒': ['vanity mirror styling', 'bright bedroom beauty routine'],
  '便携式冰箱': ['car travel', 'camping picnic', 'office drink storage'],
  '电热水壶': ['kitchen tea corner', 'office pantry', 'breakfast table'],
  '制冰机': ['summer kitchen drinks', 'family gathering non-alcoholic beverages', 'clean countertop'],
};

const ENABLE_NON_SHEIN_PLATFORM_ROUTING = false;

const MARKETPLACE_MAIN_IMAGE_RULES = {
  AMAZON: {
    whiteBackground: true,
    noTextOnMain: true,
    noLifestyleOnMain: true,
    note: 'Amazon main image compliance mode: product only, pure white RGB 255,255,255 background, no text/icons/props/lifestyle.'
  },
  NOON: {
    whiteBackground: true,
    noTextOnMain: true,
    noLifestyleOnMain: true,
    note: 'noon main image compliance mode: product only, pure white background, no packaging/seller logo/price/text/lifestyle.'
  }
};

function parseArgs(argv) {
  const args = { input: 'inputs/product-image-suite/sample-product-facts.json', out: 'outputs/product-image-suite/prompts', format: 'both' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/product-image-suite/generate_prompt_suite.mjs --input facts.json --out outputs/product-image-suite/prompts --format both|json|md');
      process.exit(0);
    }
  }
  return args;
}

function safeName(s) {
  return String(s || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
}

function claims(product) {
  return (product.verified_facts || []).map((f) => typeof f === 'string' ? f : f.claim).filter(Boolean);
}

function sources(product) {
  return (product.verified_facts || []).map((f) => typeof f === 'string' ? 'unknown' : `${f.claim} [${f.source || 'unknown'}]`);
}

function categoryScenes(product) {
  return CATEGORY_SCENES[product.category] || CATEGORY_SCENES[extractCategory(product.sku)] || ['bright clean home scene', 'close-up product detail scene', 'mobile-first ecommerce layout'];
}

function platformKey(product, store) {
  if (!ENABLE_NON_SHEIN_PLATFORM_ROUTING && String(product.platform || 'SHEIN').toUpperCase().includes('SHEIN')) return 'SHEIN';
  const raw = `${product.platform || ''} ${store || ''}`.toUpperCase();
  if (raw.includes('AMAZON')) return 'AMAZON';
  if (raw.includes('NOON')) return 'NOON';
  if (raw.includes('TEMU')) return 'TEMU';
  if (raw.includes('SHEIN')) return 'SHEIN';
  return 'SHEIN';
}

function platformRule(product, store) {
  return MARKETPLACE_MAIN_IMAGE_RULES[platformKey(product, store)] || null;
}

function extractCategory(sku) {
  const match = String(sku || '').match(/[\u4e00-\u9fff]+$/);
  return match ? match[0] : '';
}

function textOverlay(slot, productFacts) {
  const shortFacts = productFacts.slice(0, 4);
  if (slot.index === 1) return ['Main benefit headline in English', ...shortFacts.slice(0, 3).map(shorten)];
  if (slot.index === 2) return ['Clear product name', shorten(shortFacts[0] || 'Core benefit')];
  if (slot.index === 3) return ['Dimensions: pending if not verified', 'Power/Capacity: pending if not verified', 'Accessories: only if included'];
  if (slot.index === 4) return shortFacts.slice(0, 3).map(shorten);
  return [shorten(shortFacts[(slot.index - 1) % Math.max(shortFacts.length, 1)] || 'Verified product benefit')];
}

function shorten(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 56);
}

function exteriorLock(product) {
  const policy = product.reference_policy || 'strict_copy_shape_angle';
  const visual = (product.visual_facts || []).join('；');
  if (String(policy).includes('reference_image_only_no_manual_color_or_shape')) {
    return `Use the uploaded user/manufacturer reference images as the only source for product appearance (${policy}). Do not manually describe, reinterpret or change product color, shell shape, buttons, interface positions, windows, visible parts, accessories or proportions in the prompt; keep them strictly identical to the reference images. This hides only the product-appearance description, not the product itself: the product must remain large, clear and visually central. ${visual ? `Known visual facts for review only: ${visual}.` : ''}`;
  }
  return `以用户上传的参考图为唯一产品外观依据（${policy}）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。${visual ? `已知视觉事实：${visual}。` : ''}`;
}

function sceneConstraintText(product) {
  const constraints = product.scene_constraints || [];
  return constraints.length ? constraints.map((x) => String(x).trim()).filter(Boolean).join('; ') : '';
}

function marketText(product) {
  return `${product.market || ''} ${(product.secondary_markets || []).join(' ')} ${product.platform || ''}`.toUpperCase();
}

function isKsaFirst(product) {
  const text = marketText(product);
  return text.includes('KSA') || text.includes('SAUDI') || text.includes('沙特');
}

function marketModestyGuidance(product) {
  if (isKsaFirst(product)) {
    return [
      'KSA-first modesty guidance: keep attractive styling high-fashion and product-led rather than exposure-led.',
      'Prefer elegant modest clothing with controlled neckline, no lingerie, no transparent fabric, no extreme cleavage, no bare midriff, no micro skirt, no very tight bodycon look; use refined long-sleeve or short-sleeve tops, elegant trousers or longer skirt, slightly relaxed drape, premium fabric and polished styling.',
      'If the user explicitly asks for a bolder traffic style, express it through face, hair, makeup, fitted-but-decent tailoring, fabric sheen, posture, bright light and product interaction, not through more nudity or body-part focus.'
    ].join(' ');
  }
  return 'EU/general market guidance: styling may be more fashion-forward, but still keep the image commercial, non-vulgar, product-led, adult, realistic and platform-safe.';
}

function realisticPhotographyGuidance(product) {
  return 'Default ecommerce output should look like highly realistic commercial photography: natural skin texture with subtle real imperfections, realistic fabric texture, believable hands and anatomy, no 3D CG render look, no plastic skin, no fake doll face, no wax-figure or AI mannequin look, unless the user explicitly requests illustration/CG.';
}

function negativePrompt(product) {
  const base = [
    'no Chinese text',
    'no packaging box unless explicitly allowed',
    'no religious elements, mosque patterns or religious symbols',
    'no cross-like shapes or cross-shaped decorative patterns',
    'no alcohol or pork',
    'no excessive exposure or sexualized pose',
    'no seductive, provocative, vulgar, adult-oriented or body-part-focused wording',
    'no low-angle body-gazing camera, no chest close-up, no hip close-up',
    'no underage, teen, lolita or childish sexy look',
    'no lingerie, transparent fabric, extreme cleavage, bare midriff, micro skirt or very tight bodycon look for KSA-first output',
    'no cross-gender physical contact, hugging, kissing or intimate couple gesture',
    'no 3D CG render look, no plastic skin, no fake doll face, no wax figure, no AI mannequin look unless illustration/CG is explicitly requested',
    'no unverified certification or medical claim',
    'no price, discount, seller logo, watermark or marketplace badge',
    'do not change product shape, color, parts, angle or accessories',
    'do not add accessories not included with the product',
    'no distorted text or unreadable typography'
  ];
  const forbiddenClaims = product.forbidden_claims || [];
  const forbiddenVisuals = product.forbidden_visuals || [];
  const referenceOnly = String(product.reference_policy || '').includes('reference_image_only_no_manual_color_or_shape')
    ? ['do not manually describe, recolor or redesign the product appearance; follow uploaded reference images only']
    : [];
  return [...base, ...referenceOnly, ...forbiddenClaims.map((x) => `do not use claim: ${x}`), ...forbiddenVisuals.map((x) => `do not show: ${x}`)].join('; ');
}

function promptFor(slot, product, store) {
  const factList = claims(product);
  const scenes = categoryScenes(product);
  const rule = platformRule(product, store);
  const mainImageSafeMode = Boolean(rule && slot.index === 1);
  const scene = mainImageSafeMode ? 'pure white background product-only main image' : scenes[(slot.index - 1) % scenes.length];
  const copy = mainImageSafeMode ? [] : textOverlay(slot, factList);
  const lock = exteriorLock(product);
  const factText = factList.length ? factList.join('; ') : 'No verified selling points provided; use only visual product reference and leave claims pending.';
  const platform = product.platform || 'SHEIN';
  const market = product.market || 'KSA';
  const languageRule = (product.copy_language || ['English', 'Arabic']).join(', ');
  const style = product.store_style_profile || {};
  const sceneConstraints = sceneConstraintText(product);
  const styleText = [style.style_name, style.visual_mood, style.color_palette, style.model_style, style.background_style].filter(Boolean).join('; ') || 'SHEIN KSA-first ecommerce style, bright, attractive, tasteful, store-consistent';
  const references = (product.reference_images || []).map((r) => typeof r === 'string' ? r : `${r.role || 'reference'}: ${r.path_or_url || ''} ${r.notes || ''}`).filter(Boolean).join('; ');
  const modesty = marketModestyGuidance(product);
  const realism = realisticPhotographyGuidance(product);

  let layout = 'bright, clean, mobile-first ecommerce composition, product as the largest visual anchor';
  if (slot.key === 'cover_3x4') layout = 'high-conversion 3:4 ecommerce hero cover, product in the center, 3 to 4 small icon callouts, large readable English headline';
  if (slot.key === 'cover_1x1') layout = 'square ecommerce cover, product fills the frame, minimal text, strong thumbnail readability';
  if (slot.key === 'specs') layout = 'clean infographic specification layout with neat cards, dimension lines and verified parameter fields; mark unknown fields as pending instead of inventing values';
  if (slot.key === 'detail_closeup') layout = 'macro close-up collage with 2 to 3 inset detail windows, crisp arrows, no fake internal parts';
  if (slot.key === 'steps') layout = 'three-step usage guide with simple icons and short English labels, no unverified operation step';
  if (slot.key === 'pain_solution') layout = 'pain-point and solution visual comparison, clearly marked as visual demonstration, no exaggerated result';
  if (mainImageSafeMode) layout = 'marketplace main image compliance mode: single real product only, centered, pure white RGB 255,255,255 background, no lifestyle scene, no props, no icons, no text, no badges, no packaging, subject fills most of frame while staying fully visible';

  const overlayMetadata = {
    render_policy: copy.length ? 'model_text_allowed_with_review' : 'none',
    warning: copy.length
      ? 'The image model may render the planned text directly if it supports reliable typography. Review every word, number and Arabic glyph against overlay_metadata; use layout-tool composition only as fallback.'
      : 'No text overlay for this image.',
    items: copy.map((text, index) => ({
      text,
      language: 'English',
      status: text.toLowerCase().includes('pending') ? 'needs_user_confirmation' : 'draft_review_required',
      suggested_position: index === 0 ? 'top_protected_zone' : 'side_or_bottom_protected_zone'
    }))
  };

  return {
    index: slot.index,
    key: slot.key,
    name: slot.name,
    ratio: slot.ratio,
    goal: slot.goal,
    platform_rule: rule && slot.index === 1 ? rule.note : null,
    render_mode: copy.length ? 'model_rendered_text_with_overlay_metadata_review' : 'no_text_needed',
    text_overlay: overlayMetadata.items,
    overlay_metadata: overlayMetadata,
    prompt: [
      `${slot.ratio} ratio image for ${platform} ${market}, ${slot.name}.`,
      `Goal: ${slot.goal}.`,
      `Product/SKU: ${product.sku}; store: ${store}; category: ${product.category || extractCategory(product.sku)}.`,
      `Store style profile: ${styleText}. Keep this store's products visually related in mood, lighting, color and model style without making every image identical.`,
      references ? `Reference images from user/manufacturer: ${references}. Use them as the primary source for product appearance, parts, accessories and visible structure.` : '',
      lock,
      sceneConstraints ? `User scene constraints that must be obeyed: ${sceneConstraints}. Do not expand into forbidden scenes.` : '',
      `Use only these verified product facts as selling points: ${factText}.`,
      `Scene and composition: ${layout}; use scene direction: ${scene}; keep the product clear, complete, center-focused and easy to recognize on a phone screen. If using result props such as ice, water droplets, crispy food or stain removal, make them support the product rather than overpower it. The model can be attractive, but hands, gaze and body direction must guide attention back to the product and the real usage action. Keep the subject inside a protected crop zone so 3:4 to 1:1 reuse will not cut off the product.`,
      rule && slot.index === 1 ? `Platform main-image rule: ${rule.note}` : '',
      `Text rendering rule: English and Arabic are equally important. The image model may render the planned English/Arabic text, numbers, icons and small typography directly if typography is reliable. Planned text to render or verify: ${copy.length ? copy.join(' | ') : 'none'}. Text language rule: ${languageRule}. Review every English word, Arabic word, number, unit and glyph; Arabic translation must be checked by Codex/reviewer, not by the user; if any text is distorted, regenerate or use layout-tool composition as fallback.`,
      `Market modesty and styling: ${modesty}`,
      `Realism requirement: ${realism}`,
      `Lighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter. For GPT Image 2 safety, translate direct desire words into premium aesthetics: adult model, mature appeal, high-end feminine beauty, healthy graceful curves, coordinated body proportions, elegant fitted clothing, soft natural light, fashion editorial and commercial portrait quality. When a model appears, describe in this order: image task and composition, adult identity and temperament, natural pose and overall body proportions, face/hair/makeup, clothing cut and material, bright commercial scene and lighting, product-led action, final quality, safety boundary. Never use vulgar, provocative, adult-oriented or body-part-focused expression, and never let the model become more dominant than the product.`,
      `Usage realism: the model must look like she is genuinely using the product; hands should naturally hold, press, guide, support or point to the product as appropriate; avoid fake posing such as touching hair, unrelated chin-holding, biting lips or doing unrelated gestures while operating a cleaner, massager or kitchen appliance.`,
      `If the image tool blocks the prompt, do not ask for "more sexy"; instead strengthen fashion expression, mature feminine presence, natural body proportions, fitted tailoring, soft light, skin texture, clean commercial background and real product usage action.`,
      `Do not let model, food, props or background overpower the product.`
    ].filter(Boolean).join('\n'),
    negative_prompt: negativePrompt(product),
    review_checklist: [
      '产品外观是否与参考图一致',
      '是否只使用 verified_facts',
      '是否没有禁用词/禁用画面',
      '手机缩略图是否能看清产品和主文案',
      '是否没有展示未随货配件或包装盒',
      '图上文字、数字、单位和阿文是否逐字准确；如不准确是否已重生成或后期修正',
      '如果使用参考图优先策略，提示词是否没有擅自写死产品颜色/结构/按钮/接口等外观细节',
      '人物动作是否真实服务产品，产品是否没有被人物抢走焦点',
      'KSA 市场是否使用得体服装和商业镜头，而不是暴露或身体凝视',
      '成图是否像真实商业摄影，避免 3D CG 假人感、塑料皮肤和 AI 娃娃脸'
    ]
  };
}

function suitePrompt(product, store) {
  const platform = product.platform || 'SHEIN';
  const market = product.market || 'KSA';
  const secondary = (product.secondary_markets || ['EU']).join(', ');
  const style = product.store_style_profile || {};
  const sceneConstraints = sceneConstraintText(product);
  const styleText = [style.style_name, style.visual_mood, style.color_palette, style.model_style, style.background_style].filter(Boolean).join('; ') || 'SHEIN KSA-first ecommerce style, bright, attractive, tasteful, store-consistent';
  const modesty = marketModestyGuidance(product);
  const realism = realisticPhotographyGuidance(product);
  return [
    `Generate a complete 13-image ecommerce product image suite for ${platform}, primary market ${market}, secondary markets ${secondary}.`,
    `SKU: ${product.sku}; store: ${store}; category: ${product.category || extractCategory(product.sku)}.`,
    'Deliver text prompts only. Do not generate images.',
    'All 13 images must show the same product appearance based strictly on the user/manufacturer reference images. If reference_policy is reference_image_only_no_manual_color_or_shape, do not manually describe or modify product color, shape, buttons, interfaces, windows or visible parts. This means hiding the appearance description only; the product itself must still be large, clear and visually central.',
    sceneConstraints ? `Scene constraints must be obeyed across the suite: ${sceneConstraints}.` : '',
    `Keep a coherent store style across the whole suite: ${styleText}. The images should feel like the same store, but each image must have a distinct purpose and composition.`,
    'Image 2 is 1:1. All other images are 3:4. Keep the product clear, large and recognizable on mobile.',
    'English and Arabic copy are equally important. Render text clearly when possible, then verify every English word, Arabic word, number and unit against the provided overlay metadata.',
    `Market modesty and styling: ${modesty}`,
    `Realism requirement: ${realism}`,
    'Models may show mature appeal, high-end feminine beauty, natural graceful curves, elegant fitted clothing and fashion-forward commercial presence when useful for traffic, but never use vulgar, provocative, adult-oriented or body-part-focused expression, and never let the model become more dominant than the product. Keep the image bright, high clarity and commercially readable; if safety filters block the image, translate risky wording into premium aesthetics rather than asking for more explicit sexiness.',
    'Model actions must be physically realistic and must guide attention back to the product and usage result. Hands should naturally hold, press, guide, support or point to the product; avoid unrelated chin-holding, biting lips, hair-touching or pure posing.',
    'Do not invent product functions, parameters, accessories, certifications or results. Do not copy competitor-specific facts.'
  ].filter(Boolean).join('\n');
}

function buildSuite(product, store) {
  const blocked = (product.candidate_claims || []).filter((c) => c.status !== 'verified');
  return {
    sku: product.sku,
    category: product.category || extractCategory(product.sku),
    store,
    market: product.market || 'KSA',
    platform: product.platform || 'SHEIN',
    generated_at: new Date().toISOString(),
    facts_used: sources(product),
    blocked_claims: blocked,
    forbidden_claims: product.forbidden_claims || [],
    forbidden_visuals: product.forbidden_visuals || [],
    suite_prompt: suitePrompt(product, store),
    images: IMAGE_SLOTS.map((slot) => promptFor(slot, product, store))
  };
}

function renderMd(suite) {
  const lines = [];
  lines.push(`# ${suite.store} ${suite.sku} 13 张产品套图提示词`);
  lines.push('');
  lines.push(`- 类目：${suite.category}`);
  lines.push(`- 市场：${suite.market}`);
  lines.push(`- 平台：${suite.platform}`);
  lines.push(`- 生成时间：${suite.generated_at}`);
  lines.push('');
  lines.push('## 整套总控提示词');
  lines.push('```text');
  lines.push(suite.suite_prompt || '');
  lines.push('```');
  lines.push('');
  lines.push('## 产品事实表');
  for (const fact of suite.facts_used) lines.push(`- ${fact}`);
  lines.push('');
  lines.push('## 禁用项');
  for (const item of [...suite.forbidden_claims, ...suite.forbidden_visuals]) lines.push(`- ${item}`);
  lines.push('');
  if (suite.blocked_claims.length) {
    lines.push('## 待确认卖点');
    for (const claim of suite.blocked_claims) lines.push(`- ${claim.claim || claim}`);
    lines.push('');
  }
  for (const img of suite.images) {
    lines.push(`## ${String(img.index).padStart(2, '0')}. ${img.name}`);
    lines.push(`- 比例：${img.ratio}`);
    lines.push(`- 目标：${img.goal}`);
    lines.push(`- 图上文字：${img.text_overlay.map((t) => t.text).join(' / ')}`);
    lines.push('');
    lines.push('### 提示词');
    lines.push('```text');
    lines.push(img.prompt);
    lines.push('```');
    lines.push('');
    lines.push('### 负向提示词');
    lines.push('```text');
    lines.push(img.negative_prompt);
    lines.push('```');
    lines.push('');
    lines.push('### 审核要点');
    for (const item of img.review_checklist) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.input);
  const outDir = path.resolve(args.out);
  const raw = fs.readFileSync(inputPath, 'utf8');
  const data = JSON.parse(raw);
  fs.mkdirSync(outDir, { recursive: true });
  const products = Array.isArray(data.products) ? data.products : [data];
  const outputs = [];
  for (const product of products) {
    const stores = product.stores && product.stores.length ? product.stores : ['ALL'];
    for (const store of stores) {
      const suite = buildSuite(product, store);
      const base = `${safeName(store)}_${safeName(product.sku)}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_image-suite-prompts`;
      if (args.format === 'both' || args.format === 'json') {
        const jsonPath = path.join(outDir, `${base}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(suite, null, 2), 'utf8');
        outputs.push(jsonPath);
      }
      if (args.format === 'both' || args.format === 'md') {
        const mdPath = path.join(outDir, `${base}.md`);
        fs.writeFileSync(mdPath, renderMd(suite), 'utf8');
        outputs.push(mdPath);
      }
    }
  }
  console.log(JSON.stringify({ ok: true, outputs }, null, 2));
}

main();

# 电商产品套图资料研究记录

更新时间：2026-05-13

本文记录“产品套图方法论 / skill / 批量提示词生成”的资料依据。竞品与平台资料只用于学习图片结构、表达方式和合规边界；不得自动写成本品参数、功能或认证。

## 1. 用户资料吸收

### 1.1 Word 模板：`C:\Users\dushengyi\Desktop\作图模板20251223.docx`

该模板是此前给 Lovart 的粗提示词，核心规则如下：

- 目标市场：沙特。
- 一套图共 13 张：
  - 3 张产品场景图；
  - 7 张产品卖点图；
  - 1 张尺寸参数及使用说明图；
  - 2 张封面图，比例分别为 `1:1` 和 `3:4`。
- 除 `1:1` 封面外，其余图片均为 `3:4`。
- 对产品外观的要求极严格：
  - 不改变产品和部件的形状、颜色、细节；
  - 不确定完整长相时，不要自行脑补；
  - 可沿用参考图中的角度和方向。
- 文案可用英文和阿文，不要中文。
- 不出现包装盒。
- 示例便携咖啡机禁用词：`BPA-Free`、`Safe`。
- 避免宗教元素，例如清真寺图案、宗教化人物造型等。

方法论吸收结论：

- 以后所有提示词必须先生成“产品事实表”，再生成画面。
- 参考图识别能力只能用于锁定外观、形状、颜色和部件，不允许补造不可见结构。
- 图像模型可直接生成英文、阿文、数字和小字；但必须输出可复核的文案清单，由 Codex/reviewer/子代理负责逐字检查，错误时重生成或后期修正。

### 1.2 Gemini 分享记录

链接：<https://gemini.google.com/share/8542d133db8b>

可吸收经验：

- 反模板化的关键是具体化人物、动作、场景、光线和构图，而不是只写“美女在使用产品”。
- 每版风格应有清晰 focus，例如“健康高效”“周末轻松”“差旅便携”“办公解压”。
- 用户反馈“黑不溜秋”说明主流电商图需要优先保持高明度、高清晰度、手机端一眼可读。
- 用户反复强调“聚焦肩颈按摩”说明场景图不能为了氛围偏离核心使用部位。
- Gemini 对话里最有价值的是“明亮、鲜亮、性感、强购买欲”的高点击视觉方向：用具体人物、服装材质、肢体动作、光线和文案位置打破模板化；尺度可比传统合规图更大胆，但仍要避开色情、露点、透视裸露、明显性行为姿势、宗教/酒精/猪肉等风险。

方法论吸收结论：

- 风格可以多样，但产品必须始终是第一视觉主角。
- 每张图要先定义“买家问题 / 画面目标 / 证明方式”，再写人物和场景。
- “性感”“高级”“放松”等风格词必须转成可执行的画面语言，例如深领口、露肩锁骨、贴身真丝/罗纹面料、直视镜头、明亮顺光、奶油/浅蓝/高饱和色；同时避免医疗疗效词和低俗色情表达。

## 2. 当前项目货号优先级

依据：`outputs/bi-portal/data.json`，生成时间 `2026-05-09T17:21:59+08:00`。

### 2.1 当前销售额靠前货号

| 优先级 | 货号 | 当前信号 |
|---:|---|---|
| 1 | `SM-505A电动缝纫机` | 销售额、销量、评论量、链接覆盖都高 |
| 2 | `SK-3378杆式吸尘器` | 销售额高，16 店覆盖 |
| 3 | `SK-6863半自动意式咖啡机` | 客单较高，仍有优化空间 |
| 4 | `SK-6810半自动意式咖啡机` | 16 店覆盖，销售额靠前 |
| 5 | `SK-GT-3065蒸汽熨烫机` | 销量靠前，评论基础较多 |
| 6 | `BHRL-09激光脱毛仪` | 当日销售额靠前，但需强合规 |
| 7 | `SK-7025A绞肉机` | 多店覆盖，有评论基础 |
| 8 | `SK-223三明治机和早餐机` | 销量与销售额都有信号 |
| 9 | `PA4-6L便携式冰箱` | 在售覆盖高、库存高 |
| 10 | `JD-389空气炸锅` | 有当日成交，可作为图风格测试类目 |

### 2.2 当前链接覆盖高、适合优先重做图的货号

| 类别 | 代表货号 |
|---|---|
| 电动缝纫机 | `SM-505A电动缝纫机`、`SM-520A电动缝纫机` |
| 咖啡机 | `SK-6810半自动意式咖啡机`、`SK-6863半自动意式咖啡机`、`SK-04031胶囊咖啡机`、`KF-JN-02便携咖啡机` |
| 清洁/熨烫 | `SK-3378杆式吸尘器`、`SK-GT-3065蒸汽熨烫机`、`SK-11041蒸汽熨烫机` |
| 厨房料理 | `SK-7025A绞肉机`、`SK-7027绞肉机`、`SK-7028绞肉机`、`SK-999食品料理机` |
| 早餐/烹饪 | `KJ-102三明治机和早餐机`、`SK-223三明治机和早餐机`、`JD-389空气炸锅` |
| 饮品/制冷 | `PA4-6L便携式冰箱`、`S1810电热水壶`、`SK-03038制冰机` |
| 个护 | `FZ-666颈部按摩器`、`BHRL-09激光脱毛仪`、`SK-1914热风梳`、`SK-15013卷发钳和卷发棒` |

执行建议：

- 第一批先覆盖“销售额高 + 多店铺 + 评论/售后较多”的货号，用图降低理解成本和退货风险。
- 第二批覆盖“库存高但销售弱”的货号，用封面和场景图提升点击率。
- 第三批覆盖“新货号/无评论”的货号，用参数图、清单图和使用步骤图建立信任。

## 3. 平台规则与可借鉴经验

### 3.1 SHEIN

来源：ChannelEngine 的 SHEIN marketplace guide
链接：<https://support.channelengine.com/hc/en-us/articles/21552893542941-SHEIN-marketplace-guide>

关键信息：

- SHEIN 图片比例支持 `1:1`、`3:4`、`4:5`、`13:16`。
- 主图分辨率要求覆盖 `900x2200 px` 等范围；方图支持 `900x900 px` 到 `2200x2200 px`。
- 文件大小上限为 `3MB`，格式为 `JPG/JPEG/PNG`。
- 可提交主图、方图、颜色缩略图和额外图片。
- 标题建议结构包含品牌、材质、颜色、图案、关键词、长度和类目词；标题不要依赖图片承载全部信息。

对我们的方法论影响：

- 一套图默认保留 `3:4` 主力比例，并单独产出 `1:1` 封面。
- 每张图要控制文字密度，避免因压缩到 3MB 后手机端不可读。
- 图文和标题应互补：图片负责第一眼理解，标题负责检索和属性匹配。

### 3.2 Amazon

来源 1：Amazon Sell 官方博客
链接：<https://sell.amazon.com/blog/product-photos>

来源 2：Amazon Seller Central 论坛产品图片规则帖
链接：<https://sellercentral.amazon.com/seller-forums/discussions/t/13af96ea-6b07-4bf9-8dbe-a13292c2e3b1>

来源 3：Amazon Home / Garden / Pets style guide
链接：<https://images-na.ssl-images-amazon.com/images/G/01/rainier/help/Home_Garden_and_Pets-Style_Guide.pdf>

关键信息：

- 主图强调真实产品、纯白背景、产品占画面主体、无文字/徽章/水印/不包含未售卖配件。
- 二级图可以展示使用场景、尺寸、细节、功能说明和对比。
- Amazon 官方建议参考相似商品的构图和图片类型，但图片仍要准确代表产品。
- 手机端可读性、清晰度、对焦、光线、颜色真实是基础。

对我们的方法论影响：

- 即使 SHEIN 封面可更“电商化”，也应保留一个 Amazon 级别的“极安全白底主图版本”作为合规兜底。
- 封面图可以吸睛，但不得牺牲产品真实性。
- 参数图和卖点图必须只呈现已确认事实，不用“best / safest / guaranteed”等无法证明的表达。

### 3.3 noon

来源：noon partner support 图片要求
链接：<https://support.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024>

关键信息：

- noon 建议至少 3 张高质量图，展示不同角度、尺寸、材质/纹理。
- 主图需要正面视角，非服装类使用纯白背景；主图不允许生活方式图。
- 主图不能出现包装盒、品牌吊牌、价格、硬阴影、边框、水印或 seller logo。
- 其他图必须和标题描述一致，不允许展示未包含配件，产品需有足够可见面积。
- noon 对排序有建议：正面、背面、侧面、其他角度、细节、使用。

对我们的方法论影响：

- 13 张图中应内置“角度与细节”逻辑，而不是全是场景图。
- 主图和使用图要分离：主图负责清楚，使用图负责转化。
- 任何 warranty、price、promotion 相关字样都不要进图。

### 3.4 Temu

说明：未找到稳定可公开访问的 Temu 官方图片规范页，以下只作为公开资料与平台观察的弱证据，后续如接入 Temu Seller Center 应以后台规则为准。

可借鉴趋势：

- 更偏移动端缩略图竞争，主体要大、明亮、直观。
- 主图倾向白底或浅背景，二级图可以用尺寸、场景、细节、功能图补充。
- 买家对价格敏感，图片需要同时传达“看起来不廉价”和“用途清楚”。

对我们的方法论影响：

- Temu 风格可借鉴“高对比、主体大、卖点直接”，但不能牺牲真实感。
- 尺寸、包含物、使用限制要讲清楚，减少因预期偏差导致退货。

## 4. 类目图法则

### 4.1 小家电通用

适用货号：咖啡机、空气炸锅、三明治机、绞肉机、电热水壶、制冰机等。

- 封面：产品占主视觉，配 3-4 个核心利益点图标；不要堆参数。
- 场景：厨房、早餐、办公室、露营、家庭聚会、差旅；沙特场景应明亮、干净、家庭友好。
- 卖点：速度、容量、易清洁、多场景、双模式、配件、食物效果。
- 参数图：尺寸、容量、功率、电压、适用食材、配件清单；无数据则留空或标“待确认”。
- 禁忌：不要夸大健康效果；不要展示未随货配件；不要出现酒精、猪肉等敏感物。

### 4.2 清洁/熨烫类

适用货号：杆式吸尘器、蒸汽熨烫机、手持蒸汽清洁机。

- 封面：前后对比可用，但必须是“视觉示意”，不要伪造极端效果。
- 场景：客厅地面、沙发缝隙、衣柜/上班前、旅行箱旁。
- 卖点：轻便、不同刷头/喷头、角落清洁、快速除皱、衣物护理。
- 参数图：功率、续航、水箱、线长、档位、配件。
- 禁忌：不要承诺杀菌、除螨、医用级，除非有证据。

### 4.3 个护/美容类

适用货号：颈部按摩器、激光脱毛仪、热风梳、卷发棒、直发夹板。

- 封面：人物可以出现，但必须合规、健康、有活力，避免暴露或性暗示。
- 场景：明亮卧室、梳妆台、健身后恢复、办公室放松、差旅。
- 卖点：舒适、便携、多档位、造型效果、使用便利。
- 参数图：档位、温度、充电/电源、适用部位、使用步骤。
- 禁忌：不要使用医疗疗效、永久脱毛、100% 安全、无痛等绝对化表述，除非证据齐全。

### 4.4 电动缝纫/DIY 类

适用货号：电动缝纫机、手持搅拌器等工具型货号。

- 封面：产品 + 成品效果 + 初学者友好场景。
- 场景：家庭修补、DIY 桌面、手作布料、衣物修改。
- 卖点：便携、双速、脚踏/按钮、照明、线迹、配件。
- 参数图：尺寸、重量、供电、线迹数量、适用布料。
- 禁忌：不要展示无法缝制的厚料；不要承诺工业级效果。

## 5. 针对当前货号的公开竞品观察

这些观察来自公开搜索结果和公开商品页，只用于归纳图片结构与信息重点；任何竞品参数都不得直接写入本品提示词，除非用户或本品资料确认。

### 5.1 `KF-JN-02便携咖啡机` / 便携咖啡机

公开页面：

- noon 同款/近似款：`ELTRAZONE 3 in 1 Portable Espresso Coffee Maker KF-JN-02`
  <https://www.noon.com/saudi-en/3-in-1-portable-espresso-coffee-maker-kf-jn-02-compatible-with-small-large-capsules-and-ground-coffee-automatic-extraction-fast-heating-compact-coffee-machine-for-travel-and-home/Z110E9DF8960B83585B79Z/p/>
- noon 同类便携咖啡机：
  <https://www.noon.com/saudi-en/portable-coffee-maker-3-in-1-travel-espresso-machine-compatible-with-small-large-capsules-ground-coffee-50-brews-per-charge-ideal-for-camping-travel-office-and-home/Z9E75C6001C928796BE5AZ/p/>
- noon 同类 `HiBREW H4C`：
  <https://www.noon.com/saudi-en/hibrew-h4c-explorer-portable-electric-espresso-maker-usb-c-rechargeable-for-coffee-pods-ground-coffee-compact-for-home-and-travel-with-foldable-holder-carrying-case/Z8D4A2DB2AC16AFF6A3BAZ/p/>

可借鉴结构：

- 封面突出“3-in-1 / portable / travel / capsule & ground coffee”这类核心理解点。
- 场景重点集中在旅行、办公室、露营、车内、家庭。
- 参数图常展示兼容类型、水箱/杯量、充电方式、加热或萃取流程。

必须隔离的竞品事实：

- 具体压力 bar、容量、电池容量、杯数、温度、材质、保修年限、配件清单等，必须按本品资料确认后才能使用。
- 竞品的 `food-grade`、`safe`、认证类表达不得直接迁移。

### 5.2 `SM-505A电动缝纫机` / 电动缝纫机

公开页面：

- SHEIN 电动缝纫机类目：<https://us.shein.com/Electric-Sewing-Machines-c-12883.html>
- SHEIN 同类便携缝纫机：<https://m.shein.com/ar-en/Mini-Electric-Sewing-Machine%2C-Portable-Electric-Sewing-Machine%2C-Multi-Functional-Household-Sewing-Machine%2C-Adjustable-Speed%2C-12-Sewing-Patterns%2C-Suitable-For-Parents-Beginners-And-Handicraft-Enthusiasts%2C-Lightweight-And-Easy-To-Carry%2C-Can-Be-Used-Indoors-And-Outdoors%2C-Manual-Operation-Without-Power%2C-Includes-Main-Unit-Power-Adapter-And-Instruction-Manual.-p-432847763.html>

可借鉴结构：

- 类目标题高频强调 `12 stitches`、`2-speed`、`LED light`、`foot pedal`、`beginner-friendly`、`DIY repair`。
- 套图应覆盖：正面产品、配件清单、布料/衣物修补场景、线迹/速度/照明说明、适用布料边界。

必须隔离的竞品事实：

- 线迹数量、可缝布料层数、是否带脚踏/灯/扩展台/工具包，需要本品确认。

### 5.3 `SK-3378杆式吸尘器` / 杆式吸尘器

公开页面：

- SHEIN 同类杆式吸尘器：<https://m.shein.com/us/SVHT-Cordless-Vacuum-Cleaner%2C-500W-45KPA-50Mins-Stick-Vacuum-Cleaners-For-Home-With-LED-Light%2C-Self-Standing-Anti-Tangle-Brush-%26Amp%3B-1.6L-Dust-Cup%2C-Lightweight-Vacuum-For-Pet-Hair-Carpets-Hard-Floors-p-448584710.html>
- SHEIN 同类 `4-in-1` 吸尘器：<https://us.shein.com/4-In-1-Cordless-Rechargeable-Stick-Vacuum-Cleaner-With-Motor-Floorhead%2C-Converts-To-Handheld-Multi-Surface-Cleaning%2C-Model-EV2420-p-455496869.html>

可借鉴结构：

- 常见图组强调吸力、续航、尘杯、刷头、地板/地毯/车内多场景。
- 适合用“整机图 + 多刷头 + 手持转换 + 尘杯清理 + 地面清洁场景”组合。

必须隔离的竞品事实：

- `KPA`、`W`、续航分钟、尘杯容量、HEPA、宠物毛发能力、配件名称必须本品确认。

### 5.4 `FZ-666颈部按摩器` / 肩颈按摩器

公开页面：

- SHEIN 同类颈部按摩器：<https://m.shein.com/us/Portable-Electric-Neck-Massager-With-Brushless-Motor%2C-Therapeutic-Kneading-Massager-For-Office%2C-Acupoint-Massage-Nodes-Massager-For-Back-And-Shoulders-p-431960490.html>
- SHEIN 同类热敷颈部按摩器：<https://m.shein.com/ar-en/Heated-Neck-Massager---Portable-Deep-Tissue-Electric-Neck-And-Shoulder-Massager-With-Finger%2C-4D-Kneading-Bionic-Back-Relaxation-Massager-For-Pain-Relief-And-Muscle-Relaxation%2C-Gift-For-Men-And-Women-p-443132367.html>

可借鉴结构：

- 场景集中在办公室、居家、旅行、肩颈贴合。
- 图组通常会用局部热敷光效、按摩头示意、佩戴方式、适用部位图。

必须隔离的竞品事实：

- `brushless motor`、`4D`、`heat`、`deep tissue`、`pain relief`、功率、材质、档位等需要本品确认；医疗化词汇必须谨慎。

## 6. 事实约束规则

每个产品必须维护四张表：

1. `verifiedFacts`：用户给定、后台标题/参数、包装/说明书、实拍参考图可确认的信息。
2. `visualFacts`：参考图中可见的形状、颜色、部件、角度、接口、配件。
3. `candidateClaims`：竞品常见但本品未确认的卖点，只能进入“待确认”。
4. `forbiddenClaims`：禁用词、平台不允许词、用户禁止词、无法证明的强承诺。

提示词生成时：

- 只能使用 `verifiedFacts` 和 `visualFacts`。
- `candidateClaims` 只能用于提醒用户补资料，不得直接写入画面。
- `forbiddenClaims` 必须进入负向提示词和 reviewer 检查项。

## 7. 来源链接

- Gemini 分享记录：<https://gemini.google.com/share/8542d133db8b>
- Gemini 追加分享记录：<https://gemini.google.com/share/38365c080843>
- X / 李岳：GPT Image 2 女性角色提示词安全审美写法：<https://x.com/liyue_ai/status/2056947629548843481?s=46>
- Amazon product photos 官方博客：<https://sell.amazon.com/blog/product-photos>
- Amazon Seller Central 图片要求帖：<https://sellercentral.amazon.com/seller-forums/discussions/t/13af96ea-6b07-4bf9-8dbe-a13292c2e3b1>
- Amazon Home / Garden / Pets style guide：<https://images-na.ssl-images-amazon.com/images/G/01/rainier/help/Home_Garden_and_Pets-Style_Guide.pdf>
- noon 图片要求：<https://support.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024>
- SHEIN marketplace guide：<https://support.channelengine.com/hc/en-us/articles/21552893542941-SHEIN-marketplace-guide>


## 7. 2026-05-13 口径更新：Gemini 细化提示词与性感流量版

- 用户确认 FZ-666 肩颈按摩器提示词应进一步向 Gemini 的写法靠拢：不是功能清单式提示词，而是按 `Visual Subject / Model & Styling / Scene & Atmosphere / Composition & Text` 写出具体人物、服装、动作、场景、光线、构图和文案位置。
- 对封面图、场景图和个护类目，可使用更强的“明亮时尚大片 + 性感流量”风格：深领口、露肩、锁骨、上背线条、贴身真丝/罗纹面料、直视镜头、微张嘴唇、放松但勾人的姿态。
- 边界：不色情、不露点、不透视裸露、不明显性行为姿势、不廉价低俗；产品必须比人物更重要；不能加入医疗治愈、保证缓解疼痛、治疗颈椎病等医疗承诺。
- FZ-666 最新样例文件保留为 `outputs/product-image-suite/FZ-666/FZ-666_13-image_prompt_suite_bolder_sexy_edition.docx` 和同名 `.md`。

## 8. 2026-05-14 口径更新：参考图优先、产品 C 位与成图稳定性

新的 Gemini 分享记录补充了多个实操问题，已吸收到 skill：

- **提示词交付边界**：用户要的是提示词时，不要误调用画图；输出必须是可复制的纯文本提示词。
- **参考图优先**：后续用户会把厂家图/产品参考图上传给作图工具，因此提示词不应再写死产品颜色、壳体细节、按钮位置、窗口形状等外观描述；只要求产品外观严格以参考图为准。
- **外观描述隐身，不是产品消失**：最新 Gemini 链接里“只提位置，不提外观”的思路可吸收，但必须改成更稳定的工程口径：产品外观细节不手写，产品本体仍要大、清楚、位于前景/C 位/使用动作焦点。
- **占位词替换**：不要写“你的产品/该产品”这类占位词，单张提示词里直接使用实际品类名，例如空气炸锅、布艺清洗机、肩颈按摩器、制冰机。
- **产品与人物主次**：美女模特能吸睛，但产品必须是落点。通过前景放大、C 位、高亮、手部动作、视线引导和背景虚化，确保产品和使用结果一眼可见。
- **结果道具**：制冰机可借鉴“冰块、水珠、透明杯、果茶/冰咖”的清凉视觉，让卖点更有欲望感；空气炸锅可借鉴酥脆食物，清洁机可借鉴污渍抽吸过程。但结果道具不能比产品更抢眼，也不能引入沙特禁忌。
- **真实动作**：清洁类必须看起来真的在清洁，按摩类必须自然佩戴或享受按摩，厨房/饮品类必须真实拿取食物或饮品；不要出现撩头发、举杯摆拍等破坏信任的动作。
- **场景边界**：用户指定“正常在家使用，不要汽车”或“聚焦肩颈按摩”时，提示词必须硬性遵守，不要擅自拓展到车内、酒吧或非核心部位。
- **明亮电商优先**：跨境电商图应高明度、高清晰、手机端强识别；如果画面过暗，会降低点击。
- **性感尺度回退**：当过强性感导致出图失败，先删除高风险姿势和词汇，把吸引力转移到高颜值、鲜亮色彩、修身真丝/罗纹/运动面料、肩颈/锁骨/腰线、清透光线、水珠/冰块等安全但有欲望感的元素。
- **类目经验**：布艺清洗机适合沙发/地毯/床垫等真实家用痛点；肩颈按摩器应优先聚焦肩颈、斜方肌、热敷和免提；制冰机可用夏日冰饮、办公室冰咖、家庭吧台等高明度场景，但沙特默认不出现酒精。即便 Gemini 样例里出现威士忌/鸡尾酒，也必须替换成无酒精饮品。

## 9. 2026-05-20 口径更新：GPT Image 2 欲望词转高级审美词

从 X 文章 <https://x.com/liyue_ai/status/2056947629548843481?s=46> 吸收的可复用方法：

- GPT Image 2 对直白欲望词更敏感。不要在最终提示词里直接堆 `性感`、`诱惑`、`挑逗`、`胸大`、`翘臀`、`低机位`、`湿身` 等词。
- 用户想要的“吸引力”应转译为高级审美语言：`成年女性角色`、`高级女性美`、`成熟吸引力`、`健康丰腴`、`自然流畅的身体曲线`、`肩颈舒展`、`腰线自然`、`剪裁合身`、`得体服装`、`明亮商业人像`、`时尚 editorial`。
- 不要突出身体局部，要写整体体态；不要写挑逗动作，要写自然姿态；不要写私密暧昧场景，要写明亮干净的商业场景。
- 失败后不要加“更性感”，而是增强人物时尚表现力、高级女性气质、身体比例与姿态、服装剪裁贴合度、柔和光影和皮肤质感。
- 这条规则不等于放弃流量感。它是把“尺度”藏进气质、剪裁、姿态和光影里，让图既有购买吸引力，又更容易过 GPT Image 2 / 平台安全审查。
- 已沉淀为 `skills/ecommerce-product-image-suite/references/gpt-image2-safe-aesthetic.md`，并接入 reviewer 检查项与脚本提示词风格。

补充阅读该帖下方多个案例后，新增提炼：

- 高质量提示词通常不是“卖点 + 美女”一句话，而是按 `任务/比例/风格 -> 构图 -> 成年身份和气质 -> 姿态和整体体态 -> 脸部发型妆容 -> 服装剪裁材质 -> 场景光影 -> 成图质量 -> 负向边界` 展开。
- 案例里大量使用具体的姿态和材质词，例如自然回望、轻微侧身、肩颈舒展、S 型动态姿态、缎面、针织、柔光、浅景深、窗边自然光。这类写法可吸收。
- 案例里的床上私密感、泳装湿身、女仆/猫耳、低机位身体凝视等不应照搬到 SHEIN 电商图；应降级为明亮商业场景、真实可购买服装、产品 C 位和正常商业镜头。
- 对电商图的最终改造是：人物负责点击吸引力，产品负责成交信任。提示词每一段都必须回收产品主体、真实使用动作、移动端清晰度和事实约束。
- reviewer 复核后补充两条边界：KSA 默认加得体服饰物理边界，避免把“合身剪裁”误生成极紧/过露；真实电商图默认加 `highly realistic commercial photography / natural skin texture / no 3D CG render look / no fake doll face`，防止把 3D CG 案例误迁移成假人感。

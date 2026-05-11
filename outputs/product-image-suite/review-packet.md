# 电商产品套图能力 reviewer 复核包
请复核事实约束、平台合规、13张图结构、批量脚本逻辑与评分机制。重点找 P0/P1 风险。


---
## FILE: `docs/product-image-suite-methodology.md`

```markdown
# 电商产品 13 张套图方法论

更新时间：2026-05-09

目标：针对 SHEIN 沙特市场及未来 Amazon / noon / Temu 等平台，为每个店铺、每个货号生成一套可执行、可批量、可审核的 13 张产品图提示词。输出重点是“让作图工具一张一张稳定出图”，不是依赖单个 agent 自动连续理解。

## 1. 总原则

### 1.1 先事实，后创意

所有创意都必须建立在产品事实表之上：

- 产品外观事实：参考图中可见的形状、颜色、按钮、接口、配件、角度。
- 产品参数事实：尺寸、容量、功率、电压、档位、材质、配件清单。
- 产品卖点事实：用户确认、说明书确认、后台标题/参数确认、实拍可证明。
- 市场与平台事实：目标国家、语种、平台图片比例和合规边界。

不得把竞品页面、其他卖家详情图、AI 推测出来的功能，直接当成本品事实。

### 1.2 一套图不是 13 张重复封面

13 张图必须分工明确：

- 封面负责点击。
- 参数图负责降低疑虑。
- 轮播图负责快速讲清核心购买理由。
- 场景图负责代入。
- 卖点图负责证明。
- 细节图负责建立质感。
- 使用/清单/对比图负责降低退货和误解。

### 1.3 产品永远是主角

人物、场景、食物、道具、文案都只是辅助，不允许抢走产品主体。

默认画面要求：

- 主体产品在画面中清楚、完整、可识别。
- 产品形状、颜色、部件不变形。
- 不确定的结构不补画。
- 参考图角度不足时，优先沿用参考图角度，不强行生成背面或内部。

### 1.4 沙特市场合规基线

默认避免：

- 宗教元素、清真寺、经文、宗教化人物造型。
- 酒精、猪肉、过度亲密、过度暴露、强性暗示。
- 医疗疗效、绝对安全、永久效果、无痛、100% 等无法证明表达。
- 中文入图。

人物风格可以年轻、明亮、有吸引力，但要健康、干净、家庭友好、平台可过审。

## 2. 13 张图片固定架构

| 编号 | 图片类型 | 比例 | 主要目标 | 内容边界 |
|---:|---|---|---|---|
| 1 | 3:4 主封面 | 3:4 | SHEIN 主力点击图 | 产品 C 位 + 3-4 个核心卖点，明亮、手机端可读 |
| 2 | 1:1 方形封面 | 1:1 | 方图/广告/跨平台复用 | 更少文字，更强缩略图识别 |
| 3 | 参数规格图 | 3:4 | 回答尺寸/容量/功率/配件 | 只写已确认参数；缺失则留“待确认” |
| 4 | 核心轮播图 | 3:4 | 3 秒讲清为什么买 | 1 个大标题 + 3 个利益点 + 产品使用示意 |
| 5 | 主使用场景图 | 3:4 | 让买家想象自己使用 | 场景真实、产品清楚、不要偏题 |
| 6 | 第二使用场景图 | 3:4 | 展示另一个高频场景 | 与第 5 张不能重复 |
| 7 | 卖点图 1 | 3:4 | 证明最强卖点 | 用图中图/箭头/局部特写解释 |
| 8 | 卖点图 2 | 3:4 | 证明第二卖点 | 用场景和结果表达，避免空话 |
| 9 | 细节特写图 | 3:4 | 建立质感和可信度 | 接口、按钮、刀头、喷头、杯体等可见细节 |
| 10 | 使用步骤图 | 3:4 | 降低上手门槛 | 3-4 步，短文案，不脑补不可见步骤 |
| 11 | 尺寸/容量/适用范围图 | 3:4 | 降低预期偏差 | 尺寸、容量、适用人数/空间/食材等必须有来源 |
| 12 | 痛点解决/对比图 | 3:4 | 强化购买理由 | 可做“before/after 示意”，禁止伪造极端效果 |
| 13 | 配件/清单/信任图 | 3:4 | 说明到手包含什么 | 只展示随货物品；默认不展示包装盒 |

如平台或类目需要更严主图，可额外生成“白底合规主图”作为替换封面，不占默认 13 张。

## 3. 每张图的提示词结构

每张图都使用同一结构，便于批量化：

```text
图片编号：
图片用途：
比例：
平台/市场：
画面目标：
产品外观锁定：
可使用事实：
场景与构图：
人物/道具：
文案层：
光线与风格：
负向约束：
最终提示词：
审核要点：
```

### 3.1 产品外观锁定模板

```text
以用户上传的参考图为唯一产品外观依据。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。若无法确定背面、内部或隐藏部件，保持参考图角度，不要自行补画。
```

### 3.2 文案层规则

图上文字必须短、可读、可审核：

- 封面：1 个主标题 + 2-4 个短卖点。
- 参数图：字段化表达，避免长句。
- 卖点图：每张只讲一个核心点。
- 阿文：默认作为“建议文案”，除非已有人工校对文本，否则不要让 AI 直接生成复杂阿文入图。
- 禁止：价格、限时、最便宜、第一、100%、永久、安全保证、医疗疗效。

### 3.3 负向约束模板

```text
不要出现中文；不要出现包装盒；不要出现宗教元素、清真寺、经文、宗教化人物造型；不要出现酒精、猪肉、过度暴露或性暗示；不要出现未确认认证、医疗疗效、绝对化承诺；不要添加未包含配件；不要改变产品形状、颜色和结构；不要让文字变形乱码；不要出现竞品品牌、水印、价格、促销标签。
```

## 4. 风格系统

### 4.1 默认 SHEIN 沙特电商风

- 高明度、高清晰度、背景干净。
- 产品主体大，人物和场景辅助。
- 色彩可鲜亮，但不要廉价荧光感。
- 文案大字少，图标清楚。
- 场景本地化但不宗教化：现代厨房、客厅、办公室、汽车、露营、家庭聚会、梳妆台、健身后恢复等。

### 4.2 可选风格包

| 风格 | 适用类目 | 关键词 |
|---|---|---|
| 明亮爆款电商风 | 全类目封面 | high-key lighting, clean ecommerce layout, bold readable headline |
| 现代家庭生活风 | 小家电、清洁、缝纫 | bright home, warm family-friendly scene, practical daily use |
| 极简轻奢风 | 咖啡机、厨师机、个护 | premium countertop, soft shadow, editorial product focus |
| 户外/差旅便携风 | 便携咖啡机、冰箱、按摩器 | car, RV, camping, office, travel-friendly |
| 健康活力风 | 空气炸锅、按摩器、美容个护 | bright fitness/lifestyle, energetic, compliant clothing |
| DIY 手作风 | 缝纫机、工具类 | crafting table, fabric, hands-on making, beginner-friendly |

## 5. 类目策略

### 5.1 咖啡机类

适用：`SK-6810半自动意式咖啡机`、`SK-6863半自动意式咖啡机`、`SK-04031胶囊咖啡机`、`KF-JN-02便携咖啡机`。

图组重点：

- 封面：咖啡出品、操作便利、家庭/办公室/旅行场景。
- 场景：早晨厨房、办公室、露营、车内/RV。
- 卖点：兼容方式、加热/冷热、Type-C、便携、萃取口感等必须按事实表使用。
- 参数图：水箱、杯量、电源、胶囊/咖啡粉兼容性、尺寸。
- 禁忌：不要虚构压力 bar、温度、认证、BPA-Free、Safe。

### 5.2 电动缝纫机类

适用：`SM-505A电动缝纫机`、`SM-520A电动缝纫机` 等。

图组重点：

- 封面：新手友好、家庭修补、DIY。
- 场景：桌面缝补、裤脚修改、手作布艺。
- 卖点：线迹数量、双速、脚踏、照明、切线、便携等按事实使用。
- 参数图：尺寸、重量、电源、适用布料、配件。
- 禁忌：不要展示工业厚料、皮革等未确认能力。

### 5.3 吸尘/清洁类

适用：`SK-3378杆式吸尘器`、`SK-13034杆式吸尘器`、`SK-13065吸尘器`。

图组重点：

- 封面：轻便、强吸、地面/缝隙/沙发多场景。
- 场景：客厅、车内、沙发、厨房地面。
- 卖点：刷头、尘杯、续航、过滤、低噪等必须有事实来源。
- 禁忌：不要承诺除螨、杀菌、医用级净化。

### 5.4 蒸汽熨烫类

适用：`SK-GT-3065蒸汽熨烫机`、`SK-11004蒸汽熨烫机`、`SK-11041蒸汽熨烫机`。

图组重点：

- 封面：快速除皱、上班前、旅行衣物护理。
- 场景：衣柜、挂烫、旅行箱、办公室前准备。
- 卖点：蒸汽量、水箱、预热、便携、适用面料。
- 禁忌：before/after 必须写“visual demonstration”，不要伪造极端皱褶消失效果。

### 5.5 绞肉/料理/早餐类

适用：`SK-7025A绞肉机`、`SK-7027绞肉机`、`KJ-102三明治机和早餐机`、`JD-389空气炸锅`。

图组重点：

- 封面：食物成品诱人，但产品仍清楚。
- 场景：家庭厨房、早餐、聚会备餐。
- 卖点：容量、刀头、易清洁、多功能、定时/温控。
- 禁忌：不要出现猪肉、酒精；健康类表达要克制。

### 5.6 个护类

适用：`FZ-666颈部按摩器`、`BHRL-09激光脱毛仪`、`SK-1914热风梳`、`SK-15013卷发钳和卷发棒`。

图组重点：

- 封面：人物使用 + 产品贴合部位/造型效果。
- 场景：办公室、卧室、梳妆台、健身后恢复、车内差旅。
- 卖点：档位、温度、便携、使用部位、造型效果。
- 禁忌：不得医疗化；不得过度暴露；脱毛类不能说永久、无痛、医疗级。

## 6. 评分机制

每张提示词按 100 分评价：

| 维度 | 分值 | 说明 |
|---|---:|---|
| 产品事实准确 | 25 | 不改外观、不混竞品参数、不用未确认卖点 |
| 平台/市场合规 | 20 | 比例、文案、禁忌、人物尺度、无水印价格等 |
| 图像可执行性 | 15 | 单张图目标清晰，AI 能按图执行 |
| 转化力 | 15 | 第一眼吸睛，痛点明确，文案短促有力 |
| 信息分工 | 10 | 13 张图互补不重复 |
| 手机端可读性 | 10 | 文字少、对比强、主体大 |
| 后续可维护 | 5 | 输出结构化，便于网站/API 接入 |

硬性一票否决：

- 引入竞品独有功能或参数。
- 改变产品颜色、形状、部件。
- 使用禁用词或无法证明的绝对承诺。
- 包含明显不适合沙特市场或平台审核的内容。

## 7. 批量生成流程

### 7.1 输入

每个产品输入一个事实对象：

```json
{
  "sku": "KF-JN-02便携咖啡机",
  "category": "便携咖啡机",
  "stores": ["DL", "DX"],
  "market": "KSA",
  "reference_policy": "strict_copy_shape_angle",
  "verified_facts": [
    {"claim": "Portable electric espresso machine", "source": "user_template"},
    {"claim": "Compatible with ground coffee and capsule coffee", "source": "user_template"}
  ],
  "visual_facts": [
    "产品形状、颜色、部件以参考图为准"
  ],
  "forbidden_claims": ["BPA-Free", "Safe"],
  "forbidden_visuals": ["包装盒", "宗教元素", "清真寺图案"],
  "copy_language": ["English", "Arabic_review_required"]
}
```

### 7.2 输出

每个店铺、每个货号输出：

- `manifest`：产品事实与限制摘要。
- `images[13]`：逐张图结构化提示词。
- `review_checklist`：审核要点。
- `blocked_claims`：未确认但常见、需要用户补资料确认的候选卖点。

### 7.3 文件命名

```text
{store}_{sku}_{YYYYMMDD}_image-suite-prompts.md
{store}_{sku}_{YYYYMMDD}_image-suite-prompts.json
```

## 8. 未来接入 SHEIN API / 网站的设计

### 8.1 数据触发

未来从 SHEIN API 或本地 BI 读取：

- 曝光高、点击低：优先换封面图。
- 点击高、转化低：优化参数图、卖点图、信任图。
- 退货/差评集中：补尺寸、使用限制、配件清单、真实场景。
- 同款多链接表现差异大：学习赢家链接的图片结构，但不复制素材和事实。
- 新品无评论：加强参数、场景、使用步骤、清单图。

### 8.2 网站接口

建议网站提供四个模块：

1. 产品事实库：参数、卖点、参考图、禁用项。
2. 套图生成器：按货号/店铺生成 13 张提示词。
3. 提示词评分器：独立 reviewer 评分和挑错。
4. 作图任务队列：把每张图提示词送到免费工具，多任务并行。

### 8.3 人工边界

- AI 可以生成提示词和评分建议。
- AI 不自动确认未证实参数。
- AI 不自动把竞品内容写入本品详情。
- 阿文、合规敏感词、医疗/认证类表述建议人工复核。

## 9. 当前推荐推进顺序

1. 先选 3 个样例货号：`KF-JN-02便携咖啡机`、`SM-505A电动缝纫机`、`SK-3378杆式吸尘器`。
2. 每个货号各整理一份产品事实表。
3. 用 skill 生成 13 张提示词。
4. 用 reviewer rubric 评分。
5. 用免费工具并行出图。
6. 回收出图结果，记录“提示词 -> 成图问题 -> 修订策略”。
7. 再扩大到所有高优先级货号。

```


---
## FILE: `docs/product-image-suite-research.md`

```markdown
# 电商产品套图资料研究记录

更新时间：2026-05-09

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
- 图上文案必须分成“可直接进图”和“建议后期加字”两层，尤其阿文应优先人工校对后再入图。

### 1.2 Gemini 分享记录

链接：<https://gemini.google.com/share/8542d133db8b>

可吸收经验：

- 反模板化的关键是具体化人物、动作、场景、光线和构图，而不是只写“美女在使用产品”。
- 每版风格应有清晰 focus，例如“健康高效”“周末轻松”“差旅便携”“办公解压”。
- 用户反馈“黑不溜秋”说明主流电商图需要优先保持高明度、高清晰度、手机端一眼可读。
- 用户反复强调“聚焦肩颈按摩”说明场景图不能为了氛围偏离核心使用部位。
- 对沙特市场，Gemini 对话里部分“性感”表达需要收敛：保留吸引力、明快、健康、曲线感，但避免暴露、性暗示、酒精、宗教或不适合平台审核的元素。

方法论吸收结论：

- 风格可以多样，但产品必须始终是第一视觉主角。
- 每张图要先定义“买家问题 / 画面目标 / 证明方式”，再写人物和场景。
- 所有“性感”“高级”“治愈”等风格词必须受平台合规和目标市场约束。

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
- Amazon product photos 官方博客：<https://sell.amazon.com/blog/product-photos>
- Amazon Seller Central 图片要求帖：<https://sellercentral.amazon.com/seller-forums/discussions/t/13af96ea-6b07-4bf9-8dbe-a13292c2e3b1>
- Amazon Home / Garden / Pets style guide：<https://images-na.ssl-images-amazon.com/images/G/01/rainier/help/Home_Garden_and_Pets-Style_Guide.pdf>
- noon 图片要求：<https://support.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024>
- SHEIN marketplace guide：<https://support.channelengine.com/hc/en-us/articles/21552893542941-SHEIN-marketplace-guide>

```


---
## FILE: `skills/ecommerce-product-image-suite/SKILL.md`

```markdown
---
name: ecommerce-product-image-suite
description: 为 SHEIN/跨境电商产品生成整套 13 张产品图提示词的方法论和工作流。用户提到产品图、套图、封面图、卖点图、场景图、参数图、轮播图、Lovart、AI 作图、批量提示词、SHEIN 图片优化、Temu/Amazon/noon 竞品图、根据货号/店铺生成图片提示词、给提示词评分时必须使用。本 skill 会先建立产品事实表，防止虚假夸大和混入竞品信息，再输出逐张精细提示词、审核清单和评分建议。
---

# Ecommerce Product Image Suite

## 先读

按需要读取：

- `references/platform-rules.md`：平台图片规格与合规边界。
- `references/image-stack-blueprint.md`：13 张套图固定架构。
- `references/prompt-schema.md`：输入/输出格式。
- `references/category-playbooks.md`：按当前货号类目生成场景和卖点。
- `references/reviewer-rubric.md`：提示词评分与挑错。

项目文档：

- `docs/product-image-suite-methodology.md`
- `docs/product-image-suite-research.md`

可选脚本：

- `node scripts/product-image-suite/generate_prompt_suite.mjs --input inputs/product-image-suite/sample-product-facts.json --out outputs/product-image-suite/prompts`

## 工作流

### 1. 先建立产品事实表

不要直接写图像提示词。先整理：

- `verified_facts`：用户确认、后台标题/参数、说明书、包装、参考图可证明的信息。
- `visual_facts`：参考图中可见的外观、颜色、角度、部件、接口、配件。
- `candidate_claims`：竞品常见但本品未确认的信息，只能提醒用户确认。
- `forbidden_claims`：禁用词、无法证明承诺、平台敏感表述。
- `forbidden_visuals`：宗教元素、包装盒、酒精、猪肉、过度暴露、未随货配件等。

如果缺少关键参数，继续生成提示词，但把参数图中的字段标为“待确认”，不要脑补。

### 2. 按 13 张图生成

默认结构：

1. `3:4` 主封面。
2. `1:1` 方形封面。
3. `3:4` 参数规格图。
4. `3:4` 核心轮播图。
5. `3:4` 主使用场景图。
6. `3:4` 第二使用场景图。
7. `3:4` 卖点图 1。
8. `3:4` 卖点图 2。
9. `3:4` 细节特写图。
10. `3:4` 使用步骤图。
11. `3:4` 尺寸/容量/适用范围图。
12. `3:4` 痛点解决/对比图。
13. `3:4` 配件/清单/信任图。

每张图都必须说明：

- 图片用途。
- 比例。
- 画面目标。
- 产品外观锁定。
- 可使用事实。
- 场景与构图。
- 文案层。
- 负向约束。
- 最终提示词。
- 审核要点。

### 3. 外观锁定必须写进每张图

默认句式：

> 以用户上传的参考图为唯一产品外观依据。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。若无法确定背面、内部或隐藏部件，保持参考图角度，不要自行补画。

### 4. 竞品图只能借鉴结构

允许借鉴：

- 图片顺序。
- 构图方式。
- 场景类型。
- 信息层级。
- 图标/箭头/局部放大/对比图这些表达形式。

禁止借鉴：

- 竞品独有参数。
- 竞品认证。
- 竞品配件。
- 竞品品牌和图片素材。
- 竞品功能承诺。

### 5. 沙特市场默认合规

默认避免：

- 中文入图。
- 宗教元素、清真寺、经文、宗教化人物造型。
- 酒精、猪肉。
- 过度暴露、强性暗示。
- 医疗疗效、永久效果、100%、safe、BPA-Free 等未确认/禁用表述。
- 价格、限时、seller logo、水印、平台外联系方式。

人物可以年轻、明亮、有活力，但必须健康、干净、家庭友好、可过审。

### 6. 文案策略

- 图中文字尽量用英文短句。
- 阿文默认放在“建议后期文案”，除非用户提供人工校对阿文。
- 每张图只讲一个核心点。
- 不写无法证明的绝对化表达。
- 如果文案可能被图片模型画坏，建议“画面无文字，后期加字”。

### 7. 输出格式

如果用户要直接看，输出 Markdown。

如果用户要接网站/API，输出 JSON：

```json
{
  "sku": "货号",
  "store": "店铺",
  "market": "KSA",
  "facts_used": [],
  "blocked_claims": [],
  "images": [
    {
      "index": 1,
      "name": "3:4 主封面",
      "ratio": "3:4",
      "goal": "",
      "prompt": "",
      "negative_prompt": "",
      "text_overlay": [],
      "review_checklist": []
    }
  ]
}
```

## 质量门槛

生成后必须自查：

- 是否完整 13 张。
- 是否只有 1 张是 `1:1`，其余为 `3:4`。
- 是否每张都包含外观锁定。
- 是否存在未确认卖点。
- 是否混入竞品功能/配件。
- 是否有禁用词。
- 是否适合沙特市场。
- 是否能一张一张送给单图生成工具执行。

如用户要求“评分子 agent / reviewer”，按 `references/reviewer-rubric.md` 评分，并给出修改建议。

```


---
## FILE: `skills/ecommerce-product-image-suite/references/platform-rules.md`

```markdown
# 平台图片规则摘要

更新时间：2026-05-09

## SHEIN

来源：<https://support.channelengine.com/hc/en-us/articles/21552893542941-SHEIN-marketplace-guide>

- 支持比例：`1:1`、`3:4`、`4:5`、`13:16`。
- 图片范围：主图、方图、颜色缩略图、额外图片。
- 主图/详情图支持 `900px` 到 `2200px` 级别尺寸，文件上限 `3MB`，格式 `JPG/JPEG/PNG`。
- 标题和属性仍然重要，图片不能代替属性填写。

执行口径：

- 默认一套图：1 张 `1:1` 方形封面 + 12 张 `3:4`。
- 控制文字密度，避免压缩后手机端不可读。
- 所有图片事实必须能在产品资料中找到依据。

## Amazon

来源：

- <https://sell.amazon.com/blog/product-photos>
- <https://sellercentral.amazon.com/seller-forums/discussions/t/13af96ea-6b07-4bf9-8dbe-a13292c2e3b1>
- <https://images-na.ssl-images-amazon.com/images/G/01/rainier/help/Home_Garden_and_Pets-Style_Guide.pdf>

主图要点：

- 真实产品、清晰、专业布光。
- 主体大，纯白背景。
- 不放文字、图标、水印、价格、促销标签。
- 不放未售卖配件。
- 不用插画或占位图。

二级图要点：

- 可展示场景、细节、尺寸、使用方式、图文说明。
- 必须和标题/卖点一致。
- 可用道具帮助解释尺寸和使用，但不能误导。

执行口径：

- 即使目标是 SHEIN，也保留 Amazon 级白底主图思维作为合规底线。
- aggressive 的场景/文案只放在二级图，不污染主封面安全版。

## noon

来源：<https://support.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024>

要点：

- 建议至少 3 张高质量图，展示角度、尺寸、纹理/材质。
- 主图优先正面、纯白背景；非服装类不使用生活方式图当主图。
- 主图不展示包装盒、价格、硬阴影、水印、seller logo。
- 额外图必须和标题/描述一致，不展示未包含配件。
- 推荐顺序：正面、背面、侧面、其他角度、细节、使用。

执行口径：

- 13 张套图里必须覆盖角度、细节、使用和参数，不要全做氛围图。
- close-up 可以用于二级图，主图必须完整。

## Temu

说明：当前未找到稳定公开的官方图片规范。后续接入 Temu Seller Center 时，以后台规则为准。

弱证据趋势：

- 移动端缩略图竞争强，主体要大、明亮、直接。
- 白底或浅背景主图更稳。
- 二级图用尺寸、场景、细节、功能图建立信任。

执行口径：

- 可借鉴“主体大、卖点直接、移动端强识别”。
- 不使用 Temu 竞品图片中的事实作为本品事实。

## 通用禁用项

- 未确认认证。
- 医疗疗效。
- 永久、100%、best、safest、guaranteed 等绝对化表达。
- 价格、限时、折扣。
- 酒精、猪肉、宗教元素。
- 过度暴露或强性暗示。
- 竞品品牌、竞品图、水印。

```


---
## FILE: `skills/ecommerce-product-image-suite/references/image-stack-blueprint.md`

```markdown
# 13 张产品套图蓝图

## 固定结构

| 编号 | 名称 | 比例 | 目标 | 必须包含 |
|---:|---|---|---|---|
| 1 | 3:4 主封面 | 3:4 | 点击 | 产品 C 位、短标题、3-4 个核心卖点 |
| 2 | 1:1 方形封面 | 1:1 | 方图复用 | 产品大、文字更少、缩略图强识别 |
| 3 | 参数规格图 | 3:4 | 降低疑虑 | 尺寸、容量、功率、配件、注意事项 |
| 4 | 核心轮播图 | 3:4 | 快速理解 | 一句话主利益 + 3 个利益点 |
| 5 | 主使用场景图 | 3:4 | 代入 | 高频场景 + 人/手/产品互动 |
| 6 | 第二使用场景图 | 3:4 | 展示多场景 | 与第 5 张不同场景 |
| 7 | 卖点图 1 | 3:4 | 证明最强卖点 | 局部放大/箭头/结果示意 |
| 8 | 卖点图 2 | 3:4 | 证明第二卖点 | 场景 + 短文案 |
| 9 | 细节特写图 | 3:4 | 质感信任 | 按钮、接口、刀头、喷头、杯体等 |
| 10 | 使用步骤图 | 3:4 | 降低上手门槛 | 3-4 步操作 |
| 11 | 尺寸/容量/适用范围图 | 3:4 | 降低预期偏差 | 尺寸线、容量、适用范围 |
| 12 | 痛点解决/对比图 | 3:4 | 强化理由 | before/after 或 pain/solution |
| 13 | 配件/清单/信任图 | 3:4 | 到手清楚 | 随货物品、清单、售后感；默认无包装盒 |

## 每张图都要写

- 产品外观锁定。
- 可用事实。
- 场景和构图。
- 文案层。
- 负向提示词。
- 审核要点。

## 画面优先级

1. 产品清楚。
2. 核心信息清楚。
3. 手机端可读。
4. 风格统一。
5. 好看和吸睛。

不要反过来。

## 场景去重

同一套图里，场景应分层：

- 封面：棚拍/电商视觉。
- 主场景：最强购买场景。
- 第二场景：差异化场景。
- 卖点图：半场景半图解。
- 参数图：信息化。
- 细节图：近距离。

如果 13 张里出现 4 张以上同一厨房角度，判为重复。

```


---
## FILE: `skills/ecommerce-product-image-suite/references/prompt-schema.md`

```markdown
# 提示词输入与输出格式

## 输入 JSON

```json
{
  "products": [
    {
      "sku": "KF-JN-02便携咖啡机",
      "category": "便携咖啡机",
      "stores": ["DL", "DX"],
      "market": "KSA",
      "platform": "SHEIN",
      "reference_policy": "strict_copy_shape_angle",
      "verified_facts": [
        {"claim": "Portable electric espresso machine", "source": "user_template"}
      ],
      "visual_facts": [
        "产品形状、颜色、配件以参考图为准"
      ],
      "candidate_claims": [
        {"claim": "15 bar pressure", "status": "needs_confirmation"}
      ],
      "forbidden_claims": ["BPA-Free", "Safe"],
      "forbidden_visuals": ["包装盒", "宗教元素"],
      "copy_language": ["English", "Arabic_review_required"],
      "notes": "不要出现中文"
    }
  ]
}
```

## 输出 JSON

```json
{
  "sku": "KF-JN-02便携咖啡机",
  "store": "DL",
  "market": "KSA",
  "platform": "SHEIN",
  "facts_used": [],
  "blocked_claims": [],
  "images": [
    {
      "index": 1,
      "name": "3:4 主封面",
      "ratio": "3:4",
      "goal": "提升点击率",
      "prompt": "完整提示词",
      "negative_prompt": "负向提示词",
      "text_overlay": [
        {"text": "Portable Espresso", "status": "ready"},
        {"text": "Arabic line pending review", "status": "needs_review"}
      ],
      "review_checklist": []
    }
  ]
}
```

## Markdown 输出

```markdown
# [店铺] [货号] 13 张产品套图提示词

## 产品事实表

## 禁用项

## 01. 3:4 主封面
- 用途：
- 比例：
- 画面目标：
- 图上文字：
- 提示词：
- 负向提示词：
- 审核要点：
```

## 文字入图规则

- 复杂文字建议后期加，不强迫图片模型直接生成。
- 英文短句可以入图。
- 阿文默认需要人工校对。
- 不要中文。

## 缺失事实处理

遇到缺尺寸、功率、容量、档位：

- 参数图保留字段，但标记 `待确认`。
- 不在提示词中编造数值。
- 在 `blocked_claims` 中提醒补资料。

```


---
## FILE: `skills/ecommerce-product-image-suite/references/category-playbooks.md`

```markdown
# 当前货号类目打法

## 咖啡机

货号示例：`SK-6810半自动意式咖啡机`、`SK-6863半自动意式咖啡机`、`SK-04031胶囊咖啡机`、`KF-JN-02便携咖啡机`。

核心场景：

- 早晨厨房。
- 办公桌。
- 露营/RV。
- 车内或差旅。

常用卖点：

- 便携、兼容、冷热、Type-C、办公室/露营/旅行。
- 只在事实确认后使用压力、容量、温度、萃取时间等参数。

禁忌：

- 不写 `BPA-Free`、`Safe`，除非用户重新确认允许且有证据。
- 不展示酒精、宗教元素。

## 电动缝纫机

货号示例：`SM-505A电动缝纫机`、`SM-520A电动缝纫机`。

核心场景：

- 家庭修补。
- DIY 手作。
- 桌面学习。
- 裤脚/窗帘/布艺小物。

常用卖点：

- 新手友好、便携、双速、脚踏、灯光、线迹、配件。

禁忌：

- 不展示工业厚料或皮革，除非确认可缝。
- 不承诺专业工业级。

## 吸尘器

货号示例：`SK-3378杆式吸尘器`、`SK-13034杆式吸尘器`。

核心场景：

- 客厅地面。
- 沙发缝隙。
- 车内。
- 宠物毛发场景需先确认适用。

常用卖点：

- 轻便、刷头、尘杯、角落清洁、续航、过滤。

禁忌：

- 不承诺除螨、杀菌、医用级。

## 蒸汽熨烫机

货号示例：`SK-GT-3065蒸汽熨烫机`、`SK-11004蒸汽熨烫机`、`SK-11041蒸汽熨烫机`。

核心场景：

- 上班前快速整理衣服。
- 旅行箱旁。
- 衣柜挂烫。

常用卖点：

- 快速、便携、蒸汽、适用多种面料、水箱。

禁忌：

- before/after 必须标示为视觉示意，不伪造极端效果。

## 绞肉机/料理机

货号示例：`SK-7025A绞肉机`、`SK-7027绞肉机`、`SK-999食品料理机`。

核心场景：

- 家庭备餐。
- 肉馅、蔬菜碎、酱料。
- 清洗拆装。

常用卖点：

- 容量、刀片、效率、易清洁、多食材。

禁忌：

- 沙特市场默认不要出现猪肉。
- 不展示未确认可处理的硬食材。

## 早餐机/空气炸锅

货号示例：`KJ-102三明治机和早餐机`、`SK-223三明治机和早餐机`、`JD-389空气炸锅`。

核心场景：

- 早餐桌。
- 家庭厨房。
- 周末小食。
- 聚会小食。

常用卖点：

- 快速、少油、酥脆、多场景、易清洁。

禁忌：

- 健康表达要克制，不说治疗、减肥、绝对健康。
- 不出现猪肉/酒精。

## 个护

货号示例：`FZ-666颈部按摩器`、`BHRL-09激光脱毛仪`、`SK-1914热风梳`。

核心场景：

- 办公室。
- 明亮卧室。
- 梳妆台。
- 健身后恢复。
- 差旅车内。

常用卖点：

- 舒适、放松、多档位、便携、造型效果。

禁忌：

- 不医疗化。
- 不说永久、无痛、100%。
- 人物服装保持合规。

## 制冷/水壶

货号示例：`PA4-6L便携式冰箱`、`S1810电热水壶`、`SK-03038制冰机`。

核心场景：

- 家庭厨房。
- 办公室。
- 露营/车载。
- 夏季饮品。

常用卖点：

- 容量、速度、便携、冷热/制冰、适用场景。

禁忌：

- 不夸大制冰速度、保温时长、温度范围。
- 不出现酒精饮品。

```


---
## FILE: `skills/ecommerce-product-image-suite/references/reviewer-rubric.md`

```markdown
# 提示词 reviewer 评分标准

满分 100。

## 评分维度

| 维度 | 分值 | 检查问题 |
|---|---:|---|
| 产品事实准确 | 25 | 是否只用了 verified_facts / visual_facts；是否改外观；是否混入竞品参数 |
| 平台与市场合规 | 20 | 是否符合比例、主图/二级图边界、沙特文化、无禁用元素 |
| 图像可执行性 | 15 | 单张图目标是否清楚；场景是否可画；构图是否具体 |
| 转化力 | 15 | 是否一眼能看懂；是否有痛点/利益点；封面是否吸睛 |
| 信息分工 | 10 | 13 张图是否互补；是否重复 |
| 手机端可读性 | 10 | 文字是否短；主体是否大；对比是否清楚 |
| 可维护性 | 5 | 输出是否结构化；是否便于批量和网站接入 |

## 一票否决

出现以下任一项，整套或单图标记为 `fail`：

- 产品形状、颜色、部件被改。
- 使用未确认参数或认证。
- 把竞品独有卖点写成本品事实。
- 使用用户明确禁用词。
- 出现宗教、酒精、猪肉、过度暴露、强性暗示。
- 阿文/英文乱码严重但仍要求直接入图。
- 展示未随货配件或包装盒，且用户未允许。

## reviewer 输出格式

```markdown
# 提示词评分

## 总分
- 分数：
- 结论：pass / revise / fail

## 主要问题
1.
2.
3.

## 单图评分
| 编号 | 分数 | 主要问题 | 修改建议 |
|---:|---:|---|---|

## 事实风险
- 未确认卖点：
- 可能混入竞品的信息：
- 需要用户补资料：

## 推荐修改后优先重跑
- 图片编号：
- 原因：
```

```


---
## FILE: `scripts/product-image-suite/generate_prompt_suite.mjs`

```js
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
  '便携咖啡机': ['modern office desk', 'car travel cup holder', 'bright camping table', 'RV morning coffee scene'],
  '半自动意式咖啡机': ['bright kitchen countertop', 'premium home cafe corner', 'morning breakfast bar'],
  '胶囊咖啡机': ['small apartment kitchen', 'office pantry', 'clean countertop with capsules only if included'],
  '电动缝纫机': ['DIY craft desk', 'home clothing repair table', 'beginner sewing learning scene'],
  '杆式吸尘器': ['bright living room floor', 'sofa gap cleaning', 'car interior cleaning'],
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
  return `以用户上传的参考图为唯一产品外观依据（${policy}）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。${visual ? `已知视觉事实：${visual}。` : ''}`;
}

function negativePrompt(product) {
  const base = [
    'no Chinese text',
    'no packaging box unless explicitly allowed',
    'no religious elements, mosque patterns or religious symbols',
    'no alcohol or pork',
    'no excessive exposure or sexualized pose',
    'no unverified certification or medical claim',
    'no price, discount, seller logo, watermark or marketplace badge',
    'do not change product shape, color, parts, angle or accessories',
    'do not add accessories not included with the product',
    'no distorted text or unreadable typography'
  ];
  const forbiddenClaims = product.forbidden_claims || [];
  const forbiddenVisuals = product.forbidden_visuals || [];
  return [...base, ...forbiddenClaims.map((x) => `do not use claim: ${x}`), ...forbiddenVisuals.map((x) => `do not show: ${x}`)].join('; ');
}

function promptFor(slot, product, store) {
  const factList = claims(product);
  const scenes = categoryScenes(product);
  const scene = scenes[(slot.index - 1) % scenes.length];
  const copy = textOverlay(slot, factList);
  const lock = exteriorLock(product);
  const factText = factList.length ? factList.join('; ') : 'No verified selling points provided; use only visual product reference and leave claims pending.';
  const platform = product.platform || 'SHEIN';
  const market = product.market || 'KSA';
  const languageRule = (product.copy_language || ['English']).join(', ');

  let layout = 'bright, clean, mobile-first ecommerce composition, product as the largest visual anchor';
  if (slot.key === 'cover_3x4') layout = 'high-conversion 3:4 ecommerce hero cover, product in the center, 3 to 4 small icon callouts, large readable English headline';
  if (slot.key === 'cover_1x1') layout = 'square ecommerce cover, product fills the frame, minimal text, strong thumbnail readability';
  if (slot.key === 'specs') layout = 'clean infographic specification layout with neat cards, dimension lines and verified parameter fields; mark unknown fields as pending instead of inventing values';
  if (slot.key === 'detail_closeup') layout = 'macro close-up collage with 2 to 3 inset detail windows, crisp arrows, no fake internal parts';
  if (slot.key === 'steps') layout = 'three-step usage guide with simple icons and short English labels, no unverified operation step';
  if (slot.key === 'pain_solution') layout = 'pain-point and solution visual comparison, clearly marked as visual demonstration, no exaggerated result';

  return {
    index: slot.index,
    key: slot.key,
    name: slot.name,
    ratio: slot.ratio,
    goal: slot.goal,
    text_overlay: copy.map((text) => ({ text, language: text.includes('pending') ? 'English' : 'English', status: 'draft_review_required' })),
    prompt: [
      `${slot.ratio} ratio image for ${platform} ${market}, ${slot.name}.`,
      `Goal: ${slot.goal}.`,
      `Product/SKU: ${product.sku}; store: ${store}; category: ${product.category || extractCategory(product.sku)}.`,
      lock,
      `Use only these verified product facts as selling points: ${factText}.`,
      `Scene and composition: ${layout}; use scene direction: ${scene}; keep the product clear, complete and easy to recognize on a phone screen.`,
      `Text overlay: ${copy.join(' | ')}. Text language rule: ${languageRule}. Arabic copy requires human review; if Arabic cannot be rendered cleanly, leave space for post-editing.`,
      `Lighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter.`,
      `Do not let model, food, props or background overpower the product.`
    ].join('\n'),
    negative_prompt: negativePrompt(product),
    review_checklist: [
      '产品外观是否与参考图一致',
      '是否只使用 verified_facts',
      '是否没有禁用词/禁用画面',
      '手机缩略图是否能看清产品和主文案',
      '是否没有展示未随货配件或包装盒'
    ]
  };
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

```


---
## FILE: `inputs/product-image-suite/sample-product-facts.json`

```json
{
  "products": [
    {
      "sku": "KF-JN-02便携咖啡机",
      "category": "便携咖啡机",
      "stores": ["DL", "DX"],
      "market": "KSA",
      "platform": "SHEIN",
      "reference_policy": "strict_copy_shape_angle",
      "verified_facts": [
        {
          "claim": "Portable electric espresso machine",
          "source": "作图模板20251223.docx"
        },
        {
          "claim": "Travel coffee machine, a must-have for camping",
          "source": "作图模板20251223.docx"
        },
        {
          "claim": "Car coffee machine with Type-C interface",
          "source": "作图模板20251223.docx"
        },
        {
          "claim": "Can be heated and used both hot and cold",
          "source": "作图模板20251223.docx"
        },
        {
          "claim": "Compatible with ground coffee and capsule coffee",
          "source": "作图模板20251223.docx"
        },
        {
          "claim": "Suitable for RV, hiking, office and other travel scenarios",
          "source": "作图模板20251223.docx"
        }
      ],
      "visual_facts": [
        "产品本体、部件形状、颜色、角度以用户上传参考图为准",
        "如果无法确定完整长相，不改变参考图中产品形状和方向"
      ],
      "candidate_claims": [
        {
          "claim": "具体容量、水箱大小、电池容量、萃取压力、加热温度",
          "status": "needs_user_confirmation"
        }
      ],
      "forbidden_claims": ["BPA-Free", "Safe"],
      "forbidden_visuals": ["包装盒", "宗教元素", "清真寺图案", "戴头巾的宗教化男性形象", "中文文字", "酒精"],
      "copy_language": ["English", "Arabic_review_required"],
      "notes": "面向沙特市场；除 1:1 封面外全部 3:4；不要改变产品外观。"
    }
  ]
}

```


---
## FILE: `outputs/product-image-suite/prompts/DL_KF-JN-02便携咖啡机_20260509_image-suite-prompts.json`

```json
{
  "sku": "KF-JN-02便携咖啡机",
  "category": "便携咖啡机",
  "store": "DL",
  "market": "KSA",
  "platform": "SHEIN",
  "generated_at": "2026-05-09T09:52:28.639Z",
  "facts_used": [
    "Portable electric espresso machine [作图模板20251223.docx]",
    "Travel coffee machine, a must-have for camping [作图模板20251223.docx]",
    "Car coffee machine with Type-C interface [作图模板20251223.docx]",
    "Can be heated and used both hot and cold [作图模板20251223.docx]",
    "Compatible with ground coffee and capsule coffee [作图模板20251223.docx]",
    "Suitable for RV, hiking, office and other travel scenarios [作图模板20251223.docx]"
  ],
  "blocked_claims": [
    {
      "claim": "具体容量、水箱大小、电池容量、萃取压力、加热温度",
      "status": "needs_user_confirmation"
    }
  ],
  "forbidden_claims": [
    "BPA-Free",
    "Safe"
  ],
  "forbidden_visuals": [
    "包装盒",
    "宗教元素",
    "清真寺图案",
    "戴头巾的宗教化男性形象",
    "中文文字",
    "酒精"
  ],
  "images": [
    {
      "index": 1,
      "key": "cover_3x4",
      "name": "3:4 主封面",
      "ratio": "3:4",
      "goal": "提升点击率，让买家第一眼理解产品核心价值",
      "text_overlay": [
        {
          "text": "Main benefit headline in English",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Portable electric espresso machine",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Travel coffee machine, a must-have for camping",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Car coffee machine with Type-C interface",
          "language": "English",
          "status": "draft_review_required"
        }
      ],
      "prompt": "3:4 ratio image for SHEIN KSA, 3:4 主封面.\nGoal: 提升点击率，让买家第一眼理解产品核心价值.\nProduct/SKU: KF-JN-02便携咖啡机; store: DL; category: 便携咖啡机.\n以用户上传的参考图为唯一产品外观依据（strict_copy_shape_angle）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。已知视觉事实：产品本体、部件形状、颜色、角度以用户上传参考图为准；如果无法确定完整长相，不改变参考图中产品形状和方向。\nUse only these verified product facts as selling points: Portable electric espresso machine; Travel coffee machine, a must-have for camping; Car coffee machine with Type-C interface; Can be heated and used both hot and cold; Compatible with ground coffee and capsule coffee; Suitable for RV, hiking, office and other travel scenarios.\nScene and composition: high-conversion 3:4 ecommerce hero cover, product in the center, 3 to 4 small icon callouts, large readable English headline; use scene direction: modern office desk; keep the product clear, complete and easy to recognize on a phone screen.\nText overlay: Main benefit headline in English | Portable electric espresso machine | Travel coffee machine, a must-have for camping | Car coffee machine with Type-C interface. Text language rule: English, Arabic_review_required. Arabic copy requires human review; if Arabic cannot be rendered cleanly, leave space for post-editing.\nLighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter.\nDo not let model, food, props or background overpower the product.",
      "negative_prompt": "no Chinese text; no packaging box unless explicitly allowed; no religious elements, mosque patterns or religious symbols; no alcohol or pork; no excessive exposure or sexualized pose; no unverified certification or medical claim; no price, discount, seller logo, watermark or marketplace badge; do not change product shape, color, parts, angle or accessories; do not add accessories not included with the product; no distorted text or unreadable typography; do not use claim: BPA-Free; do not use claim: Safe; do not show: 包装盒; do not show: 宗教元素; do not show: 清真寺图案; do not show: 戴头巾的宗教化男性形象; do not show: 中文文字; do not show: 酒精",
      "review_checklist": [
        "产品外观是否与参考图一致",
        "是否只使用 verified_facts",
        "是否没有禁用词/禁用画面",
        "手机缩略图是否能看清产品和主文案",
        "是否没有展示未随货配件或包装盒"
      ]
    },
    {
      "index": 2,
      "key": "cover_1x1",
      "name": "1:1 方形封面",
      "ratio": "1:1",
      "goal": "用于方图、广告位或跨平台复用，缩略图也要清楚",
      "text_overlay": [
        {
          "text": "Clear product name",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Portable electric espresso machine",
          "language": "English",
          "status": "draft_review_required"
        }
      ],
      "prompt": "1:1 ratio image for SHEIN KSA, 1:1 方形封面.\nGoal: 用于方图、广告位或跨平台复用，缩略图也要清楚.\nProduct/SKU: KF-JN-02便携咖啡机; store: DL; category: 便携咖啡机.\n以用户上传的参考图为唯一产品外观依据（strict_copy_shape_angle）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。已知视觉事实：产品本体、部件形状、颜色、角度以用户上传参考图为准；如果无法确定完整长相，不改变参考图中产品形状和方向。\nUse only these verified product facts as selling points: Portable electric espresso machine; Travel coffee machine, a must-have for camping; Car coffee machine with Type-C interface; Can be heated and used both hot and cold; Compatible with ground coffee and capsule coffee; Suitable for RV, hiking, office and other travel scenarios.\nScene and composition: square ecommerce cover, product fills the frame, minimal text, strong thumbnail readability; use scene direction: car travel cup holder; keep the product clear, complete and easy to recognize on a phone screen.\nText overlay: Clear product name | Portable electric espresso machine. Text language rule: English, Arabic_review_required. Arabic copy requires human review; if Arabic cannot be rendered cleanly, leave space for post-editing.\nLighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter.\nDo not let model, food, props or background overpower the product.",
      "negative_prompt": "no Chinese text; no packaging box unless explicitly allowed; no religious elements, mosque patterns or religious symbols; no alcohol or pork; no excessive exposure or sexualized pose; no unverified certification or medical claim; no price, discount, seller logo, watermark or marketplace badge; do not change product shape, color, parts, angle or accessories; do not add accessories not included with the product; no distorted text or unreadable typography; do not use claim: BPA-Free; do not use claim: Safe; do not show: 包装盒; do not show: 宗教元素; do not show: 清真寺图案; do not show: 戴头巾的宗教化男性形象; do not show: 中文文字; do not show: 酒精",
      "review_checklist": [
        "产品外观是否与参考图一致",
        "是否只使用 verified_facts",
        "是否没有禁用词/禁用画面",
        "手机缩略图是否能看清产品和主文案",
        "是否没有展示未随货配件或包装盒"
      ]
    },
    {
      "index": 3,
      "key": "specs",
      "name": "参数规格图",
      "ratio": "3:4",
      "goal": "解释尺寸、容量、功率、配件、使用注意事项，降低疑虑",
      "text_overlay": [
        {
          "text": "Dimensions: pending if not verified",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Power/Capacity: pending if not verified",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Accessories: only if included",
          "language": "English",
          "status": "draft_review_required"
        }
      ],
      "prompt": "3:4 ratio image for SHEIN KSA, 参数规格图.\nGoal: 解释尺寸、容量、功率、配件、使用注意事项，降低疑虑.\nProduct/SKU: KF-JN-02便携咖啡机; store: DL; category: 便携咖啡机.\n以用户上传的参考图为唯一产品外观依据（strict_copy_shape_angle）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。已知视觉事实：产品本体、部件形状、颜色、角度以用户上传参考图为准；如果无法确定完整长相，不改变参考图中产品形状和方向。\nUse only these verified product facts as selling points: Portable electric espresso machine; Travel coffee machine, a must-have for camping; Car coffee machine with Type-C interface; Can be heated and used both hot and cold; Compatible with ground coffee and capsule coffee; Suitable for RV, hiking, office and other travel scenarios.\nScene and composition: clean infographic specification layout with neat cards, dimension lines and verified parameter fields; mark unknown fields as pending instead of inventing values; use scene direction: bright camping table; keep the product clear, complete and easy to recognize on a phone screen.\nText overlay: Dimensions: pending if not verified | Power/Capacity: pending if not verified | Accessories: only if included. Text language rule: English, Arabic_review_required. Arabic copy requires human review; if Arabic cannot be rendered cleanly, leave space for post-editing.\nLighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter.\nDo not let model, food, props or background overpower the product.",
      "negative_prompt": "no Chinese text; no packaging box unless explicitly allowed; no religious elements, mosque patterns or religious symbols; no alcohol or pork; no excessive exposure or sexualized pose; no unverified certification or medical claim; no price, discount, seller logo, watermark or marketplace badge; do not change product shape, color, parts, angle or accessories; do not add accessories not included with the product; no distorted text or unreadable typography; do not use claim: BPA-Free; do not use claim: Safe; do not show: 包装盒; do not show: 宗教元素; do not show: 清真寺图案; do not show: 戴头巾的宗教化男性形象; do not show: 中文文字; do not show: 酒精",
      "review_checklist": [
        "产品外观是否与参考图一致",
        "是否只使用 verified_facts",
        "是否没有禁用词/禁用画面",
        "手机缩略图是否能看清产品和主文案",
        "是否没有展示未随货配件或包装盒"
      ]
    },
    {
      "index": 4,
      "key": "carousel_core",
      "name": "核心轮播图",
      "ratio": "3:4",
      "goal": "用一屏讲清 3 个最核心购买理由",
      "text_overlay": [
        {
          "text": "Portable electric espresso machine",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Travel coffee machine, a must-have for camping",
          "language": "English",
          "status": "draft_review_required"
        },
        {
          "text": "Car coffee machine with Type-C interface",
          "language": "English",
          "status": "draft_review_required"
        }
      ],
      "prompt": "3:4 ratio image for SHEIN KSA, 核心轮播图.\nGoal: 用一屏讲清 3 个最核心购买理由.\nProduct/SKU: KF-JN-02便携咖啡机; store: DL; category: 便携咖啡机.\n以用户上传的参考图为唯一产品外观依据（strict_copy_shape_angle）。保持产品本体、配件、按钮、接口、颜色、比例、材质观感和可见角度一致；不要改变产品形状，不要发明参考图中不可见的结构。已知视觉事实：产品本体、部件形状、颜色、角度以用户上传参考图为准；如果无法确定完整长相，不改变参考图中产品形状和方向。\nUse only these verified product facts as selling points: Portable electric espresso machine; Travel coffee machine, a must-have for camping; Car coffee machine with Type-C interface; Can be heated and used both hot and cold; Compatible with ground coffee and capsule coffee; Suitable for RV, hiking, office and other travel scenarios.\nScene and composition: bright, clean, mobile-first ecommerce composition, product as the largest visual anchor; use scene direction: RV morning coffee scene; keep the product clear, complete and easy to recognize on a phone screen.\nText overlay: Portable electric espresso machine | Travel coffee machine, a must-have for camping | Car coffee machine with Type-C interface. Text language rule: English, Arabic_review_required. Arabic copy requires human review; if Arabic cannot be rendered cleanly, leave space for post-editing.\nLighting and style: bright, high clarity, clean commercial photography, accurate colors, no dark muddy tone, no clutter.\nDo not let model, food, props or background overpower the product.",
      "negative_prompt": "no Chinese text; no packaging box unless explicitly allowed; no religious elements, mosque patterns or religious symbols; no alcohol or pork; no excessive exposure or sexualized pose; no unverified certification or medical claim; no price, discount, seller logo, watermark or marketplace badge; do not change product shape, color, parts, angle or accessories; do not add accessories not included with the product; no distorted text or unreadable typography; do not use claim: BPA-Free; do not use claim: Safe; do

[TRUNCATED generated sample output]

```

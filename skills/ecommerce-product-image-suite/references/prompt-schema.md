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
      "secondary_markets": ["EU"],
      "platform": "SHEIN",
      "reference_policy": "strict_copy_shape_angle",
      "verified_facts": [
        {"claim": "Portable electric espresso machine", "source": "user_template"}
      ],
      "visual_facts": [
        "产品形状、颜色、配件以参考图/厂家图为准"
      ],
      "reference_images": [
        {"path_or_url": "厂家参考图路径或链接", "role": "外观/配件/细节", "notes": "可确认的信息"}
      ],
      "store_style_profile": {
        "style_name": "店铺风格名",
        "visual_mood": "Gemini式明亮时尚大片/高级性感/明亮爆款/轻奢等",
        "color_palette": "主色调",
        "model_style": "模特气质、性感尺度和露肤边界",
        "background_style": "背景、布光、道具"
      },
      "candidate_claims": [
        {"claim": "15 bar pressure", "status": "needs_confirmation"}
      ],
      "forbidden_claims": ["BPA-Free", "Safe"],
      "forbidden_visuals": ["包装盒", "宗教元素"],
      "copy_language": ["English", "Arabic"],
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
      "platform_rule": "Amazon/noon 主图白底安全规则；不适用时为 null",
      "render_mode": "model_rendered_text_with_overlay_metadata_review",
      "overlay_metadata": {
        "render_policy": "model_text_allowed_with_review",
        "warning": "图像模型可直接生成文字，但必须逐字复核；错误时再后期修正",
        "items": [
          {"text": "Portable Espresso", "status": "draft_review_required", "suggested_position": "top_protected_zone"}
        ]
      },
      "text_overlay": [
        {"text": "Portable Espresso", "status": "ready"},
        {"text": "سطر عربي للمراجعة", "status": "arabic_review_required"}
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

- 图像模型可以直接生成最终文字，包括英文短句、参数、数字、单位、品牌/型号、阿文和小字号。
- 英文和阿文同等重要；Codex 负责阿文翻译与校对，可调用 reviewer/子代理复核。
- `overlay_metadata` 是复核清单：成图后必须逐字比对，避免 `15 Bar`、`Type-C`、容量、功率、尺寸、阿文含义等出错。
- 如果图像模型生成的文字不准确、不清晰或排版不稳，再重生成或用后期排版工具修正。
- 不要中文。

## 平台主图规则

- 当前默认只服务 SHEIN 沙特/欧洲；Amazon / noon / Temu 仅作为视觉经验参考。
- 只有用户明确要求输出 Amazon / noon / Temu 版本时，才启用对应平台主图规则，例如白底主图、无文字、无生活方式场景。
- 所有平台都要保留主体保护区，便于 `3:4` 裁切到 `1:1` 时不切掉产品。

## 缺失事实处理

遇到缺尺寸、功率、容量、档位：

- 参数图保留字段，但标记 `待确认`。
- 不在提示词中编造数值。
- 在 `blocked_claims` 中提醒补资料。


## 整套模式输出

除逐张 `images[]` 外，可额外输出：

```json
{
  "suite_prompt": "一段可一次性喂给多图工具的总控提示词",
  "per_image_prompts": ["第 1 张", "第 2 张", "...", "第 13 张"]
}
```

`suite_prompt` 必须说明：同一产品外观、同一店铺风格、同一色调、同一视觉质量；除第 2 张为 `1:1` 外，其余 `3:4`；英阿双语同等重要；可使用厂家参考图；人物可使用 Gemini 式明亮时尚大片和更强性感流量风，但不能色情低俗，产品必须是主角。


## Gemini 式细化字段

重点图建议额外输出或在 `prompt` 内显式分段：

- `visual_subject`：产品在画面中的位置、大小、光效、使用部位。
- `model_and_styling`：人物、发型、妆容、服装材质、性感尺度、动作表情。
- `scene_and_atmosphere`：具体生活场景、光线、色调、道具、情绪。
- `composition_and_text`：构图、留白、文案位置、英阿双语文案。

性感流量图可写到深领口、露肩、锁骨、上背线条、贴身真丝/罗纹面料、直视镜头、微张嘴唇等可执行细节；禁止露点、透视裸露、明显性行为姿势、色情低俗和人物压过产品。

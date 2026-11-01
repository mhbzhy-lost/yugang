---
name: model
description: 查看或切换各类能力使用的模型（main/vision/image）；只有主人能切换，切换写盘后重启进程生效。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["list", "switch"],
        "description": "list 看当前角色和可用模型；switch 切换某个角色的模型"
      },
      "role": {
        "type": "string",
        "enum": ["main", "vision", "image"],
        "description": "switch 必填：main 主对话 / vision 看图看视频 / image 在线画图"
      },
      "provider": {
        "type": "string",
        "description": "switch 必填：config/models.json 里 providers 的名字"
      },
      "model": {
        "type": "string",
        "description": "switch 必填：该 provider 下的模型 id；image 可写任意图片模型名"
      }
    },
    "required": ["action"]
  }
}
---end-tool-schema

---tool-messages
model_list_prefix: 当前模型：
model_list_available: 可切换的 provider / 模型：
model_image_hint: image 是图片透传通道，模型名不校验
model_switch_missing: switch 需要 role、provider、model 三个参数
model_bad_role: role 只能是 main / vision / image
model_unknown_provider: providers 里没有 {{provider}}；现有：{{providers}}
model_unknown_model: {{provider}} 没有模型 {{model}}；可用：{{models}}
model_write_failed: 写 config/models.json 失败：{{error}}
model_bad_json: config/models.json 解析失败：{{error}}
model_switch_done: 已切换 {{role}} → {{provider}}/{{model}}，restart 后生效
---end-tool-messages

查看和切换你自己各类能力使用的模型。

只在主人明确要求换模型时用；`list` 可以随时看。切换只改 `config/models.json` 的
`models` 角色表，写盘后重启进程才生效。provider 与 model 必须来自 `list` 的结果，
别自己拼一个不存在的名字。image 是图片通道，模型名不校验。

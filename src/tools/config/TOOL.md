---
name: config
description: 查看或修改自己的运行配置：fish.config.json 受控字段与 config/models.json 角色表；只有主人在私聊里能用，标「需重启」的改动要重启进程才生效。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["read", "set", "models_list", "models_switch"],
        "description": "read 看两边配置现状；set 改 fish.config.json 的一个受控字段；models_list 看角色表和可用模型；models_switch 切换某个角色的模型"
      },
      "field": {
        "type": "string",
        "description": "set 必填：fish.config.json 的受控字段名，只认下面字段表里的白名单"
      },
      "value": {
        "description": "set 必填：字段新值，类型随字段（数值 / 布尔 / 字符串 / 对象），见字段表"
      },
      "role": {
        "type": "string",
        "enum": ["main", "vision", "image"],
        "description": "models_switch 必填：main 主对话 / vision 看图看视频 / image 在线画图"
      },
      "provider": {
        "type": "string",
        "description": "models_switch 必填：config/models.json 里 providers 的名字"
      },
      "model": {
        "type": "string",
        "description": "models_switch 必填：该 provider 下的模型 id；image 可写任意图片模型名"
      }
    },
    "required": ["action"]
  }
}
---end-tool-schema

---tool-messages
config_locked: 这个工具只能在主人的私聊里用
config_read_config_header: fish.config.json 受控字段（当前生效值）：
config_read_models_header: config/models.json 角色表（当前值）：
config_read_problems: 配置告警：{{problems}}
config_effect_hot: 热加载
config_effect_restart: 需重启
config_unknown_field: {{field}} 不在受控字段白名单里，可选字段见工具说明的字段表
config_bad_value: {{field}} 的值不合法：{{reason}}
config_read_failed: 现在的 fish.config.json 读不了，先让主人修复再改：{{error}}
config_write_failed: 写 fish.config.json 失败：{{error}}
config_set_done: 已把 {{field}} 改成 {{value}}（{{effect}}）
config_restart_reminder: 这项要重启进程才生效，记得提醒主人用 restart
models_list_prefix: 当前模型：
models_list_available: 可切换的 provider / 模型：
models_image_hint: image 是图片透传通道，模型名不校验
models_switch_missing: models_switch 需要 role、provider、model 三个参数
models_bad_role: role 只能是 main / vision / image
models_unknown_provider: providers 里没有 {{provider}}；现有：{{providers}}
models_unknown_model: {{provider}} 没有模型 {{model}}；可用：{{models}}
models_write_failed: 写 config/models.json 失败：{{error}}
models_bad_json: config/models.json 解析失败：{{error}}
models_switch_done: 已切换 {{role}} → {{provider}}/{{model}}，restart 后生效
---end-tool-messages

查看和修改你自己的运行配置，两个能力：fish.config.json 的行为参数、config/models.json 的模型角色表。
只有主人在私聊里发起的轮次才能用，群里调用一律被拒。

- `read`：一次看清两边现状——受控字段的当前生效值（含生效时机）和角色表现状。
- `set`：改 fish.config.json 的一个受控字段，field + value 都必填；只认下面字段表的白名单，
  表外字段和不合法的值都会被拒绝、不落盘。
- `models_list` / `models_switch`：看或切 models 角色表（main / vision / image）；provider 与 model
  必须来自 `models_list` 的结果，别自己拼一个不存在的名字；image 是图片透传通道，模型名不校验。

主人没让改就别自己动。改完回话说清楚改了什么、什么时候生效；标「需重启」的字段
要提醒主人调 restart。每次改动都会留审计日志。

fish.config.json 受控字段白名单（生效时机逐字段标注）：

| 字段 | 类型 | 生效时机 | 说明与取值 |
| --- | --- | --- | --- |
| engagement | 字符串 | 热加载 | 搭话总开关，只认 legacy / next；next 的生效范围还叠加 engage.groups 白名单（开关 & 白名单双闸） |
| engage | 对象 | 热加载 | 自由交流窗口参数，只认八个键：closedMinutes 1–240（closed 分钟）、openMinutes 1–120（open 分钟）、windowSize 1–100（开窗积压注入上限）、mentionContextSize 1–30（@ 轮背景条数）、silenceThreshold 1–50（连续零出口 nudge 阈值）、windowRelaxCap 10–100（零出口超阈值后的积压放宽上限）、shardSeconds 5–120（open 态分片节拍，秒）、groups（群号字符串数组，白名单语义：engagement=next 只对这些群生效，空数组 = 任何群都不进 next，fail-safe）；未知键告警并忽略，全部非法才整块拒绝 |
| ambientMinIntervalSeconds | 数值 | 热加载 | 5–3600，非 @ 消息的最短处理间隔（秒） |
| watchAmbientChance | 数值 | 热加载 | 0–1，特别关注者被搭话的概率 |
| sendPacingSeconds | 数值 | 热加载 | 0–60，出站配速：同会话相邻两条物理消息实际发送的最小间隔（秒），每条消息发送前生效，0 = 关闭 |
| compact | 对象 | 热加载 | 换页阈值：maxEntries 1–5000、maxChars 1000–200000 |
| memeCooldownMinutes | 数值 | 热加载 | 0–240，表情包跨轮冷却（分钟） |
| salvagePlainReply | 布尔 | 热加载 | 必答轮忘调出口工具时的正文兜底开关 |
| voices | 对象 | 热加载 | 人格 → 语音配置：url 必填，referWav / referText / referLanguage / speed（0.5–2）可选 |
| weeklyGroupId | 字符串 | 热加载 | 周报群号（纯数字），空串 = 不发；下次周报触发时按新值执行 |
| thinkingLevel | 字符串 | 需重启 | 思考档位，只认 off / minimal / low / medium / high / xhigh / max |
| toolTimeoutSeconds | 数值 | 需重启 | 5–600，单次工具调用超时（秒） |

---
name: ammo_submit
description: 收弹药入库（仅限逛 B 站的工时轮）：核验 BV、补全卡片、判重后写进弹药库，等开窗分享。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "bvid": {
        "type": "string",
        "pattern": "^BV[0-9A-Za-z]{10}$",
        "description": "候选视频的 BV 号（bili_hot 行尾那格 / bili_video 卡片里的那个）"
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "一两句中文小结：这条讲什么、为什么值得分享（≤60 字，会被机械清洗）"
      },
      "topic": {
        "type": "string",
        "enum": ["二次元", "游戏", "军事", "数码"],
        "description": "内容归类，四选一"
      }
    },
    "required": ["bvid", "summary", "topic"],
    "additionalProperties": false
  }
}
---end-tool-schema

---tool-messages
ammo_submit_not_worker: 现在不是逛 B 站的工时轮，弹药只能在那轮里收
ammo_submit_bad_bvid: 这不是合法的 BV 号（BV + 10 位字母数字）
ammo_submit_bad_summary: summary 不能是空的
ammo_submit_bad_topic: topic 只能是这几个之一：{{topics}}
ammo_submit_view_failed: 这条视频核实不过：{{reason}}
ammo_submit_dup: 这条 BV 已经在弹药库里了（{{bvid}}），换一条
ammo_submit_full: 这一轮的弹药已经收满 {{max}} 条了，到此为止
ammo_submit_ok: 已入库（{{bvid}} {{title}}），到点分享
---end-tool-messages

逛 B 站的工时轮专用（宿主定时起的作业轮）：把你挑中的候选正式收进弹药库。只在
那种轮里可用，平时在群里调它只会被拒。

宿主会替你做的事（你不用也不必重复做）：
- 核对 BV 号形状，经 B 站接口补全标题等卡片字段——标题以宿主核到的为准
- 判重：同一个 BV 不管什么状态都进不了第二次，别重复提交
- 限额：一轮收满配额后再提交会被拒，配额多少作业开始时就定了

你要做的事：summary 用你自己的话写这条视频讲什么、为什么值得分享——它是以后
开窗分享时的推荐语底稿，别抄标题、别抄简介原文。topic 按内容归入四个枚举之一，
拿不准就选最贴近的。

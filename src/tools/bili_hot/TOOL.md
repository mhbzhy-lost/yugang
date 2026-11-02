---
name: bili_hot
description: 逛 B 站拿候选：热门/分区排行榜，营销号标题党已机械筛掉，按你口味挑。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "source": {
        "type": "string",
        "enum": ["popular", "rank"],
        "description": "popular=综合热门（全站滚动更新）；rank=分区排行榜（配合 rid 选分区）"
      },
      "rid": {
        "type": "number",
        "enum": [0, 1, 4, 36, 188, 160, 181, 3, 5, 23],
        "description": "排行榜分区号：0 全站、1 动画、4 游戏、36 知识、188 科技、160 生活、181 影视、3 音乐、5 娱乐、23 电影；缺省 0 全站"
      },
      "limit": {
        "type": "number",
        "minimum": 1,
        "maximum": 20,
        "description": "要几条候选（1-20），缺省 10"
      }
    },
    "required": ["source"],
    "additionalProperties": false
  }
}
---end-tool-schema

---tool-messages
bili_hot_header: 候选（标题|UP|分区|时长|播放/赞/币|发布|简介|BV）：
bili_hot_stats: （候选 {{candidates}} → 入库剔除 {{in_library}} → 硬筛否决 {{hard_veto}} → 软筛淘汰 {{soft_out}} → 返回 {{returned}}）
bili_hot_empty: 这轮榜单筛完是空的，换 source 或 rid 再试
bili_hot_bad_rid: 这个分区号不在列表里，用描述里列的那几个
bili_hot_failed: 榜单没拿到：{{reason}}
---end-tool-messages

逛 B 站用：拿一份当下的候选清单再自己挑。机器已经替你滤过一轮——营销号、标题党、
UC 体、盘点合集、简介导流、AI 号在返回前就被筛掉了，所以列表不长，但剩下的也不
保证都有意思，最后还是按你的口味定。

每一行的格式：标题|UP|分区|时长|播放/赞/币|发布|简介|BV
- 播放/赞/币 是三个数；赞和币相对播放的比例高，通常内容真的立得住
- 发布 是相对时间（比如 3天前）；简介最多 60 字，截断过
- BV 是视频唯一 id，指名哪条、后续深看都用它

source=popular 是全站热门；source=rank 配 rid 看特定分区（数码/搞笑没有独立
排行榜分区号，分别归在科技/生活里）。每次调用都消耗 B 站请求配额，一轮拿一两个
榜单就够，别连刷。挑 1-3 条足够，别把整份清单原样贴进群里；挑中后用你自己的话
讲，别复述简介原文。

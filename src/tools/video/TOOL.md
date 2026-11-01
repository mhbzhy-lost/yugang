---
name: video
description: 看一眼 B 站视频或图文动态：元信息、弹幕摘录和几个时间点的画面描述；一轮最多一次。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "B 站链接：视频链接 / BV 号 / b23.tv 短链 / 图文动态（/opus/...）都行"
      }
    },
    "required": ["url"]
  }
}
---end-tool-schema

---tool-messages
video_invalid: 那不是 B 站视频链接
video_used: 本轮已经看过一个视频了，直接说，别重复看
video_failed: 视频没打开：{{url}}
card_bilibili: [B站视频卡片] {{desc}} {{url}}
card_link: [卡片] {{title}} {{desc}} {{url}}
video_truncated: （视频超过 {{minutes}} 分钟，只看了前 {{minutes}} 分钟）
video_danmaku_header: 弹幕摘录：
video_frames_header: 画面（按时间点）：
video_comments_header: 热评：
---end-tool-messages

看一眼 B 站内容：视频（标题、UP 主、时长、简介、弹幕摘录、几个时间点的画面描述、热评），
或者图文动态（作者、正文、其中配图的描述）。短链 b23.tv 也能直接用，会自动展开。

拿到的是什么、不是什么：
- **有**：元信息、观众在刷什么、几个时间点的画面长什么样（图文动态则是正文 + 配图描述）
- **没有**：完整台词、逐句内容、声音。所以别说成「整段看完了」，
  聊的时候用「看介绍和几张截图」「弹幕都在说」这种说法

超过 30 分钟的视频只看前 30 分钟，返回里会明确标出来，说话时也照实说。

群里有人发视频链接、聊到某个视频时用。一轮最多看一次，
看完用自己的话聊两句就行，别复述返回的原文。

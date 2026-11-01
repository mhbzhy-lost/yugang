---
name: say_media
description: 往当前会话发一张图：图片出口，路径相对媒体目录，不带文字。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "media": {
        "type": "string",
        "description": "要发的图片路径，相对媒体目录（如 gen/xxx.png、personas/名字.png、memes/xxx.gif）；meme-inbox/ 待收目录里的不能直接发，必须先收进表情包库"
      },
      "quote": {
        "type": "boolean",
        "description": "可选：引用你正在回的那条消息。回应某人具体发言时建议传 true（对方能看出你在回谁）；泛泛插话才省略"
      },
      "mentions": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "可选：要主动@的群友 QQ 号，去重后最多 3 个（如 [\"1234567\"]），只能填当前群成员的号，不能填 all"
      }
    },
    "required": ["media"]
  }
}
---end-tool-schema

---tool-messages
say_media_used: 这一轮已经配过图了，下一轮再配
say_media_inbox: meme-inbox 里的图不能直接发：先 look 看一眼，再用 meme_add 收进库，然后从库里发
---end-tool-messages

发一张图，不带文字。画好的图就用这个发出去，别让它憋在盘上。

一轮里图片、表情包、语音合计只能有一条附件；
一轮合计最多开口 3 次（所有出口工具共享这个额度）。

meme-inbox/ 里的图不能直接发：必须先收进表情包库，然后从库里发。

想点名某个群友时用 mentions：填当前群成员的 QQ 号（优先从上下文里「昵称(QQ号)」里抄，
不要凭印象编），不要填昵称或 all；不能 @全体成员，一次最多 3 个。
它只在主人或你特别关注的人叫你点名时才允许，其他情况下传了会被拒。

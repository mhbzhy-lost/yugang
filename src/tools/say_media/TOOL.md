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
      "quoteMsgId": {
        "type": "string",
        "description": "可选：要引用哪条消息，填那行消息开头 [m:…] 里的数字（填裸数字或整个 [m:123] 都行）；只能填本轮上下文里出现过的消息，填了别的会被拒且不占这轮开口额度；不传就不引用"
      },
      "share": {
        "type": "boolean",
        "description": "可选：声明这张图是素材分享（兑现承诺/交付委托结果/分享外部素材）。群里最后一条消息是你自己发的时，只有带 share: true 的发言会被放行"
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

群里最后一条消息是你自己发的时候，不能继续闲聊：只能做素材分享（比如把你答应画的图交出来、
分享外部素材），并且这次调用要带上 share: true；不带 share 会被拒（不占这轮开口额度）。
有新消息进来后限制自动解除。

---
name: say_meme
description: 往当前会话发一张表情包：按关键词从库里挑贴题的图，不带文字。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "meme": {
        "type": "string",
        "description": "表情包关键词，空格分隔多个词（如「无语 敷衍」），自动挑一张贴题的当图发"
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
    "required": ["meme"]
  }
}
---end-tool-schema

---tool-messages
say_meme_cooldown: 表情包刚用过，隔一会儿再翻柜子，这句先用文字说
say_meme_nomatch: 库里没有贴这个关键词的，换个词或者直接用文字
---end-tool-messages

按关键词从表情包库里挑一张贴题的当图发，不带文字。
直接写关键词就行；并列贴题的图随机挑，不会每次同一张。

表情包有跨轮冷却：刚用过就先用文字说，隔一会儿再翻柜子。
一轮里图片、表情包、语音合计只能有一条附件；
一轮合计最多开口 3 次（所有出口工具共享这个额度）。
库里没有贴这个关键词的会以 tool 错误回你，换个词或改用文字。

想点名某个群友时用 mentions：填当前群成员的 QQ 号（优先从上下文里「昵称(QQ号)」里抄，
不要凭印象编），不要填昵称或 all；不能 @全体成员，一次最多 3 个。
它只在主人或你特别关注的人叫你点名时才允许，其他情况下传了会被拒。

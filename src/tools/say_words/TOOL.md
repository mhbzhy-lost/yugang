---
name: say_words
description: 往当前会话说一句话：文字出口，一次一条消息。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "description": "要说的话，一条消息，群里说出口的样子：短、口语、最多两行、不带 markdown"
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
    "required": ["text"]
  }
}
---end-tool-schema

---tool-messages
say_mention_all: 不能@全体成员，只能@具体的人
say_mention_bad: 主动@只能填纯数字 QQ 号（从上下文里的「昵称(QQ号)」抄），不能填昵称或 all
say_mention_too_many: 一次最多@3个人，先挑最该应声的
say_mention_no_trigger: 这一轮不知道是谁在跟你说话，@不了人，先说话
say_mention_private: 私聊里没有@这回事，直接说话就行
say_mention_not_privileged: 主动@只在主人或你特别关注的人叫你点名时才行，这条别@
say_mention_members_missing: 拿不到这个群的成员名单，没法核实要@谁，这条别@
say_mention_not_member: {{userIds}} 不在这个群里，号可能抄错了，先核准再@
---end-tool-messages

用文字说一句话。你产生的任何文字都不会发出去，只有出口工具能把话送出去。

一次调用就是一条消息：想连说两句就调两次，不要拼成一段。
每句都要短、口语、最多两行、不带 markdown；
不要解释你做了什么，不要复述思考过程。

一轮合计最多开口 3 次（所有出口工具共享这个额度），
一句能说完的事别拆开说。

想点名某个群友时用 mentions：填当前群成员的 QQ 号（优先从上下文里「昵称(QQ号)」里抄，
不要凭印象编），不要填昵称或 all；不能 @全体成员，一次最多 3 个。
它只在主人或你特别关注的人叫你点名时才允许，其他情况下传了会被拒。

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
      "quoteMsgId": {
        "type": "string",
        "description": "可选：要引用哪条消息，填那行消息开头 [m:…] 里的数字（填裸数字或整个 [m:123] 都行）；只能填本轮上下文里出现过的消息，填了别的会被拒且不占这轮开口额度；不传就不引用"
      },
      "share": {
        "type": "boolean",
        "description": "可选：声明这条发言是素材分享（兑现承诺/交付委托结果）。群里最后一条消息是你自己发的时，只有带 share: true 或 ammoId 的发言会被放行"
      },
      "ammoId": {
        "type": "string",
        "description": "可选：要分享的外部视频编号（开窗弹药栏里给你的 ammoId，原样填）。分享门开着的窗口才能分享成功，一窗最多一条；填了就代表这条是外部素材分享（深夜时段一律不发）；链接由系统自动附在消息开头，text 只写推荐语、不要自己写链接"
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

群里最后一条消息是你自己发的时候，不能继续闲聊：只能做素材分享——兑现你答应过的事、
交付别人委托的结果、分享外部素材——并且这次调用要带上 share: true（前两类）或
ammoId（外部素材）；不带的发言会被拒（不占这轮开口额度）。有新消息进来后限制自动解除。

分享开窗弹药栏里给的视频时用 ammoId：把弹药栏里那行给的编号原样填进来，text 写你的
推荐语（不要自己写链接，系统会自动附在消息开头）。只有当窗口的分享门开着才发得出去
（门没开、深夜时段、库存里没这条、这一窗已经分享过一条，都会被拒且不占开口额度；
一窗最多分享一条）。

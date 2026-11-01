---
name: look
description: 查看一张群消息里图片的内容并描述成文字；普通一轮最多两张。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "图片引用，就是群里那条消息里中括号写的东西，比如 inbound/ab12.png；导入轮的待收图是 meme-inbox/xxx.png（登记回执会给引用）"
      }
    },
    "required": ["ref"]
  }
}
---end-tool-schema

---tool-messages
look_outside: 只能看群里的图：{{ref}}
look_missing: 找不到这张图：{{ref}}
look_type: 不是图片：{{ref}}
look_used: 本轮已经看过 {{limit}} 张图，这张留到下一轮；别跟用户说识别服务坏了
look_import_used: 这一轮导入的 {{count}} 张已经看完了，先把看过的逐张收进库（meme_add），不要重复看
look_import_seen: 这一轮已经看过这张了，直接 meme_add 收它：{{ref}}
look_inbox_master: 本地待收目录（meme-inbox/）里的图只有主人这一轮导入时才能看：{{ref}}
look_inbox_outside: 这张不在本轮导入清单里，看不了：{{ref}}。先调 meme_import 登记，或者那是上一轮的图（清单已经作废）
look_describe: 看一眼这张图，用两三句话告诉我图里有什么：主体、动作、画风、图上的文字。简洁准确，不要猜测看不到的细节。
look_unstable: 图片描述服务暂时不稳，这次没看成，跟用户说声稍后再试，别硬编图里的内容
look_filtered: 这张图被视觉服务的内容审核拦下了，这张看不了；可以换一张图试试，别硬编图里的内容
look_cmd_off: 看图功能已临时关闭，等模型服务恢复了再让你看，可以告诉对方先用文字描述图片
---end-tool-messages

看一眼群里那张图，然后再决定说什么。

只有真的需要看的时候才调用；不看也能聊就别看。

普通一轮最多看两张。例外只有一个：主人让你导入本地表情包时，先登记待导入清单，
这一轮就能把登记过的图逐张看完（额度就是清单张数，最多 50 张）——那种场合
每张都要单独看一次，看完再打标，不要靠文件名猜图里是什么。

meme-inbox/ 里的图不是普通媒体：不在本轮清单里的一律看不了（清单只活一轮，上一轮的
已经作废），清单里的每张这一轮只看一次，看完就打标收录，别重复看。

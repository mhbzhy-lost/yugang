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
        "description": "图片引用，就是群里那条消息里中括号写的东西，比如 inbound/ab12.png；导入表情包时用 meme_import 返回的 meme-inbox/xxx.png"
      }
    },
    "required": ["ref"]
  }
}
---end-tool-schema

看一眼群里那张图，然后再决定说什么。

只有真的需要看的时候才调用；不看也能聊就别看。

普通一轮最多看两张。例外只有一个：主人让你导入本地表情包时，先用 meme_import
登记，这一轮就能把登记过的图逐张看完（额度就是清单张数，最多 50 张）——那种场合
每张都要单独看一次，看完再打标，不要靠文件名猜图里是什么。

meme-inbox/ 里的图不是普通媒体：不在本轮清单里的一律看不了（清单只活一轮，上一轮的
已经作废），清单里的每张这一轮只看一次，看过就直接 meme_add，别重复看。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。

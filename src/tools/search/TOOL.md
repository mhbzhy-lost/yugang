---
name: search
description: 联网搜索最新信息，只返回标题、链接和摘要；一轮最多一次。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜索关键词，1 到 128 字，支持 site: / lang: 等搜索算子"
      }
    },
    "required": ["query"]
  }
}
---end-tool-schema

---tool-messages
search_query: 关键词得在 1 到 128 字之间
search_nokey: 还没配置搜索凭据，搜不了
search_used: 这一轮搜过了，先用搜到的说话
search_failed: 搜索没成功，换个说法或直接说不知道
---end-tool-messages

搜一下互联网上的最新信息。结果只给标题、链接和摘要，不是完整网页。

群里聊到你不确定的事实、新鲜事、或者有人问「搜一下」的时候才用。
自己的话能接就别搜；一轮最多搜一次，搜完用一两句口语说结论，
别把链接原文一大段贴出来。

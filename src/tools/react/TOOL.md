---
name: react
description: 给刚才那条消息贴一个表情回应，只贴表情不说话。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "emoji": {
        "type": "string",
        "description": "一个表情，比如 124（赞）、178（笑哭）、182（比心）"
      }
    },
    "required": ["emoji"]
  }
}
---end-tool-schema

给刚才那条消息贴一个表情回应，不发文字。

群里冷场、别人在互相聊、或者你只想表示看到了，用这个比说话轻。
不要连着贴同一个表情。

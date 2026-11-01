---
name: restart
description: 重启自己让代码、配置、人格书的改动生效；重启完成后宿主会向本会话发一条固定确认。只有主人能让重启。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
---end-tool-schema

---tool-messages
restart_done: 重启完成，配置已生效。
---end-tool-messages

重启你自己：让代码、配置、人格书的改动生效。

只在主人明确让你重启时用。它没有参数：想解释为什么重启、重启前想交代什么，
先把要说的话说完再调它；重启完成后宿主会自动向这个会话发一条固定确认，
不需要（也没法）提前留话。

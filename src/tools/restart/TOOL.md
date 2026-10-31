---
name: restart
description: 重启自己让代码、配置、人格书的改动生效，可带一句重启后自动补发的话；只有主人能让重启。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "description": "重启后要说的第一句话；给了就存盘，重启完由宿主读出来补发"
      }
    },
    "required": ["message"]
  }
}
---end-tool-schema

重启你自己：让代码、配置、人格书的改动生效。

只在主人明确让你重启时用；重启前先把要说的话说完。
必带 message 参数：一句重启后要自动补发的话，会被存盘、重启完发出来再删掉。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。

---
name: read
description: 读仓库或 /tmp/yugang 草稿区里的一个文件，大文件可分段；只有主人解锁时可用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "仓库内的相对路径（如 prompt/persona.md），或 /tmp/yugang 下的绝对路径"
      },
      "startLine": {
        "type": "number",
        "description": "可选：从第几行开始读（1 起）"
      },
      "endLine": {
        "type": "number",
        "description": "可选：读到第几行（含）"
      }
    },
    "required": ["path"]
  }
}
---end-tool-schema

读一个文件的内容。可以读仓库，也可以读 `/tmp/yugang` 草稿区。

文件大就分段读：给 startLine / endLine，返回的每行前面带行号。
不带行号才整读，超过大小上限会被拒绝——宁可分段也别硬吞。

不在改自己的时候就别用；.env、config/auth.json、node_modules、.git 里的东西读不到。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。

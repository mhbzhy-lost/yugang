---
name: tree
description: 列出工作区（仓库）的目录结构，看清都有什么文件；只有主人解锁时可用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "起始目录，仓库内相对路径，默认根目录"
      },
      "depth": {
        "type": "number",
        "description": "展开层数，1 到 4，默认 2"
      }
    }
  }
}
---end-tool-schema

列出工作区（仓库）的目录结构，看清都有什么文件、该改哪个。

主人让你改自己时先用它定位文件，再 read 看内容、用专门的管理工具动手。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。

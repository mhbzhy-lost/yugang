---
name: tree
description: 列出仓库或 /tmp/yugang 草稿区的目录结构，看清都有什么文件；只有主人解锁时可用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "起始目录：相对路径按仓库解析，绝对路径只认 /tmp/yugang，默认仓库根目录"
      },
      "depth": {
        "type": "number",
        "description": "展开层数，1 到 4，默认 2"
      }
    }
  }
}
---end-tool-schema

列出仓库或 /tmp/yugang 草稿区的目录结构，看清都有什么文件、该改哪个。

主人让你改自己时先用它定位文件，再精读内容、用专门的管理工具动手。

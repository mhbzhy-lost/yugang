---
name: grep
description: 在仓库或 /tmp/yugang 里搜文本，返回「路径:行号:内容」；只有主人解锁时可用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "要搜的正则或普通文本（默认区分大小写）"
      },
      "path": {
        "type": "string",
        "description": "可选：仓库内目录/文件，或 /tmp/yugang 的绝对路径；缺省是仓库根"
      },
      "glob": {
        "type": "string",
        "description": "可选：文件名过滤，比如 *.ts 或 prompt/**"
      },
      "ignoreCase": {
        "type": "boolean",
        "description": "可选：true 时忽略大小写"
      },
      "limit": {
        "type": "number",
        "description": "可选：最多返回多少条（默认 60，上限 200）"
      }
    },
    "required": ["pattern"]
  }
}
---end-tool-schema

---tool-messages
grep_bad_regex: 正则写错了，检查一下括号和转义
grep_none: 没搜到
grep_done_hint: （结果带行号，可直接按行号精读命中的那一段）
---end-tool-messages

在仓库或 `/tmp/yugang` 草稿区里搜文本，返回「路径:行号:该行内容」。定位代码和文案时先用它，别整文件硬读。

只能在主人让你改自己的时候用；.env、config/auth.json、node_modules、.git 搜不到。
结果带行号，可直接按行号精读命中的那一段。

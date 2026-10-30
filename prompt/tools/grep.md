---
params:
  pattern: 要搜的正则或普通文本（默认区分大小写）
  path: 可选：从哪个目录或文件开始搜，缺省是仓库根
  glob: 可选：文件名过滤，比如 *.ts 或 prompt/**
  ignoreCase: 可选：true 时忽略大小写
  limit: 可选：最多返回多少条（默认 60，上限 200）
---

在仓库里搜文本，返回「相对路径:行号:该行内容」。定位代码和文案时先用它，别整文件硬读。

只能在主人让你改自己的时候用；.env、config/auth.json、node_modules、.git 搜不到。
结果里有行号，拿到之后可以直接用 read 的 startLine/endLine 精读那一段。

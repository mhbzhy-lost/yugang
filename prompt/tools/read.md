---
params:
  path: 仓库内的相对路径，比如 prompt/persona.md 或 src/harness.ts
  startLine: 可选：从第几行开始读（1 起）
  endLine: 可选：读到第几行（含）
---

读一个文件的内容。只能在主人让你改自己的时候用来查看现状。

文件大就分段读：给 startLine / endLine，返回的每行前面带行号，方便接着改。
不带行号才整读，超过大小上限会被拒绝——宁可分段也别硬吞。

不在改自己的时候就别用；.env、config/auth.json、node_modules、.git 里的东西读不到。

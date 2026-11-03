---
name: read
description: 读仓库或 /tmp/yugang 草稿区里的一个文件，大文件可分段；只有主人解锁时可用。
---

读一个文件的内容。可以读仓库，也可以读 `/tmp/yugang` 草稿区。

文件大就分段读：给 startLine / endLine，返回的每行前面带行号。
不带行号才整读，超过大小上限会被拒绝——宁可分段也别硬吞。

不在改自己的时候就别用；.env、config/auth.json、node_modules、.git 里的东西读不到。

---
name: grep
description: 在仓库或 /tmp/yugang 里搜文本，返回「路径:行号:内容」；只有主人解锁时可用。
---

在仓库或 `/tmp/yugang` 草稿区里搜文本，返回「路径:行号:该行内容」。定位代码和文案时先用它，别整文件硬读。

只能在主人让你改自己的时候用；.env、config/auth.json、node_modules、.git 搜不到。
结果带行号，可直接按行号精读命中的那一段。

---
name: meme
description: 群里需要发表情包、或者想看看有哪些表情包分类时用。只在本地表情包目录里挑，不生成、不联网。
---

# 表情包

## 先看有哪些分类

```bash
ls "$YUGANG_MEDIA_ROOT/stickers" 2>/dev/null || echo "还没有表情包目录"
```

## 挑一张

```bash
find "$YUGANG_MEDIA_ROOT/stickers/<分类>" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.gif' -o -name '*.webp' \) | shuf -n 1
```

把输出的绝对路径作为 `say` 的 `media` 发出去，text 配一句话或者留一句极短的。

## 约束

- 同一个群不要连续发同一张（宿主的去重会拦，但别故意撞）
- 没有合适的分类就别硬发，说一句"没图"

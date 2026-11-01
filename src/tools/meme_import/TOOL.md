---
name: meme_import
description: 主人本地批量导入表情包的登记入口：只扫固定 meme-inbox 目录，登记本轮可看的清单。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "cursor": {
        "type": "string",
        "description": "继续游标：上一批最后一张的文件名。第一次不用填"
      }
    }
  }
}
---end-tool-schema

---tool-messages
meme_import_master: 本地表情导入只有主人能开，这一轮不算
meme_import_empty: 待导入目录里没有能收的图片了（只认 jpg/jpeg/png/gif/webp 的直接子文件）
meme_import_nodir: 还没有 meme-inbox 这个待导入目录，先把图放进 <MEDIA_ROOT>/meme-inbox/
meme_import_denied: meme-inbox 打不开（权限不对或者不是目录），先检查一下再导入
meme_import_linkdir: meme-inbox 本身是个符号链接，那就不算固定目录了，先改成真目录
meme_import_list: 这一批登记了 {{count}} 张，只能逐张 look、逐张用 meme_add 收，别靠文件名猜内容：
meme_import_more: 目录里还有 {{rest}} 张，这一批处理完再调一次 meme_import，cursor 填 {{cursor}}
meme_import_skipped: 跳过了 {{count}} 个不能收的：{{items}}
---end-tool-messages

把本地待收目录里的一批图登记进本轮导入清单。只有主人让你导表情包时才用，
目录是固定的 meme-inbox（不接受任何路径参数，也没有别的读文件手段）。

登记之后，这一批图才允许你看、允许你收。流程是一张一张来：

1. 对清单里的每个引用单独看一次（一次一张，别凭文件名猜内容）
2. 看完结合当前群聊想清楚：这张图在聊天里到底什么意思
3. 再对同一张打标收录，caption 写梗/用途，tags 至少包含一个一级情绪词

没看过就收会被拒绝；看过的那张这一轮也不能重复看。把手上这一批全部看完、
收完，再带着返回的 cursor 调一次拿下一批；不填 cursor 会从这一批重新开始。
一批最多 50 张，一轮里能看的也就 50 张；库里已有的同一张会按内容去重，重复的跳过就行。

清单只属于当前这一轮：换一轮、对话被打断，清单就作废，要重新登记。

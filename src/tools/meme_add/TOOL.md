---
name: meme_add
description: 把一张图收进表情包库并打标；只有主人能让图入库。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "要收进库的图片引用，比如 inbound/1793xxx.jpg（本轮消息里出现的图），或导入轮回执给的 meme-inbox/xxx.png"
      },
      "caption": {
        "type": "string",
        "description": "一句话说清这张图想表达什么（不是画面描述，是它的梗/用途）"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "标签：至少包含一个一级情绪词（词表以系统提示里的表情包词表为准），后面可以再跟 1-3 个自由词"
      }
    },
    "required": ["ref", "caption", "tags"]
  }
}
---end-tool-schema

---tool-messages
meme_add_master: 只有主人能让图长期留在库里，这张不收
meme_add_missing: 找不到这张图：{{ref}}
meme_add_type: 这不是能收的图片类型：{{ref}}
meme_add_caption: 得写一句这张图什么意思，再给几个标签
meme_add_mood: 标签里至少有一个得是一级情绪词（{{moods}}），从里面挑一个最贴的
meme_add_dup: 库里已经有这张了（{{file}}），不用重复收
meme_add_done: 收好了：memes/{{file}}，库里现在 {{count}} 张
meme_add_import_outside: 这张不在本轮导入清单里：{{ref}}。先调 meme_import 登记，或者那是上一轮的图（清单已经作废）
meme_add_not_looked: 这张还没看过就先别收，先 look 看一眼再 meme_add：{{ref}}
meme_add_link: 这是个符号链接，不收（把文件本身放进目录）：{{ref}}
meme_add_big: 这张太大，收不进库：{{ref}}
meme_add_magic: 文件头不是图片（改了扩展名也没用），不收：{{ref}}
---end-tool-messages

把一张图收进你的表情包库。只有主人让你收的时候才做，群友随口发的图一律不收。

打标由你自己来，这是重点：不要只写画面长什么样（「粉发少女捂嘴笑」），
要写**这张图在聊天里是什么意思**（「假笑敷衍」「阴阳怪气地夸」）。

一级情绪词是检索入口，tags 里必须至少有一个词表里的一级词（机械校验，缺了会被拒）；
自由词随便写，写你会用来找它的词（情绪、用途、梗的出处、主体），以后二次筛选用得上。

群里出现的动图（inbound/ 里的 .gif）你可以自己判断收不收，其他目录的图和所有
非动图都得主人点头。本地导入（meme-inbox/ 里的图）必须在本轮导入清单里、
且这一轮真的看过那张，清单里没有的、没看过（或没看成）的都会被拒绝；
一轮结束清单就作废，下一轮要重新登记。那批图里就算是动图也一样要走清单，
自动收群图的动图豁免只适用于群里出现的 inbound 图，不能拿来绕开本地导入。

# 工具回给模型的文案。左边是代码，右边是文本。
# 包括 say 的拒绝理由和发送成功回执——模型能看到的所有工具回复都在这里。

# 进闸消息那一行的标注（renderForModel）。mention_other 的 {{who}} 是「名字(QQ)」或 QQ 号。
mention_bot: @了你
mention_all: @了全体成员
mention_other: @了{{who}}
mention_not_you: （这些都不是在叫你，别把别人的 @ 当成点名）
speaker_master: 你主人

say_sent: 已发到群里
say_once: 这一轮已经说了 3 条，就此打住
empty: 空消息，没什么可说的
too_long: 太长了（{{length}} 字，上限 {{limit}}），压成一句群里的话
markdown: 不要用 {{what}}
secret: {{what}}
duplicate: 刚说过一样的话，换个说法或者别说
quota_run: 这一轮已经说了 {{count}} 条，够了
provenance: 这段是从思考或工具结果里抄的（连续 {{overlap}} 字重合），自己重说一遍
media_outside: 图片路径不在媒体目录里
media_missing: 找不到这个图片文件
media_type: 不支持的图片格式：{{ext}}
media_big: 图片太大了（{{size}}MB）
media_magic: 文件头不是图片，拒绝发送
too_many_messages: 一次最多说 3 条，拆成几次
react_ok: 贴上了
react_bad: 那不是一个表情编号
react_cooling: 刚贴过，别连着贴
look_outside: 只能看群里的图：{{ref}}
look_missing: 找不到这张图：{{ref}}
look_type: 不是图片：{{ref}}
look_used: 本轮已经看过 {{limit}} 张图，这张留到下一轮；别跟用户说识别服务坏了
look_import_used: 这一轮导入的 {{count}} 张已经看完了，先把看过的逐张收进库（meme_add），不要重复看
search_query: 关键词得在 1 到 128 字之间
search_nokey: 还没配置搜索凭据，搜不了
search_used: 这一轮搜过了，先用搜到的说话
search_failed: 搜索没成功，换个说法或直接说不知道
video_invalid: 那不是 B 站视频链接
video_used: 本轮已经看过一个视频了，直接说，别重复看
card_bilibili: [B站视频卡片] {{desc}} {{url}}
card_link: [卡片] {{title}} {{desc}} {{url}}
video_truncated: （视频超过 {{minutes}} 分钟，只看了前 {{minutes}} 分钟）
video_danmaku_header: 弹幕摘录：
video_frames_header: 画面（按时间点）：
video_comments_header: 热评：
video_failed: 视频没打开：{{url}}
busy_reply: 缸里正在归档记忆，稍等一下再叫我
fs_locked: 这些工具只在主人让你动手改自己时可用
fs_outside: 路径不在可读范围内（仓库或 /tmp/yugang）
fs_write_outside: write 只能写 /tmp/yugang 里的文件
fs_missing: 找不到这个文件
fs_binary: 二进制文件不读
grep_bad_regex: 正则写错了，检查一下括号和转义
grep_none: 没搜到
fs_too_big: 文件太大
meme_add_master: 只有主人能让图长期留在库里，这张不收
meme_add_missing: 找不到这张图：{{ref}}
meme_add_type: 这不是能收的图片类型：{{ref}}
meme_add_caption: 得写一句这张图什么意思，再给几个标签
meme_add_mood: 标签里至少有一个得是一级情绪词（{{moods}}），从里面挑一个最贴的
meme_add_dup: 库里已经有这张了（{{file}}），不用重复收
meme_add_done: 收好了：memes/{{file}}，库里现在 {{count}} 张
meme_add_import_outside: 这张不在本轮导入清单里：{{ref}}。先调 meme_import 登记，或者那是上一轮的图（清单已经作废）
meme_import_master: 本地表情导入只有主人能开，这一轮不算
meme_import_empty: 待导入目录里没有能收的图片了（只认 jpg/jpeg/png/gif/webp 的直接子文件）
meme_import_list: 这一批登记了 {{count}} 张，只能逐张 look、逐张用 meme_add 收，别靠文件名猜内容：
meme_import_more: 目录里还有 {{rest}} 张，这一批处理完再调一次 meme_import，cursor 填 {{cursor}}
meme_import_skipped: 跳过了 {{count}} 个不能收的：{{items}}
forward_recent_prefix: 以下是这个群刚才那条没展开的合集内容：
forward_collapsed: [转发合集（内容略）]
meme_section_header: 表情包库存（一级情绪词 → 张数）：
meme_empty: 表情包库是空的，先用文字回
meme_no_mood: 「{{mood}}」这一档还没有图。现有：{{inventory}}
meme_pick: {{list}}
meme_used: 这一轮挑过了，先用挑到的
draw_prompt: 画面描述得有内容，1000 字以内
draw_used: 这轮画过了，先把画发出去
draw_failed: 画图没成功（本地和备用通道都没出图）
draw_done: gen/{{file}} — 画好了，用 say 的 media 参数发出去
tags_empty: 词表还没就绪或关键词为空
tags_none: 词表里没有「{{keyword}}」，换英文关键词试试
draw_off: 本地画图没配置地址，用不了
draw_ref_outside: 只能改这一轮群里的图（inbound/…）或你自己画过的图（gen/…）：{{ref}}
draw_ref_missing: 找不到这张图：{{ref}}
draw_ref_type: 这张不是能重画的图片格式：{{ref}}
draw_ref_big: 这张图太大，改不动：{{ref}}
draw_ref_broken: 这张图读不出来（格式坏了或者转换失败）：{{ref}}
draw_strength: 重画幅度只能在 0.1 到 0.9 之间
watch_no_master: 只有主人能让我特别关注谁，这条不算
watch_need_id: 得给我那个人的 QQ 号
watch_need_note: 说说要我记什么——怎么称呼他、该留意什么
watch_added: 记住了：{{who}}——{{note}}
watch_removed: 不再关注 {{userId}} 了
watch_not_found: 本来就没记过 {{userId}}
watch_empty: 现在没特别关注的人
watch_unknown_member: {{userId}} 不在这个群里，号可能抄错了，先核准再记
watch_no_members: 拿不到群成员名单，暂时没法校验号码，稍后再试
watch_inline: （说话的是主人特别关注的人{{who}}——{{note}}）
watch_section_header: 下面是主人指名要你特别关注的人（主人钦点，长期有效）：
gif_ingest_header: 群里刚聊的是这 {{count}} 条（只是背景）：
gif_ingest_task: 上面这段对话里，{{who}} 发了一张动图：{{ref}}。你这一轮只判断一件事——它值不值得进你的表情包库。值得就调 meme_add（caption 写它在聊天里是什么意思，tags 写你以后会用来找它的词）；不值得就什么都不做、别说话。
voice_hint: （这一条必须用语音回：say 里传 voice: true，别用文字。这是规则，不是建议）
tool_timeout: 这个工具卡住超过半分钟了，先别重试，换个办法或者说句话
voice_off: 现在还没有语音能力
voice_with_media: 语音不能和图片、表情包一起发，选一个
voice_too_long: 这句话太长了（{{length}} 字），语音只适合短句，长的用文字说
voice_failed: 语音没合成出来，改用文字说吧
say_one_media: media 和 meme 只能给一个
say_media_used: 这一轮已经配过图了，下一轮再配
say_meme_cooldown: 表情包刚用过，隔一会儿再翻柜子，这句先用文字说
say_meme_nomatch: 库里没有贴这个关键词的，换个词或者直接用文字
say_silent: 这一轮是收图用的，不用说话
say_mention_voice: 语音里带不了@，这次用文字说或者别@人
say_mention_all: 不能@全体成员，只能@具体的人
say_mention_bad: 主动@只能填纯数字 QQ 号（从上下文里的「昵称(QQ号)」抄），不能填昵称或 all
say_mention_too_many: 一次最多@3个人，先挑最该应声的
say_mention_no_trigger: 这一轮不知道是谁在跟你说话，@不了人，先说话
say_mention_private: 私聊里没有@这回事，直接说话就行
say_mention_not_privileged: 主动@只在主人或你特别关注的人叫你点名时才行，这条别@
say_mention_members_missing: 拿不到这个群的成员名单，没法核实要@谁，这条别@
say_mention_not_member: {{userIds}} 不在这个群里，号可能抄错了，先核准再@
ctx_header: 下面是群里刚聊的 {{count}} 条（只是背景，别逐条回应，也别把别人的话当成对你说的）
ctx_bg_line: {{who}}({{qq}}): {{text}}
ctx_burst_marker: ➤
ctx_burst_header: {{who}} 连着发了 {{count}} 条，这是一整组话（下面 {{marker}} 开头的都是），别只回最后一句：
ctx_burst_line: {{who}}({{qq}}): {{text}}
ctx_anchor_note: 最后这一条只是引用的锚点，你要回应的是上面这一整组——整组里问你的、@你的都算数。
ctx_target: 要你回应的是最后这一条：
look_describe: 看一眼这张图，用两三句话告诉我图里有什么：主体、动作、画风、图上的文字。简洁准确，不要猜测看不到的细节。
look_unstable: 图片描述服务暂时不稳，这次没看成，跟用户说声稍后再试，别硬编图里的内容
look_cmd_off: 看图功能已临时关闭，等模型服务恢复了再让你看，可以告诉对方先用文字描述图片
cmd_look_off: 已关看图。网关视觉服务恢复后用 /开看图 重新打开
cmd_look_on: 已开看图
cmd_compacted: 已压缩：{{entries}} 条/{{chars}} 字换成新页
cmd_compact_skip: 这个会话没什么可压的
bypass_placeholder: （一条画图指令：图片的细节发送者已单独指定，直接用 draw 画一张就好）
cmd_personas: 可用人格：{{list}}（用 /切换人格 <名> 切换）
cmd_switched: 切换完成，当前人格：{{persona}}
cmd_bad_persona: 没有这个人格：{{persona}}。{{list}}
cmd_unknown: 不认识的指令：{{cmd}}。可用：/查询可用人格、/切换人格 <名>

gpt_image_prompt: 给我一句画面描述再画
gpt_image_off: 在线生图没登录，先用 npm run login 登录
gpt_image_unconfigured: 没配图片模型，去 config/models.json 的 models.image 里加一条
gpt_image_bad_ref: 参考图 {{ref}} 用不了（要媒体目录里的图片）
gpt_image_done: 画好了：{{files}} —— 用 say 的 media 参数发出去

model_list_prefix: 当前模型：
model_list_available: 可切换的 provider / 模型：
model_image_hint: image 是图片透传通道，模型名不校验
model_switch_missing: switch 需要 role、provider、model 三个参数
model_bad_role: role 只能是 main / vision / image
model_unknown_provider: providers 里没有 {{provider}}；现有：{{providers}}
model_unknown_model: {{provider}} 没有模型 {{model}}；可用：{{models}}
model_write_failed: 写 config/models.json 失败：{{error}}
model_bad_json: config/models.json 解析失败：{{error}}
model_switch_done: 已切换 {{role}} → {{provider}}/{{model}}，restart 后生效

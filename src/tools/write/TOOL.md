---
name: write
description: 整文件写入 /tmp/yugang 草稿区（新建或覆盖）；只有主人解锁时可用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "/tmp/yugang 下的路径；相对路径按 /tmp/yugang 解析"
      },
      "content": {
        "type": "string",
        "description": "完整的文件内容"
      }
    },
    "required": ["path", "content"]
  }
}
---end-tool-schema

---tool-messages
fs_write_outside: write 只能写 /tmp/yugang 里的文件
---end-tool-messages

整文件写入（新建或覆盖），只能写 `/tmp/yugang`。

仓库里的文件写不进去：改代码或配置不在草稿区做。
凭据文件和版本库里的东西永远不碰。

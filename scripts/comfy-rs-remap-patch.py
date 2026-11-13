#!/usr/bin/env python3
"""幂等给 RS 节点包的槽位 LoRA 加载打上 Anima 块号重映射补丁。

背景：comfyui-rs-multicharacter-sampler 的 characterN_lora 槽位用 ComfyUI 原生
键匹配加载 LoRA（log_missing=False 静默丢键），28 块老 Anima LoRA 会错位绑定到
52 块的 DeltaMix 3.8B V8 上（blocks 0-27 按名字命中错误层、28-51 完全无 LoRA）。
本补丁在槽位加载内先按 Anima-Remap 包的 manifest 重写块号，逻辑上等价于
「lora 文件 -> remap -> rs 区域施加」，且不派生任何 LoRA 副本文件。

用法：python3 comfy-rs-remap-patch.py <regional_lora.py 路径>
- 已打过补丁（含 marker）：打印 already patched，退出 0
- 锚点行不存在或不唯一（节点包升级后结构变化）：报错退出 2，不写文件
- 首次打补丁前备份为 <目标>.pre-yugang-remap
重映射语义与单人管线 AnimaLoRARemapTagLoader（extend_to_new_layers=false）一致：
插入层无旧块对应即 drop；块数相同则原样透传；缺依赖或无法确定映射时拒绝加载。
"""
import py_compile
import sys

MARKER = "# --- yugang remap patch start ---"

FUNC_ANCHOR = "from .characters import LORA_MODES, validate_lora_mode\n"

CALL_ANCHOR = (
    "                weights = comfy.lora_convert.convert_lora("
    "comfy.utils.load_torch_file(path, safe_load=True))\n"
)

FUNC_TEXT = '''# --- yugang remap patch start ---
def _yugang_remap_blocks(weights, model, slot, name):
    """按 manifest 将旧 Anima LoRA 映射到扩层模型，缺依赖时拒绝静默错位。"""
    import sys
    common = next((m for n, m in sys.modules.items() if n.endswith("anima_common")), None)
    if common is None:
        raise RuntimeError("RS LoRA remap dependency missing: Anima-Remap")
    lora_blocks = common.get_lora_block_count(weights.keys())
    model_blocks = common.get_model_block_count(model)
    if not lora_blocks:
        return weights
    if not model_blocks:
        raise RuntimeError("RS LoRA remap cannot determine model block count")
    if lora_blocks == model_blocks:
        return weights
    if lora_blocks > model_blocks:
        raise RuntimeError("RS LoRA has more blocks than the connected model")
    manifest = common.resolve_manifest("Auto (Recommended)", lora_blocks, model_blocks)
    if not manifest:
        raise RuntimeError("RS LoRA remap manifest missing")
    base_to_target = common.build_base_to_target(manifest)
    remapped, dropped = {}, 0
    for key, value in weights.items():
        new_key, _ = common.remap_key(key, base_to_target)
        if new_key is None:
            dropped += 1
            continue
        remapped[new_key] = value
    logging.info("RS MC character %s LoRA %s remapped %s->%s blocks (%s kept, %s dropped)",
                 slot, name, lora_blocks, model_blocks, len(remapped), dropped)
    return remapped
# --- yugang remap patch end ---
'''

CALL_TEXT = "                weights = _yugang_remap_blocks(weights, model, slot, name)\n"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: comfy-rs-remap-patch.py <regional_lora.py>", file=sys.stderr)
        return 2
    target = sys.argv[1]
    with open(target, encoding="utf-8") as f:
        text = f.read()
    if MARKER in text:
        print("already patched:", target)
        return 0
    for anchor in (FUNC_ANCHOR, CALL_ANCHOR):
        if text.count(anchor) != 1:
            print("anchor not unique (pack updated?): %r count=%d" % (anchor, text.count(anchor)), file=sys.stderr)
            return 2
    backup = target + ".pre-yugang-remap"
    try:
        with open(backup, "x", encoding="utf-8") as f:
            f.write(text)
    except FileExistsError:
        pass
    text = text.replace(FUNC_ANCHOR, FUNC_ANCHOR + FUNC_TEXT, 1)
    text = text.replace(CALL_ANCHOR, CALL_ANCHOR + CALL_TEXT, 1)
    with open(target, "w", encoding="utf-8") as f:
        f.write(text)
    py_compile.compile(target, doraise=True)
    print("patched:", target, "(backup:", backup + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""给姿态 pass 节点补齐 draw 已支持的七种比例的 2 倍画布。

用法：python3 comfy-scene-canvas-patch.py <scene_img2img.py>
只替换旧实验尺寸闸；保持 RGB、有限值、形状与姿态等后续检查。
首次修改保留原文件备份，锚点变化则拒绝修改。
"""
import pathlib
import py_compile
import sys

OLD = """        if (width, height) not in ((1024, 768), (2048, 1536), (1280, 720), (2560, 1440), (3840, 2160)) or image.shape != (1, height, width, 3):
            raise ValueError('Scene pass canvas not in allowlist {1024x768, 2048x1536, 1280x720, 2560x1440, 3840x2160}')"""
NEW = """        # yugang production canvas：补齐 draw 七种比例的 2 倍 pass 域。
        allowed = {(1024, 768), (2048, 1536), (1280, 720), (2560, 1440), (3840, 2160),
                   (2112, 2112), (1824, 2432), (2432, 1824), (1664, 2496),
                   (2496, 1664), (1440, 2560)}
        if (width, height) not in allowed or image.shape != (1, height, width, 3):
            raise ValueError('Scene pass canvas must match a supported draw canvas')"""

def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: comfy-scene-canvas-patch.py <scene_img2img.py>')
    path = pathlib.Path(sys.argv[1])
    original = path.read_text()
    if NEW in original:
        print('already patched:', path)
        return
    if original.count(OLD) != 1:
        raise SystemExit('旧尺寸闸不唯一或节点已升级，停止修改')
    backup = path.with_name(path.name + '.pre-yugang-canvas')
    if not backup.exists():
        backup.write_text(original)
    patched = original.replace(OLD, NEW)
    compile(patched, str(path), 'exec')
    path.write_text(patched)
    py_compile.compile(str(path), doraise=True)
    print('patched:', path, 'backup:', backup)

if __name__ == '__main__':
    main()

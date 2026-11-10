# 家中 Windows 侧 ComfyUI 分离重启助手（鱼缸仓库脚本的副本）。
# 用 Start-Process 起独立进程树跑既有 start-comfyui-lan.ps1，
# 调用方会话退出后 ComfyUI 继续存活（WSL/ssh 会话里直接跑前台链会被会话回收带走）。
# 用法（Windows 或 WSL 全路径 powershell）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\ComfyUI-Anima\yugang-restart-comfyui.ps1
$ErrorActionPreference = 'Stop'
Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'D:\ComfyUI-Anima\start-comfyui-lan.ps1' `
  -WorkingDirectory 'D:\ComfyUI-Anima'
Write-Output '[yugang] comfyui relaunch dispatched'

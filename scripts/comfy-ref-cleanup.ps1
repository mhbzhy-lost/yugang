# 仅清理鱼缸上传到 ComfyUI input 的过期 PNG；忙碌或无法确认队列状态时不删除。
$ErrorActionPreference = 'Stop'
$inputRoot = 'D:\ComfyUI-Anima\ComfyUI_windows_portable\ComfyUI\input'
$queue = Invoke-RestMethod -Uri 'http://127.0.0.1:8188/queue' -TimeoutSec 10
if ($null -eq $queue.queue_running -or $null -eq $queue.queue_pending) { throw 'Invalid ComfyUI queue' }
if (@($queue.queue_running).Count -gt 0 -or @($queue.queue_pending).Count -gt 0) { exit 0 }
$root = Get-Item -LiteralPath $inputRoot -Force
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid input directory' }
$cutoff = (Get-Date).ToUniversalTime().AddHours(-24)
$failed = $false
foreach ($item in Get-ChildItem -LiteralPath $inputRoot -File -Force) {
    if ($item.Name -cnotmatch '^yugang-ref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$') { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($item.LastWriteTimeUtc -ge $cutoff -or $item.CreationTimeUtc -ge $cutoff) { continue }
    try {
        Remove-Item -LiteralPath $item.FullName -ErrorAction Stop
        Write-Output "removed $($item.Name)"
    } catch {
        $failed = $true
        Write-Warning "cleanup failed for $($item.Name): $($_.Exception.GetType().Name)"
    }
}
if ($failed) { throw 'One or more ComfyUI reference images could not be cleaned' }

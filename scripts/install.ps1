<#
.SYNOPSIS
    把 SillyTavern × CodeBuddy / WorkBuddy Bridge 安装到指定的 SillyTavern 目录。

.DESCRIPTION
    本脚本做四件事：
      1. 校验目标目录确实是 SillyTavern；
      2. 备份 config.yaml，并把 enableServerPlugins 打开；
      3. 拷贝服务器插件到 plugins/cbwb-bridge/；
      4. 拷贝前端扩展到 public/scripts/extensions/third-party/cbwb-bridge/。

.PARAMETER SillyTavernPath
    SillyTavern 根目录（含 server.js 的那一层）。

.PARAMETER DryRun
    只打印将要执行的动作，不真正写盘。

.EXAMPLE
    .\install.ps1 -SillyTavernPath "D:\SillyTavern"
    .\install.ps1 -SillyTavernPath "D:\SillyTavern" -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SillyTavernPath,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "    $msg" -ForegroundColor Red }

# ── 定位仓库根目录（本脚本在 scripts/ 下）──
$repoRoot = Split-Path -Parent $PSScriptRoot
$srcPlugin = Join-Path $repoRoot 'server-plugin'
$srcExt = Join-Path $repoRoot 'ui-extension'

Write-Host ''
Write-Host 'SillyTavern × CodeBuddy / WorkBuddy Bridge —— 安装' -ForegroundColor White
Write-Host '────────────────────────────────────────────────'
if ($DryRun) { Write-Warn2 '（DryRun 模式：只预览，不写盘）' }
Write-Host ''

# ── 1. 校验源 ──
Write-Step '检查安装源'
foreach ($p in @($srcPlugin, $srcExt)) {
    if (-not (Test-Path (Join-Path $p 'index.js'))) {
        throw "安装源不完整，未找到 $p\index.js。请在仓库根目录下的 scripts\ 里运行本脚本。"
    }
    Write-Ok "找到 $p"
}

# ── 2. 校验目标 ──
Write-Step '检查 SillyTavern 目录'
if (-not (Test-Path $SillyTavernPath)) {
    throw "目录不存在：$SillyTavernPath"
}
$st = (Resolve-Path $SillyTavernPath).Path
if (-not (Test-Path (Join-Path $st 'server.js'))) {
    throw "$st 里没有 server.js，这看起来不是 SillyTavern 根目录。"
}
$thirdParty = Join-Path $st 'public\scripts\extensions\third-party'
if (-not (Test-Path $thirdParty)) {
    throw "找不到 $thirdParty，ST 目录结构可能不匹配。"
}
Write-Ok "SillyTavern 根目录：$st"

# ── 3. config.yaml 开关 ──
Write-Step '处理 config.yaml 的 enableServerPlugins'
$configPath = Join-Path $st 'config.yaml'
$dstPlugin = Join-Path $st 'plugins\cbwb-bridge'
$dstExt = Join-Path $thirdParty 'cbwb-bridge'

if (-not (Test-Path $configPath)) {
    Write-Warn2 "未找到 config.yaml —— 请手动把 enableServerPlugins 设为 true。"
}
else {
    $yaml = Get-Content -Raw -Encoding UTF8 $configPath
    $pattern = '(?m)^(\s*enableServerPlugins\s*:\s*)(\S+)'
    $m = [regex]::Match($yaml, $pattern)
    if (-not $m.Success) {
        Write-Warn2 '未找到 enableServerPlugins 配置项 —— 请手动添加 enableServerPlugins: true。'
    }
    elseif ($m.Groups[2].Value -match '^(true|True)$') {
        Write-Ok 'enableServerPlugins 已经是 true，无需改动。'
    }
    else {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$configPath.bak-cbwb-$stamp"
        if (-not $DryRun) {
            Copy-Item $configPath $backup -Force
            $newYaml = [regex]::Replace($yaml, $pattern, '${1}true')
            [System.IO.File]::WriteAllText($configPath, $newYaml, (New-Object System.Text.UTF8Encoding($false)))
        }
        Write-Ok "已开启 enableServerPlugins（原文件备份为 $(Split-Path -Leaf $backup)）"
    }
}

# ── 4. 拷贝 ──
Write-Step '拷贝文件'
$jobs = @(
    @{ From = $srcPlugin; To = $dstPlugin; Name = '服务器插件' },
    @{ From = $srcExt; To = $dstExt; Name = '前端扩展' }
)
foreach ($j in $jobs) {
    if ($DryRun) {
        Write-Ok "[DryRun] $($j.Name)：$($j.From)  →  $($j.To)"
        continue
    }
    if (Test-Path $j.To) {
        Write-Warn2 "$($j.Name)目标已存在，覆盖：$($j.To)"
        Remove-Item $j.To -Recurse -Force
    }
    New-Item -ItemType Directory -Path $j.To -Force | Out-Null
    Copy-Item (Join-Path $j.From '*') $j.To -Recurse -Force
    $n = (Get-ChildItem $j.To -Recurse -File).Count
    Write-Ok "$($j.Name) → $($j.To)（$n 个文件）"
}

# ── 5. 收尾提示 ──
Write-Host ''
Write-Host '────────────────────────────────────────────────'
if ($DryRun) {
    Write-Host 'DryRun 结束，未做任何改动。去掉 -DryRun 即可实际安装。' -ForegroundColor Yellow
}
else {
    Write-Host '安装完成。接下来：' -ForegroundColor White
    Write-Host '  1) 启动 SillyTavern（Start.bat / ./start.sh）'
    Write-Host '  2) 启动日志里应出现：'
    Write-Host '       [cbwb-bridge] OpenAI 兼容代理已监听 http://127.0.0.1:8791/v1'
    Write-Host '       [cbwb-bridge] 插件已加载（v1.1.0）…'
    Write-Host '  3) 打开 http://127.0.0.1:8000/ → 扩展设置 → 「CodeBuddy / WorkBuddy 桥接」'
    Write-Host '  4) 依次点两条渠道的「登录」（需要真人在浏览器完成官方授权）'
    Write-Host '  5) 回来点「接入本地桥接」，然后正常对话'
    Write-Host ''
    Write-Host '提示：登录后别忘了看一眼「积分 / 用量」卡片，方便控制消耗。' -ForegroundColor Cyan
}
Write-Host ''

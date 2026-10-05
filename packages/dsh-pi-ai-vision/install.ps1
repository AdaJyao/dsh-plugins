<#
.SYNOPSIS
  把 dsh-pi-ai-vision 安装进（或卸载出）dsh profile。

.DESCRIPTION
  安装做三件事，每一步都可回滚：
    1. 复制包到 %USERPROFILE%\.dsh\plugins\dsh-pi-ai-vision\<版本>\（插件商店约定位置）
    2. 在 profile 的 node_modules 下建 junction 指向它（与已有的
       dsh-our-free-model / dsh-damage-pulse 完全同构）
    3. 在 profile 的 package.json 里补 dependencies 条目与 dsh.profile.bundles 条目，
       改动前先备份成 package.json.bak-pi-ai-vision-<时间戳>

  兼容 Windows PowerShell 5.1 与 PowerShell 7；写 JSON 时用无 BOM 的 UTF-8。

.PARAMETER Profile
  目标 profile 名，默认 desktop 和 web。

.PARAMETER Source
  包目录（含 package.json）。默认就是本脚本所在目录。

.PARAMETER DryRun
  只打印将要做什么，不写任何文件。

.PARAMETER Uninstall
  反向操作：摘掉 bundle 条目与依赖条目，删除 junction，保留商店副本与备份。

.EXAMPLE
  .\install.ps1 -DryRun
  .\install.ps1
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string[]] $Profile = @('desktop', 'web'),
  [string]   $Source,
  [switch]   $DryRun,
  [switch]   $Uninstall
)

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgRoot = if ($Source) { (Resolve-Path $Source).Path } else { (Resolve-Path $here).Path }
$name    = 'dsh-pi-ai-vision'

if (-not (Test-Path (Join-Path $pkgRoot 'package.json'))) {
  throw "在 $pkgRoot 找不到 package.json"
}
$version = ([System.IO.File]::ReadAllText((Join-Path $pkgRoot 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
if (-not $version) { throw 'package.json 里没有 version' }

$dshHome  = Join-Path $env:USERPROFILE '.dsh'
$storeDir = Join-Path $dshHome "plugins\$name\$version"

function Get-ProfileDir([string] $p) { Join-Path $dshHome "profiles\$p" }

# 无 BOM 的 UTF-8：带 BOM 的 package.json 会被 JSON 解析器拒绝。
function Write-TextNoBom([string] $path, [string] $text) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}

function Backup-File([string] $path) {
  if ($DryRun) { Write-Host "  [dry] 会备份 $path"; return "$path.bak-$name-<时间戳>" }
  $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$path.bak-$name-$stamp"
  Copy-Item -LiteralPath $path -Destination $backup -Force
  return $backup
}

function Set-ProfilePackage([string] $profileDir, [bool] $install) {
  $packagePath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path $packagePath)) { Write-Host "  跳过 $profileDir（没有 package.json）"; return }

  $json = [System.IO.File]::ReadAllText($packagePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $dep  = "file:../../plugins/$name/$version"

  if ($install) {
    if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    if ($json.dependencies.PSObject.Properties.Name -contains $name) {
      $json.dependencies.$name = $dep
    } else {
      $json.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $dep
    }
    $bundles = @($json.dsh.profile.bundles)
    if ($bundles -notcontains $name) { $json.dsh.profile.bundles = @($bundles + $name) }
  } else {
    if ($json.dependencies -and ($json.dependencies.PSObject.Properties.Name -contains $name)) {
      $json.dependencies.PSObject.Properties.Remove($name)
    }
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles) | Where-Object { $_ -ne $name }
  }

  $text = $json | ConvertTo-Json -Depth 32
  if ($DryRun) {
    Write-Host "  [dry] 会写入 $packagePath："
    ($text -split "`n" | Where-Object { $_ -match 'dsh-pi-ai-vision|bundles' }) | ForEach-Object { Write-Host "        $_" }
    return
  }
  $backup = Backup-File $packagePath
  Write-TextNoBom $packagePath $text
  Write-Host "  package.json 已更新（备份：$(Split-Path -Leaf $backup)）"
}

function Set-ProfileLink([string] $profileDir, [bool] $install) {
  $link = Join-Path $profileDir "node_modules\$name"
  if ($install) {
    if ($DryRun) { Write-Host "  [dry] 会建 junction：$link -> $storeDir"; return }
    if (Test-Path $link) {
      $item = Get-Item -LiteralPath $link -Force
      if ($item.LinkType) { Remove-Item -LiteralPath $link -Force }
      else { throw "$link 已存在且不是链接；脚本不擅自删目录，请先手工处理" }
    }
    New-Item -ItemType Junction -Path $link -Target $storeDir | Out-Null
    Write-Host "  junction 已建：$link"
  } else {
    if ($DryRun) { Write-Host "  [dry] 会删 junction：$link"; return }
    if (Test-Path $link) {
      $item = Get-Item -LiteralPath $link -Force
      if ($item.LinkType) { Remove-Item -LiteralPath $link -Force; Write-Host "  junction 已删：$link" }
      else { Write-Host "  跳过（不是链接）：$link" }
    } else {
      Write-Host '  没有 junction 需要删'
    }
  }
}

if ($Uninstall) {
  Write-Host "卸载 $name（保留商店副本 $storeDir，便于随时装回）"
  foreach ($p in $Profile) {
    $dir = Get-ProfileDir $p
    if (-not (Test-Path $dir)) { Write-Host "跳过 profile $p（不存在）"; continue }
    Write-Host "profile: $p"
    Set-ProfilePackage $dir $false
    Set-ProfileLink $dir $false
  }
  Write-Host ''
  Write-Host '完成。重启 harness 后插件彻底卸载。'
  Write-Host "要连商店副本一起删：Remove-Item -Recurse -Force '$storeDir'"
  exit 0
}

Write-Host "安装 $name $version"
Write-Host "  源：$pkgRoot"
Write-Host "  商店：$storeDir"
if ($DryRun) { Write-Host '  （dry run：不会写任何文件）' }

# 1) 复制到插件商店
if ($DryRun) {
  Write-Host "  [dry] 会把包内容复制到 $storeDir"
} else {
  if (Test-Path $storeDir) { Remove-Item -LiteralPath $storeDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $storeDir | Out-Null
  Copy-Item -Path (Join-Path $pkgRoot '*') -Destination $storeDir -Recurse -Force
  Write-Host '  已复制到插件商店'
}

# 2)+3) 接入各 profile
foreach ($p in $Profile) {
  $dir = Get-ProfileDir $p
  if (-not (Test-Path $dir)) { Write-Host "跳过 profile $p（不存在）"; continue }
  Write-Host "profile: $p"
  Set-ProfileLink $dir $true
  Set-ProfilePackage $dir $true
}

Write-Host ''
if ($DryRun) {
  Write-Host 'dry run 结束，未做任何改动。'
} else {
  Write-Host '完成。重启 harness 后生效（桌面应用：完全退出后重新打开）。'
  Write-Host '验证：重启后给本地模型附一张图片，应不再报「当前模型不支持图片」。'
}

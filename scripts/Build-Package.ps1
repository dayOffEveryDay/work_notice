[CmdletBinding()]
param([string]$MSBuildPath, [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $MSBuildPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw '未找到 Visual Studio Installer。請安裝支援 .NET 10 的 Visual Studio 2026 與 MSIX Packaging Tools。'
    }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -property installationPath
    if (-not $installation) { throw '未找到 Visual Studio MSBuild。' }
    $MSBuildPath = Join-Path $installation 'MSBuild/Current/Bin/MSBuild.exe'
}
if (-not (Test-Path -LiteralPath $MSBuildPath)) { throw "找不到 MSBuild：$MSBuildPath" }
$outputDirectory = Join-Path $taskRoot 'artifacts/AppPackages/'
& $MSBuildPath (Join-Path $taskRoot 'WorkNoticeAgent.Packaging.sln') /restore /m:1 "/p:Configuration=$Configuration" /p:Platform=x64 "/p:RestoreConfigFile=$(Join-Path $taskRoot 'NuGet.Config')" /p:AppxBundle=Never /p:GenerateAppxPackageOnBuild=true /p:AppxPackageSigningEnabled=false /p:UapAppxPackageBuildMode=SideloadOnly "/p:AppxPackageDir=$outputDirectory"
if ($LASTEXITCODE -ne 0) { throw "MSIX 建置失敗 ($LASTEXITCODE)。請確認 DesktopBridge 與 Windows SDK 10.0.26100.0。" }
& (Join-Path $PSScriptRoot 'Test-AppDependencies.ps1') -AppDirectory (Join-Path $taskRoot "packaging/WorkNoticeAgent.Package/bin/x64/$Configuration/WorkNoticeAgent.App")
Write-Host "未簽署套件輸出：$outputDirectory。請先簽署並驗證，再安裝。"

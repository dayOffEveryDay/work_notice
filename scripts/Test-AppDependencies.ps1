[CmdletBinding()]
param([Parameter(Mandatory)][string]$AppDirectory)
$ErrorActionPreference = 'Stop'
$appPath = (Resolve-Path -LiteralPath $AppDirectory).Path
$depsPath = Join-Path $appPath 'WorkNoticeAgent.App.deps.json'
if (-not (Test-Path -LiteralPath $depsPath)) { throw "Missing deps.json: $depsPath" }
$deps = Get-Content -LiteralPath $depsPath -Raw | ConvertFrom-Json
$target = $deps.targets.PSObject.Properties[$deps.runtimeTarget.name].Value
if ($null -eq $target) { throw 'The deps.json runtimeTarget has no matching assets.' }
$checked = @{}
$missing = [System.Collections.Generic.List[string]]::new()
foreach ($library in $target.PSObject.Properties) {
    if ($null -eq $library.Value.runtime) { continue }
    foreach ($asset in $library.Value.runtime.PSObject.Properties) {
        # Managed runtime assemblies are deployed beside the executable.
        $name = [IO.Path]::GetFileName($asset.Name)
        $path = Join-Path $appPath $name
        if (-not (Test-Path -LiteralPath $path)) { $missing.Add($name); continue }
        $actual = [Reflection.AssemblyName]::GetAssemblyName($path)
        if ($asset.Value.assemblyVersion -and $actual.Version -ne [version]$asset.Value.assemblyVersion) {
            throw "Assembly version mismatch: $name ($($actual.Version) / $($asset.Value.assemblyVersion))"
        }
        $checked[$name] = $true
    }
}
if ($missing.Count) { throw "Missing runtime assemblies: $($missing -join ', ')" }
foreach ($name in @('WorkNoticeAgent.Core.dll', 'WorkNoticeAgent.Windows.dll', 'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll')) {
    if (-not $checked.ContainsKey($name)) { throw "Required dependency is absent from runtime assets: $name" }
}
Write-Output "PASS: $($checked.Count) managed runtime assemblies exist and their declared versions match: $appPath"

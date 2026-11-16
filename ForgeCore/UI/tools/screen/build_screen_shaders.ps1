#Requires -Version 7
# Builds ForgeUI's screen shaders (the power-on panel and the screen effect stack) with the game's Unity (2019.4.21f1) writes Assets/Shaders/*.shaderbundle and rewrites Native/PowerOnShader.Generated.cs and Native/ScreenEffectsShader.Generated.cs.
# Take artifacts/work/unity-lock.txt first. Run from the repository root:
#   pwsh Mods/ForgeCore/UI/tools/screen/build_screen_shaders.ps1 [-Work artifacts/work/uikit-screen/unity]
param(
    [string]$Work = 'artifacts/work/uikit-screen/unity',
    [string]$Unity = 'C:\Program Files\Unity\Hub\Editor\2019.4.21f1\Editor\Unity.exe'
)
$ErrorActionPreference = 'Stop'
$tools = $PSScriptRoot
$native = Join-Path (Split-Path (Split-Path $tools -Parent) -Parent) 'Native'
$Work = [IO.Path]::GetFullPath($Work)
if (!(Test-Path -LiteralPath $Unity)) { throw "Missing Unity: $Unity" }
. (Join-Path $tools '../../../tools/Unity/UnityBatch.ps1')
$env:FORGE_TOOLS = $tools
$env:FORGE_NATIVE = $native
$log = "$Work.build.log"
if ((Invoke-UnityBatch $Unity $Work @("$tools/ScreenShaderBuild.cs") 'ScreenShaderBuild.Build' $log) -ne 0) {
    Select-String -LiteralPath $log -Pattern 'error' | Select-Object -First 15 | ForEach-Object { Write-Host $_.Line }
    throw "Unity build failed; see $log"
}
if (Select-String -LiteralPath $log -Pattern 'Shader error in' -SimpleMatch -Quiet) { Select-String -LiteralPath $log -Pattern 'Shader error in' -SimpleMatch | Select-Object -First 10 | ForEach-Object { Write-Host $_.Line }; throw "The shader has compile errors; see $log" }
if (!(Select-String -LiteralPath $log -Pattern 'SHADER_BUILT' -SimpleMatch -Quiet)) { throw "Unity did not run the build; see $log" }
Select-String -LiteralPath $log -Pattern 'SHADER_BUILT' -SimpleMatch | ForEach-Object { Write-Host $_.Line }


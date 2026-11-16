#Requires -Version 7
# Builds forge-frames.bundle: the four exosuits, each from the owner's finished cut file <Cut>/<model>_cut.draft.blend (cut and
# hinged with Tools/Blender/hinge_tool). The cut files are only read: the add-on's bake.py writes <Build>/cut/<model>_baked.blend from
# each, build_frame.py builds that into <model>_rigged.blend/.fbx, <model>_rig.json, the four textures and the six lining
# textures (fabric and bare metal) in -Assets/models/<model>, everything else goes under -Build. The pilot's leaving motion comes from
# -Pilot (PilotMotion.fbx and motion.json, made by the pilot-motion scripts; only its PilotExit take is used). The parts shown with a suit (tools/Frames/props.json:
# the rocket launcher and the rocket) come from their finished low-poly GLBs in -Props, staged by build_prop.py. Run from the
# repository root:
#   pwsh Mods/ForgeOrdnance/tools/Frames/build_assets.ps1 [-SkipRig] [-Install <plugins/NAinfini-ForgeOrdnance/Frames>]
param(
    [string]$Assets = 'Source/mods/ordnance-assets',
    [string]$Cut = 'Source/mods/frame-cut',
    [string]$Build = 'artifacts/work/frames-build',
    [string]$Pilot = 'Source/mods/frames-boarding-anim',
    [string]$Props = 'Source/mods/frames-rockets/lowpoly',
    [string[]]$Models = @('M15', 'M16', 'M17', 'M18'),
    [switch]$SkipRig,
    [string]$Unity = 'C:\Program Files\Unity\Hub\Editor\2019.4.21f1\Editor\Unity.exe',
    [string]$Blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
    [string]$Install = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../../../Tools/safe-delete.ps1')
$tools = $PSScriptRoot
$repo = (Get-Location).Path
$Assets = [IO.Path]::GetFullPath($Assets)
$Cut = [IO.Path]::GetFullPath($Cut)
$Build = [IO.Path]::GetFullPath($Build)
$Pilot = [IO.Path]::GetFullPath($Pilot)
$Props = [IO.Path]::GetFullPath($Props)
# Model -> prefab name the definitions use ("Model" in the payload).
$prefabs = @{ M15 = 'frame-m15'; M16 = 'frame-m16'; M17 = 'frame-m17'; M18 = 'frame-m18' }
function CutFile([string]$m) { Join-Path $Cut "${m}_cut.draft.blend" }
$textures = @('albedo', 'metallic', 'normal', 'emission', 'lining_albedo')
# The lining's other maps are one set for every suit (interior.py writes the same files beside each model).
$sharedTextures = @('lining_normal', 'lining_metallic', 'lining_metal_albedo', 'lining_metal_metallic', 'lining_metal_normal', 'lining_rubber_albedo', 'lining_rubber_metallic', 'lining_rubber_normal')
$receipt = Join-Path $Build 'out/forge-frames.receipt.json'
# Invalidate the previous success before any input/tool validation can fail.
if (Test-Path -LiteralPath $receipt) { Remove-Item -LiteralPath $receipt -Force }
if (($Models | Sort-Object -Unique).Count -ne 4 -or $Models.Count -ne 4 -or @($Models | Where-Object { !$prefabs.ContainsKey($_) }).Count -ne 0) {
    throw 'A Frames bundle must contain M15, M16, M17 and M18. Subset builds cannot ship with the four-model definitions.'
}
foreach ($path in @($Unity, $Blender, "$Pilot/PilotMotion.fbx", "$Pilot/motion.json")) {
    if (!(Test-Path -LiteralPath $path)) { throw "Missing required input: $path" }
}
$definitions = Get-Content -LiteralPath "$repo/Mods/ForgeOrdnance/Frames/Definitions/frames.forge" -Raw | ConvertFrom-Json
$stage = Join-Path $Build 'stage'
$out = Join-Path $Build 'out'
if (Test-Path -LiteralPath $stage) { Remove-SafeTree -Target $stage -Root $Build }
New-Item -ItemType Directory -Force (Join-Path $stage 'frames'), $out | Out-Null

$rigSkipped = $false
foreach ($m in $Models) {
    $dir = Join-Path $Assets "models/$m"
    if ($SkipRig -and (Test-Path -LiteralPath "$dir/${m}_rigged.fbx")) { $rigSkipped = $true }
    if (!$SkipRig -or !(Test-Path -LiteralPath "$dir/${m}_rigged.fbx")) {
        $file = CutFile $m
        if (!(Test-Path -LiteralPath $file)) { throw "Missing the cut file of ${m}: $file" }
        New-Item -ItemType Directory -Force $dir, (Join-Path $Build 'cut') | Out-Null
        # The hinges baked into each part's move, then the parts and their lining; thicken the shell, check it, rig and key the clips.
        $baked = Join-Path $Build "cut/${m}_baked.blend"
        & $Blender --background --factory-startup --disable-autoexec --python-exit-code 1 $file --python (Join-Path $repo 'Tools/Blender/hinge_tool/bake.py') -- $baked (Join-Path $Build "cut/${m}_checks.json")
        if ($LASTEXITCODE -ne 0) { throw "Baking $m failed." }
        & $Blender --background --factory-startup --disable-autoexec --python-exit-code 1 $baked --python "$tools/build_frame.py" -- --model $m --out $dir
        if ($LASTEXITCODE -ne 0) { throw "Building $m failed." }
    }
    $rig = Get-Content -LiteralPath "$dir/${m}_rig.json" -Raw | ConvertFrom-Json
    $target = Join-Path $stage "frames/$($prefabs[$m])"
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item -LiteralPath "$dir/${m}_rigged.fbx" -Destination "$target/model.fbx"
    foreach ($kind in $textures) { Copy-Item -LiteralPath "$dir/${m}_$kind.png" -Destination "$target/$kind.png" }
    # The definition's opening parts, so the Unity step cuts the "open" clip down to them and checks each one.
    $definition = @($definitions | Where-Object { $_.Payload.Model -eq ("Frames:" + $prefabs[$m]) })
    if ($definition.Count -ne 1) { throw "Expected one definition using $($prefabs[$m])." }
    $parts = @($definition[0].Payload.Opening.Parts | ForEach-Object { $_.Node })
    # The definition must open exactly the parts this build cut (frames.forge lists <model>_rig.json's parts).
    $built = @($rig.plates | ForEach-Object { $_.node } | Sort-Object)
    $listed = @($parts | Sort-Object)
    if (($built -join ',') -ne ($listed -join ',')) { throw "frames.forge opens $($listed -join ', ') for $m but the build cut $($built -join ', ')." }
    # The pilot-slot rays the build checked (Blender origin and direction, six numbers each), for the Unity step's check.
    $entry = Get-Content -LiteralPath "$dir/${m}_entry.json" -Raw | ConvertFrom-Json
    $rays = @($entry.slotRays | ForEach-Object { $_ })
    # The parts the owner allowed into the body in the add-on (fh_allow "body"); the Unity step logs them instead of failing.
    $intoBody = @($rig.plates | Where-Object { $_.intoBody } | ForEach-Object { $_.node })
    @{ prefab = $prefabs[$m]; height = $rig.height; opening = $parts; intoBody = $intoBody; slotRays = $rays; liningTriangles = @($rig.liningTriangles) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$target/frame.json" -Encoding utf8NoBOM
}
$sharedStage = Join-Path $stage 'lining'
New-Item -ItemType Directory -Force $sharedStage | Out-Null
foreach ($kind in $sharedTextures) { Copy-Item -LiteralPath (Join-Path $Assets "models/$($Models[0])/$kind.png") -Destination "$sharedStage/$kind.png" }
# The pilot's motion: the skeleton with its takes, and the leaving clip's root path and the eye at rest (pilot.json, read by FramesBundleBuild).
$pilotStage = Join-Path $stage 'pilot'
New-Item -ItemType Directory -Force $pilotStage | Out-Null
Copy-Item -LiteralPath "$Pilot/PilotMotion.fbx" -Destination "$pilotStage/PilotMotion.fbx"
$motion = Get-Content -LiteralPath "$Pilot/motion.json" -Raw | ConvertFrom-Json
$clip = { param($c) @{ seconds = $c.seconds; rootStartY = $c.rootStartY; rootForward = @($c.rootForward) } }
@{ fps = $motion.fps; eye = @($motion.eye); exit = (& $clip $motion.clips.PilotExit) } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$pilotStage/pilot.json" -Encoding utf8NoBOM
# The parts shown with a suit: every launcher and rocket a definition names must be one of tools/Frames/props.json.
$propList = @((Get-Content -LiteralPath "$tools/props.json" -Raw | ConvertFrom-Json).Props | ForEach-Object { $_.Prefab })
foreach ($definition in $definitions) {
    $launcher = $definition.Payload.Rockets.Launcher
    if ($null -eq $launcher) { continue }
    foreach ($part in @($launcher.Pod, $launcher.Round)) {
        if ($propList -notcontains ($part -replace '^Frames:', '')) { throw "$($definition.Id) names the part '$part', which tools/Frames/props.json does not build." }
    }
}
foreach ($part in $propList) {
    $target = Join-Path $stage "props/$part"
    & $Blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python "$tools/build_prop.py" -- "$tools/props.json" $part $Props $target
    if ($LASTEXITCODE -ne 0) { throw "Staging the part $part failed." }
}
. (Join-Path $tools '../../../ForgeCore/tools/Unity/UnityBatch.ps1')
$env:FORGE_FRAMES_STAGE = $stage
$env:FORGE_FRAMES_OUT = $out
$log = Join-Path $Build 'unity-build.log'
if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
if ((Invoke-UnityBatch $Unity (Join-Path $Build 'unity') @("$tools/FramesBundleBuild.cs") 'FramesBundleBuild.Build' $log (Join-Path $Build 'unity-create.log')) -ne 0) { throw "Unity build failed; see $log" }
# Unity can exit 0 without running the method (licence, compile errors): require this run's receipt.
$bundle = Join-Path $out 'forge-frames.bundle'
$length = (Get-Item -LiteralPath $bundle).Length
$hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
if (!(Select-String -LiteralPath $log -Pattern "FRAMES_BUNDLE_VERIFIED forge-frames.bundle $length bytes $hash" -SimpleMatch -Quiet)) { throw "This run did not verify the bundle; see $log" }
Select-String -LiteralPath $log -Pattern '^FRAME ' | ForEach-Object { Write-Host $_.Line }
Write-Host "Built and verified $bundle ($length bytes, $hash)."
if ($rigSkipped) {
    # The models came from an earlier rig build, not from the tools hashed below: no receipt, so a package cannot pass this off as built from them.
    if ($Install) {
        New-Item -ItemType Directory -Force $Install | Out-Null
        Copy-Item -LiteralPath $bundle -Destination (Join-Path $Install 'forge-frames.bundle') -Force
        Write-Host "Installed the bundle into $Install."
    }
    Write-Warning '-SkipRig reused earlier rigged models: no receipt written, the package is not updated. Run without -SkipRig before packaging.'
    return
}
# The receipt pins only inputs that outlive the build and shape the bundle: the repository files package_release.py lists (FRAMES_BUILD_INPUTS: this
# build's scripts, ForgeCore's UnityBatch, the hinge add-on, props.json and the fields of the definitions the build reads), and the model sources under
# -Cut, -Pilot and -Props (keys "cut/", "pilot/", "props/" under the recorded roots). The stage folder and the per-model outputs are rebuilt by every run,
# so they are never pinned; the icon, cockpit-art, audio and preview tools and the packaging step never reach the bundle, so they are not inputs either.
# The digests come from package_release.py, the one function the packaging check compares them with.
$inputs = python (Join-Path $tools '../package_release.py') --build-inputs | ConvertFrom-Json -AsHashtable
if ($LASTEXITCODE -ne 0) { throw 'Hashing the build inputs failed.' }
$sources = @{}
$sourceFiles = @()
foreach ($m in $Models) {
    $sourceFiles += , @('cut', $Cut, (CutFile $m))
    foreach ($kind in 'albedo', 'metallic', 'normal', 'emission') {
        $texture = Join-Path $Cut "${m}_$kind.png"
        if (Test-Path -LiteralPath $texture) { $sourceFiles += , @('cut', $Cut, $texture) }
    }
}
foreach ($name in 'PilotMotion.fbx', 'motion.json') { $sourceFiles += , @('pilot', $Pilot, "$Pilot/$name") }
foreach ($prop in (Get-Content -LiteralPath "$tools/props.json" -Raw | ConvertFrom-Json).Props) { $sourceFiles += , @('props', $Props, (Join-Path $Props $prop.File)) }
foreach ($source in $sourceFiles) {
    $key = $source[0] + '/' + [IO.Path]::GetRelativePath($source[1], $source[2]).Replace('\', '/')
    $sources[$key] = (Get-FileHash -LiteralPath $source[2] -Algorithm SHA256).Hash.ToLowerInvariant()
}
@{ format = '1.0.0'; bundleBytes = $length; bundleSha256 = $hash; models = @($Models | ForEach-Object { $prefabs[$_] } | Sort-Object); props = @($propList | Sort-Object)
   roots = @{ cut = $Cut; pilot = $Pilot; props = $Props }; inputs = $inputs; sources = $sources } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding utf8NoBOM
# The package keeps the verified bundle and its receipt in its own Assets/Frames/Models, where package_release.py reads them (the build folder is disposable).
$kept = Join-Path $tools '../../Assets/Frames/Models'
New-Item -ItemType Directory -Force $kept | Out-Null
foreach ($file in @($bundle, $receipt)) { Copy-Item -LiteralPath $file -Destination $kept -Force }
if ($Install) {
    New-Item -ItemType Directory -Force $Install | Out-Null
    Copy-Item -LiteralPath $bundle -Destination (Join-Path $Install 'forge-frames.bundle') -Force
    Write-Host "Installed the bundle into $Install."
}

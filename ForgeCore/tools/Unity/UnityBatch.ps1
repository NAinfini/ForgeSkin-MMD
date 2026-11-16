# The Unity batch step every Forge bundle build shares (ForgeCore's fonts and screen shaders, ForgeOrdnance's Carrier and Arsenal
# bundles). Dot-source it, then call Invoke-UnityBatch: it creates the project once, copies UnityBatch.cs and the build's scripts into
# its Assets/Editor, runs the one static method and returns Unity's exit code, which the caller checks with its own log handling.
function Invoke-UnityBatch([string]$Unity, [string]$Project, [string[]]$Scripts, [string]$Method, [string]$Log, [string]$CreateLog = "$Project.create.log") {
    if (!(Test-Path -LiteralPath (Join-Path $Project 'ProjectSettings'))) {
        New-Item -ItemType Directory -Force (Split-Path $Project -Parent) | Out-Null
        $proc = Start-Process -FilePath $Unity -WindowStyle Hidden -PassThru -ArgumentList @('-batchmode', '-nographics', '-quit', '-createProject', "`"$Project`"", '-logFile', "`"$CreateLog`"")
        $proc.WaitForExit()
        if ($proc.ExitCode -ne 0) { throw "Unity could not create the project; see $CreateLog" }
    }
    $editor = Join-Path $Project 'Assets/Editor'
    New-Item -ItemType Directory -Force $editor | Out-Null
    foreach ($script in @("$PSScriptRoot/UnityBatch.cs") + $Scripts) { Copy-Item -LiteralPath $script -Destination (Join-Path $editor (Split-Path $script -Leaf)) -Force }
    $proc = Start-Process -FilePath $Unity -WindowStyle Hidden -PassThru -ArgumentList @('-batchmode', '-nographics', '-quit', '-projectPath', "`"$Project`"", '-executeMethod', $Method, '-logFile', "`"$Log`"")
    $proc.WaitForExit()
    return $proc.ExitCode
}

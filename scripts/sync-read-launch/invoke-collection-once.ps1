# Operator-only handoff. This script must never be run by preparation tooling.
$ErrorActionPreference = 'Stop'
$collectionRoot = 'C:\Users\kani1\CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07'
if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'INTERACTIVE_OPERATOR_CONSOLE_REQUIRED' }
function New-CollectionConsoleAdmission([string]$ClaimPath) {
    $collectionClaimStream = [IO.FileStream]::new($ClaimPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $collectionClaimBytes = [Text.Encoding]::UTF8.GetBytes('{"kind":"ONE_USE_INTERACTIVE_CONSOLE_ADMISSION","attempt":2,"automaticRetry":false,"reusableAfterFailure":false}')
        $collectionClaimStream.Write($collectionClaimBytes, 0, $collectionClaimBytes.Length)
        $collectionClaimStream.Flush($true)
    } finally { $collectionClaimStream.Dispose() }
}
$collectionConsoleClaim = Join-Path $collectionRoot 'operator\collection-attempt-2.console-claim.json'
try { New-CollectionConsoleAdmission $collectionConsoleClaim }
catch {
    $global:LASTEXITCODE = if (Test-Path -LiteralPath $collectionConsoleClaim) { 4 } else { 3 }
    Write-Host "COLLECTION_CONSOLE_ADMISSION_REFUSED; COLLECTION_OPERATOR_EXIT=$LASTEXITCODE"
    return
}
Write-Host 'COLLECTION_CONSOLE_ADMITTED'
$collectionEnvironment = @{}
Get-ChildItem Env: | ForEach-Object { $collectionEnvironment[$_.Name] = $_.Value }
$collectionLocation = Get-Location
$collectionExit = $null
try {
    Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
    $collectionMinimal = @{
        SystemRoot='C:\Windows'; WINDIR='C:\Windows'
        PATH='C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0'
        TEMP=(Join-Path $collectionRoot 'temp'); TMP=(Join-Path $collectionRoot 'temp')
        NODE_ENV='production'; TSX_DISABLE_CACHE='1'
        TSX_TSCONFIG_PATH=(Join-Path $collectionRoot 'tsconfig.json')
        ESBUILD_BINARY_PATH=(Join-Path $collectionRoot 'node_modules\@esbuild\win32-x64\esbuild.exe')
        PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
    }
    foreach ($collectionName in $collectionMinimal.Keys) {
        [Environment]::SetEnvironmentVariable($collectionName, $collectionMinimal[$collectionName], 'Process')
    }
    Set-Location -LiteralPath $collectionRoot
    # Foreground native process retains the console and receives Ctrl+C. No jobs, redirection, retry or relaunch.
    & 'C:\Program Files\nodejs\node.exe' `
        --require "$collectionRoot\scripts\sync-read-launch\protected-module-guard.cjs" `
        --import 'file:///C:/Users/kani1/CoinDcxCollectionRuntime-48a225657b6047c7ba1a5f114f7d5d07/node_modules/tsx/dist/loader.mjs' `
        "$collectionRoot\scripts\sync-read-launch\collection-once.cjs"
    $collectionExit = $LASTEXITCODE
} catch {
    $collectionExit = 1
    Write-Host 'COLLECTION_PARENT_LAUNCH_OR_CONSOLE_FAILED; admission retained; never rerun.'
} finally {
    Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
    foreach ($collectionName in $collectionEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($collectionName, $collectionEnvironment[$collectionName], 'Process')
    }
    Set-Location -LiteralPath $collectionLocation.Path
}
if ($null -ne $collectionExit) {
    $global:LASTEXITCODE = $collectionExit
    Write-Host "COLLECTION_OPERATOR_EXIT=$collectionExit"
} else {
    Write-Host 'COLLECTION_OPERATOR_EXIT_NOT_CAPTURED: return the durable collection-exit.json; never rerun.'
}

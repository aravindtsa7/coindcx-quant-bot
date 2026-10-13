param(
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][string]$InputFile,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$GuardFile
)
$ErrorActionPreference='Stop'
function Write-DiagnosticNew([string]$File,[string]$Text) {
  $diagStream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {$diagBytes=[Text.Encoding]::UTF8.GetBytes($Text);$diagStream.Write($diagBytes,0,$diagBytes.Length);$diagStream.Flush($true)}
  finally {$diagStream.Dispose()}
}
$diagRoot=[IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
foreach($diagPath in @($InputFile,$OutputDirectory,$GuardFile)) {
  if(-not [IO.Path]::IsPathRooted($diagPath) -or -not [IO.Path]::GetFullPath($diagPath).StartsWith($diagRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'PROTECTED_DIAGNOSTIC_PATH_REQUIRED'}
}
Write-DiagnosticNew (Join-Path $OutputDirectory 'outer-start.json') ([DateTime]::UtcNow.ToString('o'))
$diagArgs=@('--require',(Join-Path $diagRoot 'scripts\sync-read-launch\protected-module-guard.cjs'),
  (Join-Path $diagRoot 'scripts\sync-read-launch\offline-prepare-diagnostic.cjs'),$InputFile,$OutputDirectory,$GuardFile)
$diagStart=[Diagnostics.ProcessStartInfo]::new()
$diagStart.FileName='C:\Program Files\nodejs\node.exe';$diagStart.WorkingDirectory=$diagRoot
$diagStart.Arguments=(($diagArgs|ForEach-Object {'"'+$_+'"'})-join ' ')
$diagStart.UseShellExecute=$false;$diagStart.CreateNoWindow=$true
$diagStart.RedirectStandardOutput=$true;$diagStart.RedirectStandardError=$true
$diagStart.EnvironmentVariables.Clear()
$diagEnvironment=@{SystemRoot='C:\Windows';WINDIR='C:\Windows';PATH='C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0';TEMP=(Join-Path $diagRoot 'temp');TMP=(Join-Path $diagRoot 'temp');NODE_ENV='production';TSX_DISABLE_CACHE='1';TSX_TSCONFIG_PATH=(Join-Path $diagRoot 'tsconfig.json');ESBUILD_BINARY_PATH=(Join-Path $diagRoot 'node_modules/@esbuild/win32-x64/esbuild.exe');PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'}
foreach($diagName in $diagEnvironment.Keys){$diagStart.EnvironmentVariables[$diagName]=$diagEnvironment[$diagName]}
$diagProcess=[Diagnostics.Process]::new();$diagProcess.StartInfo=$diagStart
$diagRecord=[ordered]@{kind='BOUNDED_OFFLINE_DIAGNOSTIC_OUTER';startedAt=[DateTime]::UtcNow.ToString('o');spawnAcknowledged=$false;pid=$null;exit=$null;signal='NOT_EXPOSED_BY_SYSTEM_DIAGNOSTICS_PROCESS';timedOut=$false;killRequested=$false;exitConfirmed=$false;cleanupStatus='UNRESOLVED';error=$null;automaticRetry=$false;supervisorResultPresent=$false}
try {
  if(-not $diagProcess.Start()){throw 'DIAGNOSTIC_PROCESS_NOT_STARTED'}
  $diagRecord.spawnAcknowledged=$true;$diagRecord.pid=$diagProcess.Id
  $diagStdout=$diagProcess.StandardOutput.ReadToEndAsync();$diagStderr=$diagProcess.StandardError.ReadToEndAsync()
  if(-not $diagProcess.WaitForExit(180000)) {
    $diagRecord.timedOut=$true
    # Stop this known parent only; never claim this confirms descendant cleanup.
    $diagRecord.killRequested=$true;$diagProcess.Kill()
    $diagRecord.exitConfirmed=$diagProcess.WaitForExit(15000)
  } else {$diagRecord.exitConfirmed=$true}
  if($diagRecord.exitConfirmed){$diagRecord.exit=$diagProcess.ExitCode}
  $diagRecord.cleanupStatus=if($diagRecord.timedOut){'TASK_CHILD_EXIT_REQUIRES_SUPERVISOR_EVIDENCE'}elseif($diagRecord.exitConfirmed){'DIAGNOSTIC_PARENT_EXIT_CONFIRMED'}else{'UNRESOLVED'}
  if($diagStdout.Wait(15000)){Write-DiagnosticNew (Join-Path $OutputDirectory 'outer.stdout.txt') $diagStdout.Result}
  if($diagStderr.Wait(15000)){Write-DiagnosticNew (Join-Path $OutputDirectory 'outer.stderr.txt') $diagStderr.Result}
} catch {$diagRecord.error=$_.Exception.GetType().FullName}
finally {
  $diagRecord.supervisorResultPresent=Test-Path -LiteralPath (Join-Path $OutputDirectory 'diagnostic-result.json')
  $diagRecord.endedAt=[DateTime]::UtcNow.ToString('o')
  Write-DiagnosticNew (Join-Path $OutputDirectory 'outer-exit.json') ($diagRecord|ConvertTo-Json -Depth 8)
  $diagProcess.Dispose()
}
$diagRecord|ConvertTo-Json -Compress
if($diagRecord.exitConfirmed -and -not $diagRecord.timedOut -and $diagRecord.supervisorResultPresent -and $diagRecord.exit -eq 0){exit 0}else{exit 1}

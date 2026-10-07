# Test-only helper: suspends/resumes a local child process with ntdll NtSuspendProcess/NtResumeProcess.
# Reads "suspend <pid>" / "resume <pid>" lines on stdin; answers "<verb> <ntstatus>". Local only; no network.
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class NtSuspend {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
"@
[Console]::Out.WriteLine("HELPER_READY"); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$parts[1])
    if ($parts[0] -eq 'suspend') { $status = [NtSuspend]::NtSuspendProcess($process.Handle) } else { $status = [NtSuspend]::NtResumeProcess($process.Handle) }
  } catch { $status = 'ERROR' }
  [Console]::Out.WriteLine("$($parts[0]) $status"); [Console]::Out.Flush()
}

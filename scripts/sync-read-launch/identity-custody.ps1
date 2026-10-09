param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$diagRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$diagSelfSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$diagTrusted = @($diagSelfSid,'S-1-5-18','S-1-5-32-544')
$diagInstallerSid = ([Security.Principal.NTAccount]::new('NT SERVICE\TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
$diagFullMask = [long]0x500D0156 # generic write/all, write data/append/EA/attributes, delete/child, WRITE_DAC/OWNER
$diagReplaceMask = [long]0x100D0040 # ancestor DELETE/DELETE_CHILD, WRITE_DAC/OWNER, generic all
$diagChecked = @{}
function Assert-DiagnosticCustody([string]$Target) {
  $diagCurrent = [IO.Path]::GetFullPath($Target)
  while ($diagCurrent) {
    if (-not $diagChecked.ContainsKey($diagCurrent)) {
      $diagItem = Get-Item -LiteralPath $diagCurrent -Force
      if ($diagItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DIAGNOSTIC_REPARSE_POINT_FORBIDDEN' }
      $diagInside = $diagCurrent -eq $diagRoot -or $diagCurrent.StartsWith($diagRoot+'\',[StringComparison]::OrdinalIgnoreCase)
      $diagMask = if ($diagInside -or -not $diagItem.PSIsContainer) { $diagFullMask } else { $diagReplaceMask }
      $diagAcl = Get-Acl -LiteralPath $diagCurrent
      # The installed OS interpreter/runtime relies on Windows servicing custody. This does not extend trust to workspace users or to the new snapshot.
      $diagOsServicingPath = -not $diagInside -and ($diagCurrent -eq 'C:\Program Files' -or $diagCurrent.StartsWith('C:\Program Files\',[StringComparison]::OrdinalIgnoreCase) -or $diagCurrent -eq 'C:\Windows' -or $diagCurrent.StartsWith('C:\Windows\',[StringComparison]::OrdinalIgnoreCase))
      foreach ($diagAce in $diagAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($diagAce.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        $diagSid = $diagAce.IdentityReference.Value
        $diagRights = ([long]$diagAce.FileSystemRights -band [long]4294967295)
        $diagTrustedAce = $diagSid -in $diagTrusted -or ($diagOsServicingPath -and $diagSid -eq $diagInstallerSid)
        if ($diagAce.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not $diagTrustedAce -and ($diagRights -band $diagMask)) { throw "DIAGNOSTIC_UNTRUSTED_WRITE_OR_REPLACEMENT:$diagCurrent" }
      }
      $diagOwner = $diagAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($diagInside -and $diagOwner -notin $diagTrusted) { throw 'DIAGNOSTIC_UNTRUSTED_OWNER' }
      $diagChecked[$diagCurrent] = $true
    }
    $diagParent = [IO.Directory]::GetParent($diagCurrent)
    if ($null -eq $diagParent) { break }
    $diagCurrent = $diagParent.FullName
  }
}
$diagInventory = Get-Content -LiteralPath (Join-Path $diagRoot 'runtime-inventory.json') -Raw | ConvertFrom-Json
if ($diagInventory.runtimeRoot -ne $diagRoot -or $diagInventory.expectedSid -ne $diagSelfSid) { throw 'DIAGNOSTIC_INVENTORY_IDENTITY_MISMATCH' }
Assert-DiagnosticCustody $diagRoot
Assert-DiagnosticCustody $diagInventory.node.path
if ((Get-FileHash -LiteralPath $diagInventory.node.path -Algorithm SHA256).Hash.ToLower() -ne $diagInventory.node.sha256) { throw 'DIAGNOSTIC_NODE_HASH_MISMATCH' }
Assert-DiagnosticCustody $diagInventory.powershell.path
if ((Get-FileHash -LiteralPath $diagInventory.powershell.path -Algorithm SHA256).Hash.ToLower() -ne $diagInventory.powershell.sha256) { throw 'DIAGNOSTIC_POWERSHELL_HASH_MISMATCH' }
foreach ($diagEntry in $diagInventory.files) {
  $diagFile = [IO.Path]::GetFullPath((Join-Path $diagRoot $diagEntry.path))
  if (-not $diagFile.StartsWith($diagRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'DIAGNOSTIC_INVENTORY_PATH_ESCAPE' }
  Assert-DiagnosticCustody $diagFile
  if ((Get-FileHash -LiteralPath $diagFile -Algorithm SHA256).Hash.ToLower() -ne $diagEntry.sha256) { throw 'DIAGNOSTIC_SNAPSHOT_HASH_MISMATCH' }
}
# Check directories too: containing-directory replacement and unexpected links matter even when files match.
Get-ChildItem -LiteralPath $diagRoot -Force -Recurse | ForEach-Object { Assert-DiagnosticCustody $_.FullName }
[PSCustomObject]@{kind='PROTECTED_IDENTITY_RUNTIME_CUSTODY';checkedAt=[DateTime]::UtcNow.ToString('o');pathsChecked=$diagChecked.Count;inventoryFiles=$diagInventory.files.Count;fileIntegrity=$true;containingDirectoryReplacementChecked=$true;reparsePointsRejected=$true;trustedHostAssumption='CURRENT_USER_SYSTEM_ADMINISTRATORS; WINDOWS_TRUSTEDINSTALLER_FOR_INSTALLED_OS_PATHS_ONLY';pipeAclEnforced=$false;remoteClientsExcluded=$false;osPeerOrProcessIdentityProven=$false} | ConvertTo-Json -Compress

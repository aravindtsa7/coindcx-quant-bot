param([Parameter(Mandatory=$true)][string]$RuntimeRoot, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# This script never opens the original .env. The only credential input is concealed local Read-Host.
$credentialRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$credentialDirectory = Join-Path $credentialRoot 'operator-credentials'
$credentialFile = Join-Path $credentialDirectory 'coindcx-api.dpapi'
function Write-ProtectedCredentialValues([Security.SecureString]$credentialKey,[Security.SecureString]$credentialSecret,[string]$credentialFile) {
  $credentialDirectory = [IO.Path]::GetDirectoryName($credentialFile)
  $diagChecked.Clear(); Assert-DiagnosticCustody $credentialDirectory
  if (Test-Path -LiteralPath $credentialFile) { throw 'CREDENTIAL_STORE_ALREADY_EXISTS' }
  Add-Type -AssemblyName System.Security
  $credentialKeyPtr = [IntPtr]::Zero; $credentialSecretPtr = [IntPtr]::Zero
  $credentialPlain = $null; $credentialStream = $null
  try {
    $credentialKeyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credentialKey)
    $credentialSecretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credentialSecret)
    $credentialKeyText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialKeyPtr)
    $credentialSecretText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialSecretPtr)
    foreach ($credentialValue in @($credentialKeyText,$credentialSecretText)) {
      if ([string]::IsNullOrEmpty($credentialValue) -or $credentialValue.Length -gt 4096 -or $credentialValue -match '[\s\x00]') { throw 'CREDENTIAL_STORE_TWO_LITERAL_VALUES_REQUIRED' }
    }
    $credentialPlain = [Text.Encoding]::UTF8.GetBytes((@{apiKey=$credentialKeyText;apiSecret=$credentialSecretText} | ConvertTo-Json -Compress))
    $credentialEncrypted = [Security.Cryptography.ProtectedData]::Protect($credentialPlain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    # Recheck after input; CreateNew closes the overwrite race. Never write plaintext or change ACLs.
    $diagChecked.Clear(); Assert-DiagnosticCustody $credentialDirectory
    $credentialStream = [IO.File]::Open($credentialFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $credentialStream.Write($credentialEncrypted,0,$credentialEncrypted.Length); $credentialStream.Flush($true)
    $credentialStream.Dispose(); $credentialStream=$null
    $diagChecked.Clear(); Assert-DiagnosticCustody $credentialFile
    Write-Output 'CREDENTIAL_STORE_CREATED_DPAPI_CURRENT_USER'
  } finally {
    if ($null -ne $credentialStream) { $credentialStream.Dispose() }
    if ($null -ne $credentialPlain) { [Array]::Clear($credentialPlain,0,$credentialPlain.Length) }
    if ($credentialKeyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialKeyPtr) }
    if ($credentialSecretPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialSecretPtr) }
    $credentialKeyText=$null; $credentialSecretText=$null; $credentialValue=$null
  }
}
try {
  # Dot-source the existing validator without changing execution policy or its trust rules.
  . ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $credentialRoot 'scripts\sync-read-launch\identity-custody.ps1')))) -RuntimeRoot $credentialRoot | Out-Null
  if (Test-Path -LiteralPath $credentialFile) { throw 'CREDENTIAL_STORE_ALREADY_EXISTS' }
  Assert-DiagnosticCustody $credentialRoot
  if (-not (Test-Path -LiteralPath $credentialDirectory)) {
    [IO.Directory]::CreateDirectory($credentialDirectory) | Out-Null
  }
  Assert-DiagnosticCustody $credentialDirectory
  # All ancestors, existing snapshot bytes and destination-directory rights pass before accepting input.
  if ($ValidateOnly) { Write-Output 'CREDENTIAL_DESTINATION_VALID_NO_INPUT'; return }
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { throw 'CONCEALED_LOCAL_CONSOLE_REQUIRED' }
  $credentialKey = Read-Host 'CoinDCX API key (concealed)' -AsSecureString
  try {
    $credentialSecret = Read-Host 'CoinDCX API secret (concealed)' -AsSecureString
    try { Write-ProtectedCredentialValues $credentialKey $credentialSecret $credentialFile }
    finally { $credentialSecret.Dispose() }
  } finally { $credentialKey.Dispose() }
} catch { throw 'PROTECTED_CREDENTIAL_PROVISIONING_REFUSED' }

param(
  [ValidateSet('start', 'stop', 'status', 'open', 'probe-dev', 'pair', 'manual', 'restore-auto')]
  [string]$Action = 'status',
  [switch]$Pause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$tailscaleExe = 'C:\Program Files\Tailscale\tailscale.exe'
$tailscaleIpnExe = 'C:\Program Files\Tailscale\tailscale-ipn.exe'
$serviceName = 'Tailscale'
$runtimeDir = Join-Path $repoRoot '.workbuddy\runtime'
$dataDir = Join-Path $env:LOCALAPPDATA 'Jiuguan\a9-private-data'
$statePath = Join-Path $runtimeDir 'private-host.json'
$stdoutPath = Join-Path $runtimeDir 'private-server.stdout.log'
$stderrPath = Join-Path $runtimeDir 'private-server.stderr.log'
$launcherErrorPath = Join-Path $runtimeDir 'private-launcher-error.log'
$buildLogPath = Join-Path $runtimeDir 'private-build.log'
$pluginSyncLogPath = Join-Path $runtimeDir 'private-commandcode-provider-sync.log'
$elevationResultPath = Join-Path $runtimeDir 'private-elevation-result.json'
$elevationResultTempPath = $elevationResultPath + '.tmp'
$serveSetupStdoutPath = Join-Path $runtimeDir 'private-serve-setup.stdout.tmp'
$serveSetupStderrPath = Join-Path $runtimeDir 'private-serve-setup.stderr.tmp'
$activePointerPath = Join-Path $dataDir 'security\active-generation'
$hostReleaseRoot = Join-Path $repoRoot '.workbuddy\host-release'
$hostReleasePointer = Join-Path $hostReleaseRoot 'current.txt'
$serverTarget = 'http://127.0.0.1:17800'
$agentRuntimeProfile = 'public-safe-v0.1'
$agentRuntimeProfilePath = Join-Path $PSScriptRoot ($agentRuntimeProfile + '.env')
$agentRuntimeEnvironment = $null
$agentRuntimeProfileDigest = $null
$runtimeRevision = $null
$startupDir = [Environment]::GetFolderPath('CommonStartup')
$startupLink = Join-Path $startupDir 'Tailscale.lnk'
$disabledStartupLink = $startupLink + '.disabled'
Set-Location -LiteralPath $repoRoot

function Write-Step([string]$message) {
  Write-Host ('[Jiuguan private access] ' + $message)
}

function Write-JsonUtf8NoBom([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $encoding)
}

function Read-AgentRuntimeEnvironment {
  if (-not (Test-Path -LiteralPath $agentRuntimeProfilePath -PathType Leaf) -or
      (Get-Item -LiteralPath $agentRuntimeProfilePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Agent runtime profile is missing or invalid: $agentRuntimeProfilePath"
  }
  $allowed = @(
    'JG_AGENT_RUNTIME_PROFILE',
    'JG_AGENT_LANE_ROLLOUT', 'JG_AGENT_LANE_ROLLOUT_ACK',
    'JG_AGENT_CONTROL_MUTATION', 'JG_AGENT_CONTROL_MUTATION_ACK',
    'JG_AGENT_ADMISSION', 'JG_AGENT_ADMISSION_ACK', 'JG_AGENT_ADMISSION_SESSION_ALLOWLIST',
    'JG_AGENT_LEARNING_TEXT', 'JG_AGENT_LEARNING_TEXT_ACK', 'JG_HARNESS_INTERACTIVE',
    'JG_HARNESS_INTERACTIVE_ACK',
    'JG_HARNESS_BACKGROUND', 'JG_HARNESS_INPUT_MICROUSD_PER_MTOK',
    'JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK',
    'JG_CONTEXT_COMPILER', 'JG_CONTEXT_COMPILER_ACK',
    'JG_CONTEXT_COMPILER_SESSION_IDS', 'JG_CONTEXT_COMPILER_KILL_SWITCH',
    'JG_MAINTENANCE_ADMISSION',
    'JG_MAINTENANCE_ADMISSION_ACK', 'JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST',
    'JG_MAINTENANCE_APPLY', 'JG_MAINTENANCE_APPLY_ACK', 'JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST'
  )
  $values = [ordered]@{}
  foreach ($rawLine in Get-Content -LiteralPath $agentRuntimeProfilePath) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw 'Agent runtime profile contains an invalid line.' }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    if ($allowed -notcontains $name -or $values.Contains($name) -or $value.Length -eq 0) {
      throw 'Agent runtime profile contains an unknown, duplicate, or empty key.'
    }
    $values[$name] = $value
  }
  if ($values.Count -ne $allowed.Count -or
      [string]$values.JG_AGENT_RUNTIME_PROFILE -ne $agentRuntimeProfile -or
      [string]$values.JG_AGENT_LANE_ROLLOUT -ne 'interactive=off,learning=off,maintenance=off' -or
      [string]$values.JG_AGENT_LANE_ROLLOUT_ACK -ne 'p14-lane-rollout-v2' -or
      [string]$values.JG_AGENT_CONTROL_MUTATION -ne 'off' -or
      [string]$values.JG_AGENT_CONTROL_MUTATION_ACK -ne 'p14-agent-control-mutation-v1' -or
      [string]$values.JG_AGENT_ADMISSION -ne 'off' -or
      [string]$values.JG_AGENT_ADMISSION_ACK -ne 'p14-quality-beta-v1' -or
      [string]$values.JG_AGENT_ADMISSION_SESSION_ALLOWLIST -ne 'disabled' -or
      [string]$values.JG_AGENT_LEARNING_TEXT -ne 'off' -or
      [string]$values.JG_AGENT_LEARNING_TEXT_ACK -ne 'p14-learning-text-provider-v1' -or
      [string]$values.JG_HARNESS_INTERACTIVE -ne 'off' -or
      [string]$values.JG_HARNESS_INTERACTIVE_ACK -ne 'p13c-v1' -or
      [string]$values.JG_HARNESS_BACKGROUND -ne 'off' -or
      [string]$values.JG_CONTEXT_COMPILER -ne 'off' -or
      [string]$values.JG_CONTEXT_COMPILER_ACK -ne 'p14-q9r-context-compiler-v1' -or
      [string]$values.JG_CONTEXT_COMPILER_SESSION_IDS -ne 'disabled' -or
      [string]$values.JG_CONTEXT_COMPILER_KILL_SWITCH -ne '1' -or
      [string]$values.JG_MAINTENANCE_ADMISSION -ne 'off' -or
      [string]$values.JG_MAINTENANCE_ADMISSION_ACK -ne 'p14-maintenance-enforce-v2' -or
      [string]$values.JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST -ne 'disabled' -or
      [string]$values.JG_MAINTENANCE_APPLY -ne 'off' -or
      [string]$values.JG_MAINTENANCE_APPLY_ACK -ne 'p14-maintenance-apply-v1' -or
      [string]$values.JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST -ne 'disabled' -or
      [string]$values.JG_HARNESS_INPUT_MICROUSD_PER_MTOK -notmatch '^[1-9][0-9]{0,8}$' -or
      [string]$values.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK -notmatch '^[1-9][0-9]{0,8}$') {
    throw 'Agent runtime profile violates the public-safe v0.1 boundary.'
  }
  return $values
}

function Initialize-AgentRuntimeProfile {
  if ($null -ne $script:agentRuntimeEnvironment -and
      -not [string]::IsNullOrWhiteSpace([string]$script:agentRuntimeProfileDigest)) {
    return
  }
  $script:agentRuntimeEnvironment = Read-AgentRuntimeEnvironment
  $script:agentRuntimeProfileDigest =
    (Get-FileHash -LiteralPath $agentRuntimeProfilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Restart-Elevated {
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  foreach ($path in @($elevationResultPath, $elevationResultTempPath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'),
    '-Action', $Action
  )
  if ($Pause) {
    $arguments += '-Pause'
  }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $elevationResultPath -PathType Leaf) {
      $result = Get-Content -LiteralPath $elevationResultPath -Raw | ConvertFrom-Json
      Remove-Item -LiteralPath $elevationResultPath -Force
      exit ([int]$result.exitCode)
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Timed out waiting for the elevated Jiuguan operation result.'
}

function Require-Elevation {
  if (-not (Test-Administrator)) {
    Write-Step 'Requesting administrator rights to control the Tailscale Windows service.'
    Restart-Elevated
  }
}

function Invoke-Tailscale([string[]]$TailArgs, [switch]$IgnoreExitCode) {
  if (-not (Test-Path -LiteralPath $tailscaleExe -PathType Leaf)) {
    throw "Tailscale CLI was not found: $tailscaleExe"
  }
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $tailscaleExe @TailArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if (-not $IgnoreExitCode -and $exitCode -ne 0) {
    throw "tailscale $($TailArgs -join ' ') failed (exit=$exitCode): $($output -join [Environment]::NewLine)"
  }
  return @($output)
}

function Invoke-TailscaleServeSetup {
  foreach ($path in @($serveSetupStdoutPath, $serveSetupStderrPath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
  $process = $null
  try {
    $process = Start-Process -FilePath $tailscaleExe -ArgumentList @(
      'serve', '--bg', '--yes', $serverTarget
    ) -RedirectStandardOutput $serveSetupStdoutPath -RedirectStandardError $serveSetupStderrPath -WindowStyle Hidden -PassThru
    $serveExited = $process.WaitForExit(20000)
    if (-not $serveExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit()
      $combined = @(
        if (Test-Path -LiteralPath $serveSetupStdoutPath) { Get-Content -LiteralPath $serveSetupStdoutPath -Raw }
        if (Test-Path -LiteralPath $serveSetupStderrPath) { Get-Content -LiteralPath $serveSetupStderrPath -Raw }
      ) -join [Environment]::NewLine
      if ($combined -match 'Serve is not enabled on your tailnet') {
        throw 'Tailscale Serve/HTTPS is not enabled. On a device already signed in to this tailnet, open https://login.tailscale.com/admin/dns, enable MagicDNS and HTTPS Certificates once, then run the Jiuguan private launcher again.'
      }
      throw 'Tailscale Serve setup timed out after 20 seconds; the CLI was stopped and the private launcher will roll back.'
    }
    $process.WaitForExit()
    $serveExitCode = $process.ExitCode
    $combined = @(
      if (Test-Path -LiteralPath $serveSetupStdoutPath) { Get-Content -LiteralPath $serveSetupStdoutPath -Raw }
      if (Test-Path -LiteralPath $serveSetupStderrPath) { Get-Content -LiteralPath $serveSetupStderrPath -Raw }
    ) -join [Environment]::NewLine
    if ($null -ne $serveExitCode -and $serveExitCode -ne 0) {
      $safeOutput = $combined -replace 'https://login\.tailscale\.com/\S+', '[Tailscale admin consent URL redacted]'
      throw "tailscale serve setup failed (exit=$serveExitCode): $safeOutput"
    }
    if (-not [string]::IsNullOrWhiteSpace($combined)) {
      $combined -split [Environment]::NewLine | ForEach-Object { if ($_ -ne '') { Write-Host $_ } }
    }
  } finally {
    foreach ($path in @($serveSetupStdoutPath, $serveSetupStderrPath)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}

function Get-TailscaleStatus {
  $raw = (Invoke-Tailscale @('status', '--json')) -join [Environment]::NewLine
  return $raw | ConvertFrom-Json
}

function Wait-For([scriptblock]$Condition, [string]$Failure, [int]$TimeoutSeconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if (& $Condition) {
        return
      }
    } catch {
      # Transient failures are expected while a service or HTTP endpoint starts.
    }
    Start-Sleep -Milliseconds 500
  }
  throw $Failure
}

function Disable-TailscaleAutostart {
  Set-Service -Name $serviceName -StartupType Manual
  if ((Test-Path -LiteralPath $startupLink) -and (Test-Path -LiteralPath $disabledStartupLink)) {
    throw "Both the Tailscale startup link and its disabled backup exist: $startupDir"
  }
  if (Test-Path -LiteralPath $startupLink) {
    Move-Item -LiteralPath $startupLink -Destination $disabledStartupLink
  }
}

function Restore-TailscaleAutostart {
  if ((Test-Path -LiteralPath $startupLink) -and (Test-Path -LiteralPath $disabledStartupLink)) {
    throw "Both the Tailscale startup link and its disabled backup exist: $startupDir"
  }
  if (Test-Path -LiteralPath $disabledStartupLink) {
    Move-Item -LiteralPath $disabledStartupLink -Destination $startupLink
  }
  Set-Service -Name $serviceName -StartupType Automatic
}

function Read-ManagedState {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}

function Test-AgentRuntimeProfile($state) {
  return $null -ne $state -and
    $null -ne $state.PSObject.Properties['agentRuntimeProfile'] -and
    $null -ne $state.PSObject.Properties['agentRuntimeProfileDigest'] -and
    [string]$state.agentRuntimeProfile -eq $agentRuntimeProfile -and
    [string]$state.agentRuntimeProfileDigest -eq $agentRuntimeProfileDigest
}

function Test-ManagedRuntimeState($state) {
  return (Test-AgentRuntimeProfile $state) -and
    $null -ne $state.PSObject.Properties['runtimeRevision'] -and
    [string]$state.runtimeRevision -eq $runtimeRevision
}

function Get-ActiveHostRelease {
  if (-not (Test-Path -LiteralPath $hostReleasePointer -PathType Leaf)) {
    return $null
  }
  $releaseId = (Get-Content -LiteralPath $hostReleasePointer -Raw).Trim()
  if ($releaseId -notmatch '^[A-Za-z0-9._-]{1,80}$') {
    throw 'Host release pointer is invalid.'
  }
  $releaseDir = Join-Path (Join-Path $hostReleaseRoot 'releases') $releaseId
  $manifestPath = Join-Path $releaseDir 'host-release.json'
  $serverEntry = Join-Path $releaseDir 'dist-runtime\apps\server\server.js'
  $webDist = Join-Path $releaseDir 'web'
  $webEntry = Join-Path $webDist 'index.html'
  $pluginDir = Join-Path $releaseDir 'plugin'
  $pluginEntry = Join-Path $pluginDir 'index.js'
  $pluginPackage = Join-Path $pluginDir 'package.json'
  foreach ($directory in @($releaseDir, $webDist, $pluginDir)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container) -or
        (Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Host release directory is invalid: $directory"
    }
  }
  foreach ($path in @($manifestPath, $serverEntry, $webEntry, $pluginEntry, $pluginPackage)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Host release $releaseId is incomplete: $path"
    }
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Host release contains a reparse point: $path"
    }
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([string]$manifest.releaseId -ne $releaseId -or [string]$manifest.commit -notmatch '^[a-f0-9]{40}$') {
    throw 'Host release manifest identity is invalid.'
  }
  if ([string]$manifest.artifacts.runtimeEntry -ne 'dist-runtime/apps/server/server.js' -or
      [string]$manifest.artifacts.webEntry -ne 'web/index.html' -or
      [string]$manifest.artifacts.pluginEntry -ne 'plugin/index.js') {
    throw 'Host release artifact mapping is invalid.'
  }
  $artifactChecks = @(
    [pscustomobject]@{ Path = $serverEntry; Hash = [string]$manifest.artifacts.runtimeSha256 },
    [pscustomobject]@{ Path = $webEntry; Hash = [string]$manifest.artifacts.webSha256 },
    [pscustomobject]@{ Path = $pluginEntry; Hash = [string]$manifest.artifacts.pluginSha256 }
  )
  foreach ($artifact in $artifactChecks) {
    if ($artifact.Hash -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $artifact.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.Hash) {
      throw "Host release artifact hash mismatch: $($artifact.Path)"
    }
  }
  $pluginMetadata = Get-Content -LiteralPath $pluginPackage -Raw | ConvertFrom-Json
  if ([string]$pluginMetadata.name -ne 'commandcode-provider' -or
      [string]$pluginMetadata.main -ne 'index.js' -or
      [string]$pluginMetadata.type -ne 'module' -or
      [string]$pluginMetadata.version -ne [string]$manifest.components.plugin -or
      [int]$pluginMetadata.jiuguan.hostApi -ne 1) {
    throw 'Host release plugin package metadata does not match its manifest.'
  }
  return [pscustomobject]@{
    releaseId = $releaseId
    commit = [string]$manifest.commit
    serverEntry = $serverEntry
    webDist = $webDist
    pluginDir = $pluginDir
  }
}

function Get-RuntimeRevision($activeRelease) {
  if ($null -ne $activeRelease) {
    return 'release:' + [string]$activeRelease.releaseId + ':' + [string]$activeRelease.commit
  }
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $revisionOutput = & (Get-Command git.exe -ErrorAction Stop).Source rev-parse --verify HEAD 2>&1
    $revisionExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  $revision = (@($revisionOutput) -join '').Trim().ToLowerInvariant()
  if ($revisionExitCode -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$') {
    throw 'Could not resolve the Jiuguan source revision for managed runtime reuse.'
  }
  return 'source:' + $revision
}

function Get-ManagedServerProcess {
  $state = Read-ManagedState
  if ($null -eq $state) {
    return $null
  }
  $serverPid = [int]$state.pid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }
  if ($process.Name -notmatch '^node(\.exe)?$' -or $process.CommandLine -notmatch 'apps[\\/]server[\\/]server\.(ts|js)') {
    throw "PID $serverPid does not belong to Jiuguan server; refusing to stop another process."
  }
  return $process
}

function Test-LocalHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($serverTarget + '/health') -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Stop-ManagedServer {
  $process = Get-ManagedServerProcess
  if ($null -ne $process) {
    Write-Step "Stopping Jiuguan server PID $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force
    Wait-For {
      $null -eq (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)
    } "Jiuguan server PID $($process.ProcessId) did not stop." 15
  }
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force
  }
}

function Stop-ManagedTailscaleIpn([int]$IpnPid) {
  if ($IpnPid -le 0) {
    return
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$IpnPid" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
  }
  if ($process.Name -ne 'tailscale-ipn.exe' -or $process.ExecutablePath -ne $tailscaleIpnExe) {
    throw "PID $IpnPid does not belong to the managed Tailscale IPN frontend; refusing to stop it."
  }
  Stop-Process -Id $IpnPid -Force
  Wait-For {
    $null -eq (Get-Process -Id $IpnPid -ErrorAction SilentlyContinue)
  } "Tailscale IPN frontend PID $IpnPid did not stop." 15
}

function Repair-ExistingPrivateConnectivity($serverProcess) {
  $managedState = Read-ManagedState
  if ($null -eq $managedState) {
    throw 'Managed Jiuguan server has no private runtime state; refusing to guess its security origin.'
  }

  Start-Service -Name $serviceName
  Wait-For {
    (Get-Service -Name $serviceName).Status -eq 'Running'
  } 'The Tailscale Windows service did not start.'

  $ipnProcess = Get-Process -Name 'tailscale-ipn' -ErrorAction SilentlyContinue | Select-Object -First 1
  $ownsIpnProcess = $false
  if ($null -eq $ipnProcess) {
    if (-not (Test-Path -LiteralPath $tailscaleIpnExe -PathType Leaf)) {
      throw "Tailscale IPN frontend was not found: $tailscaleIpnExe"
    }
    Write-Step 'Restarting the Tailscale user frontend for this Jiuguan session'
    $ipnProcess = Start-Process -FilePath $tailscaleIpnExe -WindowStyle Hidden -PassThru
    $ownsIpnProcess = $true
  } elseif ($managedState.ownsIpn -eq $true) {
    # Preserve the managed-session ownership intent if the Tailscale frontend
    # restarted with a new PID while Jiuguan stayed up. Stop must still close it.
    $ownsIpnProcess = $true
  }

  $status = Get-TailscaleStatus
  if ($status.BackendState -ne 'Running') {
    Write-Step 'Repairing the tailnet connection'
    Invoke-Tailscale @('up', '--timeout=90s') | ForEach-Object { Write-Host $_ }
    Wait-For {
      (Get-TailscaleStatus).BackendState -eq 'Running'
    } 'Tailscale did not reconnect to the tailnet.' 60
    $status = Get-TailscaleStatus
  }

  $dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
  $origin = 'https://' + $dnsName
  if ($dnsName -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$' -or [string]$managedState.origin -ne $origin) {
    throw 'The restored Tailscale identity does not match the secured Jiuguan server origin; stop and start the private launcher.'
  }

  $serveStatus = (Invoke-Tailscale @('serve', 'status', '--json') -IgnoreExitCode) -join [Environment]::NewLine
  if ($serveStatus -notmatch [regex]::Escape('127.0.0.1:17800')) {
    Write-Step 'Repairing the tailnet-only HTTPS Serve mapping'
    Invoke-TailscaleServeSetup
    $serveStatus = (Invoke-Tailscale @('serve', 'status', '--json')) -join [Environment]::NewLine
  }
  if ($serveStatus -notmatch [regex]::Escape('127.0.0.1:17800')) {
    throw 'Tailscale Serve repair did not target Jiuguan loopback port 17800.'
  }

  Write-JsonUtf8NoBom -Path $statePath -Value ([ordered]@{
    pid = $serverProcess.ProcessId
    origin = $origin
    dataDir = [string]$managedState.dataDir
    agentRuntimeProfile = $agentRuntimeProfile
    agentRuntimeProfileDigest = $agentRuntimeProfileDigest
    runtimeRevision = $runtimeRevision
    ipnPid = if ($ownsIpnProcess) { $ipnProcess.Id } else { $null }
    ownsIpn = $ownsIpnProcess
    startedAt = [string]$managedState.startedAt
  })
}

function Set-TemporaryEnvironmentAndStartServer([string]$origin, $activeRelease) {
  $names = @(
    'JG_ACCESS_MODE', 'JG_PUBLIC_HTTPS_ORIGINS', 'JG_USER_DATA_DIR', 'JG_WEB_PORT',
    'JG_WEB_DIST', 'JG_BUILD_SHA', 'NODE_OPTIONS'
  )
  $names += @($agentRuntimeEnvironment.Keys)
  $before = @{}
  foreach ($name in $names) {
    $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:JG_ACCESS_MODE = 'secured'
    $env:JG_PUBLIC_HTTPS_ORIGINS = $origin
    $env:JG_USER_DATA_DIR = $dataDir
    $env:JG_WEB_PORT = '17800'
    $env:NODE_OPTIONS = ''
    # P14-Q9 canary: lane settings are ceilings; proposal application still requires
    # an authenticated trusted-local POST plus explicit UI confirmation and CAS.
    foreach ($entry in $agentRuntimeEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    if ($null -eq $activeRelease) {
      $serverArgs = @('--experimental-strip-types', '--experimental-transform-types', 'apps/server/server.ts')
    } else {
      $env:JG_WEB_DIST = $activeRelease.webDist
      $env:JG_BUILD_SHA = $activeRelease.commit
      $serverArgs = @($activeRelease.serverEntry)
      Write-Step "Using host release $($activeRelease.releaseId)"
    }
    $startParams = @{
      FilePath = $nodeExe
      ArgumentList = $serverArgs
      WorkingDirectory = $repoRoot
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      WindowStyle = 'Hidden'
      PassThru = $true
    }
    return Start-Process @startParams
  } finally {
    foreach ($name in $names) {
      if ($null -eq $before[$name]) {
        Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable($name, [string]$before[$name], 'Process')
      }
    }
  }
}

function Invoke-AuthBootstrap {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Write-Host 'The pairing code below is shown once. Enter it only on your own phone.'
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $nodeExe --experimental-strip-types --experimental-transform-types tools/cli/auth-bootstrap.ts --data-dir $dataDir
    $bootstrapExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($bootstrapExitCode -ne 0) {
    throw "Auth bootstrap failed (exit=$bootstrapExitCode)."
  }
  Read-Host 'Save the pairing code, then press Enter to continue'
}

function Ensure-AuthBootstrap {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  if (Test-Path -LiteralPath $activePointerPath -PathType Leaf) {
    return
  }
  Write-Step 'First private validation requires a local auth root and one-time admin pairing code.'
  Invoke-AuthBootstrap
}

function Invoke-CommandCodeProviderSync($activeRelease) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $names = @('JG_USER_DATA_DIR', 'JG_WEB_PORT', 'NODE_OPTIONS')
  $before = @{}
  foreach ($name in $names) {
    $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $oldPreference = $ErrorActionPreference
  try {
    $env:JG_USER_DATA_DIR = $dataDir
    $env:JG_WEB_PORT = '17800'
    $env:NODE_OPTIONS = ''
    $ErrorActionPreference = 'Continue'
    $pluginOutput = @()
    if ($null -eq $activeRelease) {
      Write-Step 'Building and synchronizing the worktree CommandCode Provider into private data'
      $pnpmExe = (Get-Command pnpm.cmd -ErrorAction Stop).Source
      $buildOutput = & $pnpmExe --filter commandcode-provider build 2>&1
      $buildExitCode = $LASTEXITCODE
      $pluginOutput += @($buildOutput)
      if ($buildExitCode -ne 0) {
        @($pluginOutput) | Set-Content -LiteralPath $pluginSyncLogPath -Encoding UTF8
        throw "CommandCode Provider build failed (exit=$buildExitCode); inspect $pluginSyncLogPath"
      }
      $nodeExe = (Get-Command node -ErrorAction Stop).Source
      $syncOutput = & $nodeExe --experimental-strip-types --experimental-transform-types plugins/commandcode-provider/sync.ts --data-dir $dataDir 2>&1
    } else {
      Write-Step "Synchronizing the pre-verified CommandCode Provider from host release $($activeRelease.releaseId)"
      $nodeExe = (Get-Command node -ErrorAction Stop).Source
      $syncOutput = & $nodeExe --experimental-strip-types --experimental-transform-types plugins/commandcode-provider/sync.ts --data-dir $dataDir --source-dir $activeRelease.pluginDir 2>&1
    }
    $syncExitCode = $LASTEXITCODE
    $pluginOutput += @($syncOutput)
    @($pluginOutput) | Set-Content -LiteralPath $pluginSyncLogPath -Encoding UTF8
    if ($syncExitCode -ne 0) {
      throw "CommandCode Provider sync failed (exit=$syncExitCode); inspect $pluginSyncLogPath"
    }
  } finally {
    $ErrorActionPreference = $oldPreference
    foreach ($name in $names) {
      if ($null -eq $before[$name]) {
        Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable($name, [string]$before[$name], 'Process')
      }
    }
  }
}

function Show-NewPairingCode {
  if (-not (Test-LocalHealth)) {
    throw 'Start Jiuguan private access before issuing a phone pairing code.'
  }
  Write-Step 'Issuing a one-time phone pairing code (15 minute lifetime).'
  Invoke-AuthBootstrap
}

function Start-PrivateTavern {
  Require-Elevation
  Initialize-AgentRuntimeProfile
  $activeRelease = Get-ActiveHostRelease
  $script:runtimeRevision = Get-RuntimeRevision $activeRelease
  Disable-TailscaleAutostart

  $preserveIpnOwnership = $false
  $existing = Get-ManagedServerProcess
  if ($null -ne $existing -and -not (Test-ManagedRuntimeState (Read-ManagedState))) {
    $staleState = Read-ManagedState
    $preserveIpnOwnership = $null -ne $staleState.PSObject.Properties['ownsIpn'] -and
      $staleState.ownsIpn -eq $true
    Write-Step 'Managed server code or Agent profile is stale; restarting it with the current test-session ceiling.'
    Stop-ManagedServer
    $existing = $null
  }
  if ($null -ne $existing) {
    Repair-ExistingPrivateConnectivity $existing
    Write-Step "Jiuguan private server is already running (PID $($existing.ProcessId))."
    Show-PrivateStatus
    return
  }
  $foreignListener = Get-NetTCPConnection -State Listen -LocalPort 17800 -ErrorAction SilentlyContinue
  if ($null -ne $foreignListener) {
    throw "Port 17800 is owned by PID $($foreignListener.OwningProcess -join ','); refusing to replace it."
  }

  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $serverProcess = $null
  $ipnProcess = $null
  $ownsIpnProcess = $preserveIpnOwnership
  try {
    if (Test-Path -LiteralPath $launcherErrorPath) {
      Remove-Item -LiteralPath $launcherErrorPath -Force
    }
    if (Test-Path -LiteralPath $buildLogPath) {
      Remove-Item -LiteralPath $buildLogPath -Force
    }
    if (Test-Path -LiteralPath $pluginSyncLogPath) {
      Remove-Item -LiteralPath $pluginSyncLogPath -Force
    }
    Invoke-CommandCodeProviderSync $activeRelease
    Start-Service -Name $serviceName
    Wait-For {
      (Get-Service -Name $serviceName).Status -eq 'Running'
    } 'The Tailscale Windows service did not start.'

    $ipnProcess = Get-Process -Name 'tailscale-ipn' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $ipnProcess) {
      if (-not (Test-Path -LiteralPath $tailscaleIpnExe -PathType Leaf)) {
        throw "Tailscale IPN frontend was not found: $tailscaleIpnExe"
      }
      Write-Step 'Starting the Tailscale user frontend for this Jiuguan session'
      $ipnProcess = Start-Process -FilePath $tailscaleIpnExe -WindowStyle Hidden -PassThru
      $ownsIpnProcess = $true
    } elseif ($preserveIpnOwnership) {
      # A profile-only server restart must not lose the prior Jiuguan-owned IPN intent.
      $ownsIpnProcess = $true
    }

    $status = Get-TailscaleStatus
    if ($status.BackendState -ne 'Running') {
      Write-Step 'Connecting to the tailnet'
      Invoke-Tailscale @('up', '--timeout=90s') | ForEach-Object { Write-Host $_ }
      Wait-For {
        (Get-TailscaleStatus).BackendState -eq 'Running'
      } 'Tailscale did not connect to the tailnet.' 60
      $status = Get-TailscaleStatus
      if ($status.BackendState -ne 'Running') {
        throw "Tailscale did not connect to the tailnet (backendState=$($status.BackendState))."
      }
    }
    $dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
    if ($dnsName -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$') {
      throw 'Tailscale did not return a canonical DNSName.'
    }
    $origin = 'https://' + $dnsName

    Ensure-AuthBootstrap
    if ($null -eq $activeRelease) {
      Write-Step 'Building the production Web app'
      $oldNodeOptions = $env:NODE_OPTIONS
      $oldPreference = $ErrorActionPreference
      try {
        $env:NODE_OPTIONS = ''
        $ErrorActionPreference = 'Continue'
        $buildOutput = & (Get-Command pnpm.cmd -ErrorAction Stop).Source build:web 2>&1
        $buildExitCode = $LASTEXITCODE
        @($buildOutput) | Set-Content -LiteralPath $buildLogPath -Encoding UTF8
        if ($buildExitCode -ne 0) {
          throw "Production Web build failed (exit=$buildExitCode); inspect $buildLogPath"
        }
      } finally {
        $ErrorActionPreference = $oldPreference
        $env:NODE_OPTIONS = $oldNodeOptions
      }
    } else {
      Write-Step "Using pre-verified Web assets from host release $($activeRelease.releaseId)"
    }

    Write-Step "Starting secured Jiuguan: $serverTarget"
    $serverProcess = Set-TemporaryEnvironmentAndStartServer $origin $activeRelease
    Wait-For { Test-LocalHealth } "Jiuguan did not become healthy; inspect $stderrPath" 60

    Write-Step 'Creating tailnet-only HTTPS Serve (Funnel is not used)'
    Invoke-Tailscale @('serve', 'reset') -IgnoreExitCode | Out-Null
    Invoke-TailscaleServeSetup
    $serveStatus = (Invoke-Tailscale @('serve', 'status', '--json')) -join [Environment]::NewLine
    if ($serveStatus -notmatch [regex]::Escape('127.0.0.1:17800')) {
      throw 'Serve status does not target Jiuguan loopback port 17800.'
    }

    Write-JsonUtf8NoBom -Path $statePath -Value ([ordered]@{
      pid = $serverProcess.Id
      origin = $origin
      dataDir = $dataDir
      agentRuntimeProfile = $agentRuntimeProfile
      agentRuntimeProfileDigest = $agentRuntimeProfileDigest
      runtimeRevision = $runtimeRevision
      ipnPid = if ($ownsIpnProcess) { $ipnProcess.Id } else { $null }
      ownsIpn = $ownsIpnProcess
      startedAt = [DateTime]::UtcNow.ToString('o')
    })

    Write-Host ''
    Write-Step "Started: $origin"
    Write-Host 'Keep Tailscale connected on the phone and open the HTTPS URL above.'
    Write-Host 'Run stop.bat to reset Serve, disconnect Tailscale, and stop its Windows service.'
  } catch {
    $publicFailure = [string]$_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($publicFailure)) {
      $publicFailure = 'Private launcher failed without an exception message.'
    }
    $diagnostic = ($_ | Format-List * -Force | Out-String)
    @(
      $publicFailure,
      '',
      $diagnostic
    ) | Set-Content -LiteralPath $launcherErrorPath -Encoding UTF8
    if ($null -ne $serverProcess -and $null -ne (Get-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $serverProcess.Id -Force
    }
    Invoke-Tailscale @('serve', 'reset') -IgnoreExitCode | Out-Null
    Invoke-Tailscale @('down') -IgnoreExitCode | Out-Null
    if ($ownsIpnProcess -and $null -ne $ipnProcess) {
      Stop-ManagedTailscaleIpn $ipnProcess.Id
    }
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    throw $publicFailure
  }
}

function Stop-PrivateTavern {
  Require-Elevation
  $managedState = Read-ManagedState
  $service = Get-Service -Name $serviceName -ErrorAction Stop
  if ($service.Status -ne 'Running') {
    Start-Service -Name $serviceName
    Wait-For {
      (Get-Service -Name $serviceName).Status -eq 'Running'
    } 'Tailscale could not start temporarily to clear its persisted Serve configuration.'
  }

  Write-Step 'Resetting Tailscale Serve'
  Invoke-Tailscale @('serve', 'reset') -IgnoreExitCode | Out-Null
  Stop-ManagedServer
  Write-Step 'Disconnecting from the tailnet'
  Invoke-Tailscale @('down') -IgnoreExitCode | Out-Null
  if ($null -ne $managedState -and $managedState.ownsIpn -eq $true) {
    Write-Step 'Stopping the managed Tailscale user frontend'
    Stop-ManagedTailscaleIpn ([int]$managedState.ipnPid)
  }
  Write-Step 'Stopping the Tailscale Windows service'
  Stop-Service -Name $serviceName -Force
  Disable-TailscaleAutostart
  Write-Step 'Stopped completely; only the Jiuguan private launcher will start it again.'
}

function Show-PrivateStatus {
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  Write-Host "Tailscale service: $($service.State); startup mode: $($service.StartMode)"
  $state = Read-ManagedState
  if ($null -ne $state -and (Test-LocalHealth)) {
    Write-Host "Jiuguan private server: running (managed PID $($state.pid))"
  } else {
    Write-Host 'Jiuguan private server: stopped or unhealthy'
  }
  if ($service.State -eq 'Running') {
    $status = Get-TailscaleStatus
    Write-Host "Tailnet: $($status.BackendState)"
    Invoke-Tailscale @('serve', 'status') -IgnoreExitCode | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host 'Serve: unavailable (Tailscale service is stopped)'
  }
}

function Assert-LocalDevelopmentServer {
  Initialize-AgentRuntimeProfile
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($serverTarget + '/api/capabilities') `
      -Headers @{ Origin = 'http://localhost:5173' } -TimeoutSec 2
  } catch {
    exit 4
  }
  if ($response.StatusCode -ne 200) {
    exit 4
  }
  $meta = $response.Content | ConvertFrom-Json
  if ([string]$meta.app.name -ne 'jiuguan' -or
      [int]$meta.api.protocolVersion -lt 1 -or
      $meta.auth.required -ne $false -or
      [string]$response.Headers['X-JG-Agent-Runtime-Profile'] -ne $agentRuntimeProfile) {
    exit 4
  }
}

function Get-ValidatedPrivateOrigin {
  $state = Read-ManagedState
  if ($null -eq $state -or $null -eq (Get-ManagedServerProcess) -or -not (Test-LocalHealth)) {
    return $null
  }
  $raw = [string]$state.origin
  $uri = $null
  if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri)) {
    return $null
  }
  if ($uri.Scheme -ne 'https' -or -not $uri.IsDefaultPort -or
      $uri.AbsolutePath -ne '/' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or
      $uri.UserInfo -ne '' -or
      -not $uri.DnsSafeHost.EndsWith('.ts.net', [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  try {
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne 'Running') {
      return $null
    }
    $status = Get-TailscaleStatus
    if ([string]$status.BackendState -ne 'Running') {
      return $null
    }
    $dnsName = ([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
    if ($uri.GetLeftPart([UriPartial]::Authority) -ne ('https://' + $dnsName)) {
      return $null
    }
    $serveStatus = (Invoke-Tailscale @('serve', 'status', '--json')) -join [Environment]::NewLine
    if ($serveStatus -notmatch [regex]::Escape('127.0.0.1:17800')) {
      return $null
    }
  } catch {
    return $null
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

function Open-PrivateTavern {
  Initialize-AgentRuntimeProfile
  $activeRelease = Get-ActiveHostRelease
  $script:runtimeRevision = Get-RuntimeRevision $activeRelease
  $state = Read-ManagedState
  if ($null -ne $state -and $null -ne (Get-ManagedServerProcess) -and
      (Test-LocalHealth) -and -not (Test-ManagedRuntimeState $state)) {
    exit 5
  }
  $privateOrigin = Get-ValidatedPrivateOrigin
  if ([string]::IsNullOrWhiteSpace($privateOrigin)) {
    exit 3
  }
  Start-Process -FilePath $privateOrigin | Out-Null
  Write-Step "Opened the managed private origin: $privateOrigin"
  exit 0
}

$scriptExitCode = 0
try {
  switch ($Action) {
    'start' {
      Start-PrivateTavern
    }
    'stop' {
      Stop-PrivateTavern
    }
    'status' {
      Show-PrivateStatus
    }
    'open' {
      Open-PrivateTavern
    }
    'probe-dev' {
      Assert-LocalDevelopmentServer
    }
    'pair' {
      Show-NewPairingCode
    }
    'manual' {
      Require-Elevation
      Disable-TailscaleAutostart
      Write-Step 'Manual startup is configured; current running state was not changed.'
    }
    'restore-auto' {
      Require-Elevation
      Restore-TailscaleAutostart
      Write-Step 'Automatic Tailscale service and login startup were restored.'
    }
  }
} catch {
  $scriptExitCode = 1
  [Console]::Error.WriteLine([string]$_)
} finally {
  if (Test-Administrator) {
    try {
      New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
      [ordered]@{
        action = $Action
        exitCode = $scriptExitCode
        completedAt = [DateTime]::UtcNow.ToString('o')
      } | ConvertTo-Json | Set-Content -LiteralPath $elevationResultTempPath -Encoding UTF8
      Move-Item -LiteralPath $elevationResultTempPath -Destination $elevationResultPath -Force
    } catch {
      Write-Warning "Could not publish elevated operation result: $($_.Exception.Message)"
      $scriptExitCode = 1
    }
  }
  if ($Pause -and (Test-Administrator)) {
    Read-Host 'Press Enter to close'
  }
}
exit $scriptExitCode

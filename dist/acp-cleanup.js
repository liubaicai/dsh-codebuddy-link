import { spawn } from 'node:child_process';
import { join } from 'node:path';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DESCENDANTS = 4096;
const SNAPSHOT_TIMEOUT_MS = 8000;
const CLEANUP_TIMEOUT_MS = 20000;
const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= 0xffff_ffff;
const failure = (stage) => new Error(`CodeBuddy ACP descendant ${stage} failed (details omitted)`);
const systemExe = (name) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
// Only numeric process identities cross the PowerShell boundary. Never include
// command lines, process environments, server output, or auth tokens in errors.
const PRELUDE = String.raw `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Identity($p) { return $p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
`;
function powershell(script, input, timeoutMs, stage) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(systemExe('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRELUDE + '\ntry {\n' + script + '\n} catch { exit 1 }'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch {
            reject(failure(stage));
            return;
        }
        let settled = false;
        let bytes = 0;
        const output = [];
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            if (error)
                reject(error);
            else
                resolve(Buffer.concat(output).toString('utf8'));
        };
        const stop = () => {
            if (settled)
                return;
            // A timed-out PowerShell may itself be waiting for taskkill. Kill that
            // helper tree as well, with an independently bounded emergency reaper.
            try {
                if (child.pid) {
                    const reaper = spawn(systemExe('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
                    const timer = setTimeout(() => { reaper.kill(); child.kill(); }, 1000);
                    reaper.once('error', () => { clearTimeout(timer); child.kill(); });
                    reaper.once('close', () => { clearTimeout(timer); child.kill(); });
                }
                else
                    child.kill();
            }
            catch {
                child.kill();
            }
            finish(failure(stage));
        };
        const timer = setTimeout(stop, timeoutMs);
        child.once('error', () => finish(failure(stage)));
        child.once('close', code => finish(code === 0 ? undefined : failure(stage)));
        child.stdin.on('error', () => { });
        child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT_BYTES)
                stop();
            else
                output.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT_BYTES)
                stop();
        });
        child.stdin.end(input);
    });
}
/**
 * Capture BEFORE session/cancel: a server can exit during the cancellation grace
 * period, after which taskkill /T on the server PID cannot find its children.
 * The returned cleanup must run even if the root process has already exited.
 * POSIX callers already own a process group and need no additional snapshot.
 */
export async function captureAcpDescendants(pid) {
    if (process.platform !== 'win32')
        return async () => { };
    if (!validPid(pid))
        throw new RangeError('Invalid CodeBuddy ACP process ID');
    const text = await powershell(String.raw `
$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 5)
if ($all.Count -gt 65536) { throw 'limit' }
$byParent = @{}
$root = $null
foreach ($p in $all) {
  if ([uint32]$p.ProcessId -eq ${pid}) { $root = $p }
  $key = [string]$p.ParentProcessId
  if (-not $byParent.ContainsKey($key)) { $byParent[$key] = [Collections.Generic.List[object]]::new() }
  $byParent[$key].Add($p)
}
$result = [Collections.Generic.List[object]]::new()
$queue = [Collections.Generic.Queue[object]]::new()
$seen = @{}
$seen['${pid}'] = $true
if ($null -ne $root) { $queue.Enqueue($root) }
while ($queue.Count -gt 0) {
  $parent = $queue.Dequeue()
  foreach ($p in $byParent[[string]$parent.ProcessId]) {
    if ($null -eq $p) { continue }
    $key = [string]$p.ProcessId
    # Windows retains a dead parent's PID. Do not follow an older process whose
    # original parent merely shared the current parent's recycled PID.
    if ($seen.ContainsKey($key) -or $p.CreationDate -lt $parent.CreationDate) { continue }
    $seen[$key] = $true
    $result.Add(@{ pid = [uint32]$p.ProcessId; born = (Identity $p) })
    if ($result.Count -gt ${MAX_DESCENDANTS}) { throw 'limit' }
    $queue.Enqueue($p)
  }
}
ConvertTo-Json -InputObject @($result.ToArray()) -Compress
`, '', SNAPSHOT_TIMEOUT_MS, 'capture');
    let identities;
    try {
        const parsed = JSON.parse(text.trim());
        if (!Array.isArray(parsed) || parsed.length > MAX_DESCENDANTS)
            throw failure('capture');
        const seen = new Set();
        identities = parsed.map((item) => {
            if (!item || typeof item !== 'object')
                throw failure('capture');
            const row = item;
            if (typeof row.pid !== 'number' || !validPid(row.pid) || row.pid === pid || seen.has(row.pid)
                || typeof row.born !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.born))
                throw failure('capture');
            seen.add(row.pid);
            return { pid: row.pid, born: row.born };
        });
    }
    catch {
        throw failure('capture');
    }
    if (!identities.length)
        return async () => { };
    // Deepest first: losing a parent during cleanup must not hide its descendants.
    const input = JSON.stringify(identities.reverse());
    return async () => {
        const result = await powershell(String.raw `
$targets = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
function Current($target) {
  $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [uint32]$target.pid) -Property ProcessId,CreationDate -OperationTimeoutSec 5
  if ($null -ne $p -and (Identity $p) -eq [string]$target.born) { return $p }
  return $null
}
$failed = $false
foreach ($target in $targets) {
  try {
    $p = Current $target
    if ($null -eq $p) { continue }
    # Native exit status is not proof of death (and nonzero can mean an exit
    # raced us). Re-query the exact identity before falling back to CIM.
    $taskkillCode = -1
    $ErrorActionPreference = 'Continue'
    try {
      & ($env:SystemRoot + '\System32\taskkill.exe') /PID ([string][uint32]$target.pid) /T /F 2>&1 | Out-Null
      $taskkillCode = $LASTEXITCODE
    } catch { $taskkillCode = -1 } finally { $ErrorActionPreference = 'Stop' }
    $p = Current $target
    if ($null -ne $p) {
      $termination = Invoke-CimMethod -InputObject $p -MethodName Terminate -Arguments @{ Reason = [uint32]1 } -OperationTimeoutSec 5
      if ($termination.ReturnValue -ne 0 -and $null -ne (Current $target)) { $failed = $true }
    } elseif ($taskkillCode -ne 0) {
      # A failed taskkill is acceptable only after verified disappearance.
      continue
    }
    for ($attempt = 0; $attempt -lt 10 -and $null -ne (Current $target); $attempt++) { Start-Sleep -Milliseconds 50 }
    if ($null -ne (Current $target)) { $failed = $true }
  } catch { $failed = $true }
}
if ($failed) { exit 1 }
[Console]::Out.Write('ok')
`, input, CLEANUP_TIMEOUT_MS, 'cleanup');
        if (result.trim() !== 'ok')
            throw failure('cleanup');
    };
}
//# sourceMappingURL=acp-cleanup.js.map
# Prints JSON about processes: id, parent id, name, command line, and the working folder.
# The working folder is read from the process's PEB (the same value Process Explorer shows);
# this works without admin rights for processes of the same user. Usage: procinfo.ps1 -Ids 123,456
param([string]$Ids = '', [switch]$All)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DocketJobsPeb {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
    byte[] b = new byte[8]; IntPtr r;
    if (!ReadProcessMemory(h, addr, b, (IntPtr)8, out r)) return IntPtr.Zero;
    return (IntPtr)BitConverter.ToInt64(b, 0);
  }
  public static string Cwd(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      bool wow; if (IsWow64Process(h, out wow) && wow) return null; // 32-bit processes are not handled
      PBI pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      IntPtr pp = ReadPtr(h, pbi.Peb + 0x20); // PEB.ProcessParameters
      if (pp == IntPtr.Zero) return null;
      byte[] us = new byte[16]; IntPtr r;
      if (!ReadProcessMemory(h, pp + 0x38, us, (IntPtr)16, out r)) return null; // CurrentDirectory.DosPath
      int len = BitConverter.ToUInt16(us, 0);
      IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
      if (len == 0 || len > 4096) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, buf, s, (IntPtr)len, out r)) return null;
      return System.Text.Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
"@

$mySession = (Get-Process -Id $PID).SessionId
$procs = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, SessionId
$want = @{}
foreach ($i in ($Ids -split ',')) { if ($i -match '^\d+$') { $want[[int]$i] = $true } }
$out = foreach ($p in $procs) {
  if (-not $All -and -not $want.ContainsKey([int]$p.ProcessId)) { continue }
  [pscustomobject]@{
    pid = [int]$p.ProcessId
    ppid = [int]$p.ParentProcessId
    name = $p.Name
    # Other users' command lines can hold their secrets, so only this logon session's are kept
    cmd = if ($p.SessionId -eq $mySession) { $p.CommandLine } else { $null }
    cwd = if ($want.ContainsKey([int]$p.ProcessId)) { [DocketJobsPeb]::Cwd([int]$p.ProcessId) } else { $null }
  }
}
ConvertTo-Json -Compress -Depth 3 @($out)

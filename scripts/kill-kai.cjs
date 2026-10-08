// Kill every kai.exe by pid using process.kill — the documented method.
// `taskkill //F //PID` fails SILENTLY from MSYS bash, so it is never used here.
const { execFileSync } = require("node:child_process");
function pids(psFilter) {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process | Where-Object { ${psFilter} } | Select-Object -ExpandProperty ProcessId) -join ','`],
    { encoding: "utf8" },
  ).trim();
  return out ? out.split(",").map((s) => Number(s.trim())).filter(Boolean) : [];
}

const targets = [
  { what: "kai.exe (the app)", list: () => pids("$_.Name -eq 'kai.exe'") },
  { what: "the KAI Core it supervises", list: () => pids("$_.Name -eq 'node.exe' -and $_.CommandLine -like '*Desktop\\kai*' -and $_.CommandLine -like '*core*server.js*'") },
];

for (const t of targets) {
  const found = t.list();
  console.log(`${t.what}: ${found.length ? found.join(",") : "(none)"}`);
  for (const p of found) {
    try { process.kill(p); console.log(`  killed ${p}`); }
    catch (e) { console.log(`  kill ${p} failed: ${e.code ?? e.message}`); }
  }
}

// Verify, and report the port: a live listener on 8788 means a Core survived and
// will resurrect the app mid-build.
setTimeout(() => {
  const left = pids("$_.Name -eq 'kai.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*Desktop\\kai*')");
  console.log("remaining KAI processes:", left.length ? left.join(",") : "(none)");
  const listening = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8" }).trim();
  console.log("8788 listeners:", listening);
}, 2000);

# Compare deux jeux de reglages avec le MEME executable, en alternance : cout d'une option seule.
#   powershell -ExecutionPolicy Bypass -File tools\set_ab.ps1 -SetA "adaptive=0","floor=0" -SetB "adaptive=0","floor=1"
# Options : -Exe (LyreViz.exe), -Rounds 2, -Full, -Moving, -Name, -Fast (banc rapide, a utiliser par defaut),
#           -Behind (fenetre derriere les autres : GPU 5 a 15 % plus lent, voir perf_ab.ps1),
#           -Lasers (banc des lasers, --bench-lasers)
param(
    [string]$Exe = 'LyreViz.exe',
    [Parameter(Mandatory = $true)][string[]]$SetA,
    [Parameter(Mandatory = $true)][string[]]$SetB,
    [int]$Rounds = 2,
    [switch]$Full,
    [switch]$Moving,
    [switch]$Fast,
    [switch]$Behind,
    [switch]$Lasers,
    [string]$Name = 'set'
)
# lance avec powershell -File, "a=1","b=2" arrive en une seule chaine "a=1,b=2" : on la decoupe
$SetA = @($SetA | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$SetB = @($SetB | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (Get-Process LyreViz -ErrorAction SilentlyContinue) {
    Write-Warning "Une instance de LyreViz est ouverte : elle partage la carte graphique et fausse les mesures."
}
$path = (Resolve-Path $Exe).Path
$listA = @()
$listB = @()
for ($i = 0; $i -lt $Rounds; $i++) {
    foreach ($k in 'A', 'B') {
        $sets = if ($k -eq 'A') { $SetA } else { $SetB }
        $dir = "bench\$Name`_$k$i"
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        $argList = @($(if ($Lasers) { '--bench-lasers' } else { '--bench' }), '--fullscreen', '--benchdir', $dir)
        if ($Fast) { $argList += '--fast' }
        if ($Behind) { $argList += '--behind' }
        if (-not $Full) { $argList += '--quick' }
        if (-not $Moving) { $argList += '--static' }
        foreach ($s in $sets) { $argList += @('--set', $s) }
        Write-Host "Lancement $k$i : $($sets -join ' ')"
        Start-Process -FilePath $path -ArgumentList $argList -Wait | Out-Null
        if ($k -eq 'A') { $listA += $dir } else { $listB += $dir }
    }
}
Write-Host ""
Write-Host "=== Temps (moyenne des lancements) ==="
python -I tools\perf_report.py ($listA -join ',') ($listB -join ',')
Write-Host ""
Write-Host "=== Images (premier lancement A contre premier lancement B) ==="
python -I tools\compare_bench.py $listA[0] $listB[0] --diff "bench\$Name`_ecarts"

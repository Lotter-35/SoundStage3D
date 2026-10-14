# Compare deux versions de LyreViz (temps et images), en les lancant en alternance : A B A B ...
#
#   powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe
#
# Options :
#   -Rounds 2        nombre d'alternances (2 = 4 lancements ; 3 pour une decision serree)
#   -Full            les 14 cas (3 scenarios x 3 vues + options coupees) au lieu des 3 cas rapides
#   -Moving          lyres et fumee en mouvement (par defaut : immobiles, pour comparer les images)
#   -Set "a=1","b=2" reglages passes a --set (par defaut : adaptive=0, qualite fixe)
#   -Name essai      prefixe des dossiers de resultats (bench\essai_A0, bench\essai_B0, ...)
#
# Pourquoi en alternance : sur la GTX 1080, les temps varient de 10 a 20 % d'un lancement a
# l'autre (frequence, temperature, autres programmes). Un seul lancement de chaque version ne
# permet pas de conclure. Fermer les autres instances de LyreViz pendant la mesure.
param(
    [Parameter(Mandatory = $true)][string]$ExeA,
    [Parameter(Mandatory = $true)][string]$ExeB,
    [int]$Rounds = 2,
    [switch]$Full,
    [switch]$Moving,
    [string[]]$Set = @('adaptive=0'),
    [string]$Name = 'ab'
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (Get-Process LyreViz -ErrorAction SilentlyContinue) {
    Write-Warning "Une instance de LyreViz est ouverte : elle partage la carte graphique et fausse les mesures."
}
$pathA = (Resolve-Path $ExeA).Path
$pathB = (Resolve-Path $ExeB).Path
$listA = @()
$listB = @()
for ($i = 0; $i -lt $Rounds; $i++) {
    foreach ($k in 'A', 'B') {
        $exe = if ($k -eq 'A') { $pathA } else { $pathB }
        $dir = "bench\$Name`_$k$i"
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        $argList = @('--bench', '--fullscreen', '--benchdir', $dir)
        if (-not $Full) { $argList += '--quick' }
        if (-not $Moving) { $argList += '--static' }
        foreach ($s in $Set) { $argList += @('--set', $s) }
        Write-Host "Lancement $k$i : $exe"
        Start-Process -FilePath $exe -ArgumentList $argList -Wait | Out-Null
        if ($k -eq 'A') { $listA += $dir } else { $listB += $dir }
    }
}
Write-Host ""
Write-Host "=== Temps (moyenne des lancements) ==="
python -I tools\perf_report.py ($listA -join ',') ($listB -join ',')
Write-Host ""
Write-Host "=== Images (premier lancement A contre premier lancement B) ==="
python -I tools\compare_bench.py $listA[0] $listB[0] --diff "bench\$Name`_ecarts"

# Compare deux versions de LyreViz (temps et images), en les lancant en alternance : A B A B ...
#
#   powershell -ExecutionPolicy Bypass -File tools\perf_ab.ps1 -ExeA bench\ref\avant.exe -ExeB LyreViz.exe
#
# Options :
#   -Rounds 2        nombre d'alternances (2 = 4 lancements ; 3 pour une decision serree)
#   -Full            les 14 cas (3 scenarios x 3 vues + options coupees) au lieu des 3 cas rapides
#                    (avec -Lasers : les 13 cas au lieu de 5)
#   -Moving          lyres et fumee en mouvement (par defaut : immobiles, pour comparer les images)
#   -Set "a=1","b=2" reglages passes a --set (par defaut : adaptive=0, qualite fixe)
#   -Name essai      prefixe des dossiers de resultats (bench\essai_A0, bench\essai_B0, ...)
#   -Lyres           banc des lyres (--bench-lyres : lyres qui visent toutes le meme point, zoom, mouvement ; lasers
#                    eteints) au lieu de celui des lyres general
#   -Lasers          banc des lasers (--bench-lasers : cas L1 a L6, M1, voir PLAN-LASERS.md) au lieu de celui des lyres
#   -Fast            banc rapide : 30 images de chauffe et 60 mesurees par cas (au lieu de 60 et 150) ;
#                    un banc complet en 20 s au lieu de 45. A utiliser par defaut ; sans -Fast pour une
#                    decision serree ou les valeurs de reference.
#   -Cases "14,20"   seulement ces cas (numeros de la liste complete, option --cases ; implique tous les cas)
#   -Behind          fenetre ouverte derriere les autres, sans prendre le clavier. ATTENTION : Windows
#                    donne la priorite a la fenetre active : derriere (ou si l'on clique ailleurs pendant
#                    le banc), le GPU est 5 a 15 % plus lent dans les cas lourds. A n'utiliser que pour
#                    comparer A et B entre eux, jamais pour les valeurs de reference.
#   Clavier et souris sont ignores pendant le banc (un clic ne deplace pas la camera).
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
    [switch]$Fast,
    [switch]$Behind,
    [switch]$Lasers,
    [switch]$Lyres,
    [string[]]$Set = @('adaptive=0'),
    [string]$Cases = '',
    [string]$Name = 'ab'
)
# lance avec powershell -File, "a=1","b=2" arrive en une seule chaine "a=1,b=2" : on la decoupe
$Set = @($Set | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
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
        $argList = @($(if ($Lasers) { '--bench-lasers' } elseif ($Lyres) { '--bench-lyres' } else { '--bench' }), '--fullscreen', '--benchdir', $dir)
        if ($Fast) { $argList += '--fast' }
        if ($Behind) { $argList += '--behind' }
        if ($Cases) { $argList += @('--cases', $Cases) }
        elseif (-not $Full) { $argList += '--quick' }
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

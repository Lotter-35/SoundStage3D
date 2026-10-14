"""Moyenne plusieurs resultats du banc d'essai (lancements alternes) et compare deux versions.

    python tools/perf_report.py bench/ab_A0,bench/ab_A1 bench/ab_B0,bench/ab_B1

Utilise par tools/perf_ab.ps1. Affiche, par cas : temps GPU moyen de A et de B (et de chaque
lancement, pour juger du bruit), puis le temps de chaque passe.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare_bench import read_results  # noqa: E402


def gather(dirs):
    acc = {}
    for d in dirs:
        for k, c in read_results(d).items():
            e = acc.setdefault(k, {'name': c['name'], 'gpu': [], 'frame': [], 'passes': {}})
            e['gpu'].append(c.get('gpu', 0))
            e['frame'].append(c.get('frame', 0))
            for n, v in c['passes'].items():
                e['passes'].setdefault(n, []).append(v)
    return acc


def mean(v):
    return sum(v) / len(v) if v else 0.0


def main():
    ra, rb = gather(sys.argv[1].split(',')), gather(sys.argv[2].split(','))
    for k in sorted(ra):
        a, b = ra[k], rb.get(k)
        if not b:
            continue
        ga, gb = mean(a['gpu']), mean(b['gpu'])
        pct = (gb / ga - 1) * 100 if ga > 0 else 0
        runs = f"A {['%.1f' % x for x in a['gpu']]} B {['%.1f' % x for x in b['gpu']]}"
        print(f"[{k:02d}] {a['name'][:40]:<40} GPU {ga:6.2f} -> {gb:6.2f} ms ({pct:+5.1f} %)  "
              f"img/s {1000 / max(mean(a['frame']), 1e-3):5.0f} -> {1000 / max(mean(b['frame']), 1e-3):5.0f}  {runs}")
        # passes de A, puis celles qui n'existent que dans B (une nouvelle passe, une autre methode)
        for n in list(a['passes']) + [n for n in b['passes'] if n not in a['passes']]:
            va, vb = mean(a['passes'].get(n, [])), mean(b['passes'].get(n, []))
            if va > 0.25 or vb > 0.25:
                print(f"      {n:<30} {va:6.2f} -> {vb:6.2f}")


if __name__ == '__main__':
    main()

// Rendu « laser » des maquettes : traits fins lumineux avec halo, sur fond noir.
(function () {
  let uid = 0;
  const TAU = Math.PI * 2;
  const P = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + (-p[1]).toFixed(2)).join(' ');
  const poly = (n, r, rot = 0, cx = 0, cy = 0) => {
    const a = []; for (let i = 0; i <= n; i++) { const t = rot + i / n * TAU; a.push([cx + r * Math.sin(t), cy + r * Math.cos(t)]); } return a;
  };
  const star = (n, r1, r2, rot = 0, cx = 0, cy = 0) => {
    const a = []; for (let i = 0; i <= 2 * n; i++) { const t = rot + i / (2 * n) * TAU, r = i % 2 ? r2 : r1; a.push([cx + r * Math.sin(t), cy + r * Math.cos(t)]); } return a;
  };
  const circle = (r, cx = 0, cy = 0) => poly(90, r, 0, cx, cy);
  const wave = (amp, cyc, y = 0, x0 = -0.8, x1 = 0.8, ph = 0) => {
    const a = []; for (let i = 0; i <= 120; i++) { const x = x0 + (x1 - x0) * i / 120; a.push([x, y + amp * Math.sin(ph + cyc * TAU * (x - x0) / (x1 - x0))]); } return a;
  };
  const liss = (a, b, r, d = 0) => { const o = []; for (let i = 0; i <= 400; i++) { const t = i / 400 * TAU; o.push([r * Math.sin(a * t + d), r * Math.sin(b * t)]); } return o; };
  const C = { red: '#ff3b3b', green: '#39ff6a', blue: '#4a7dff', cyan: '#36e6ff', mag: '#ff3bd8', yel: '#ffe23b', white: '#f4f4ff', orange: '#ff8a2b', violet: '#a86bff' };

  // Chaque scène : liste de [points, couleur, options]
  const S = {
    'star': () => [[star(5, .62, .26, 0), C.cyan], [circle(.78), C.mag, { dash: '.02 .055' }]],
    'star-sel': () => [[star(5, .62, .26, 0), C.cyan], [circle(.78), C.mag, { dash: '.02 .055' }], [poly(6, .2, 0, 0, 0), C.yel]],
    'rings': () => [[circle(.25), C.green], [circle(.45), C.green], [circle(.65), C.blue], [circle(.85), C.blue, { dash: '.03 .04' }]],
    'wave': () => [[wave(.25, 2.5, .15), C.red], [wave(.25, 2.5, -.15, -.8, .8, Math.PI), C.yel]],
    'tunnel': () => [0, 1, 2, 3, 4].map(i => [poly(4, .15 + i * .17, i * .18), [C.blue, C.cyan, C.violet, C.mag, C.blue][i]]),
    'liss': () => [[liss(3, 2, .7, .5), C.green]],
    'flower': () => { const o = []; for (let i = 0; i < 6; i++) o.push([circle(.3, .32 * Math.sin(i / 6 * TAU), .32 * Math.cos(i / 6 * TAU)), i % 2 ? C.mag : C.violet]); return o; },
    'tri': () => [[poly(3, .7, 0), C.yel], [poly(3, .45, Math.PI), C.orange]],
    'dots': () => [[circle(.6), C.white, { dash: '.0001 .07', w: 2.6 }], [circle(.35), C.cyan, { dash: '.0001 .06', w: 2.6 }]],
    'hex': () => [[poly(6, .7, 0), C.green], [star(6, .7, .35, Math.PI / 6), C.cyan]],
    'beams': () => { const o = []; for (let i = 0; i < 12; i++) { const t = i / 12 * TAU; o.push([[[0, 0], [.85 * Math.sin(t), .85 * Math.cos(t)]], i % 2 ? C.cyan : C.blue]); } return o; },
    'spiral': () => { const a = []; for (let i = 0; i <= 500; i++) { const t = i / 500 * 6 * TAU, r = .05 + .8 * i / 500; a.push([r * Math.sin(t), r * Math.cos(t)]); } return [[a, C.violet]]; },
    'text-bars': () => [-.6, -.3, 0, .3, .6].map((x, i) => [[[x, -.5 + .15 * (i % 2)], [x, .5 - .15 * (i % 2)]], [C.red, C.orange, C.yel, C.orange, C.red][i]]),
    'grid-sq': () => [[poly(4, .75, Math.PI / 4), C.red], [poly(4, .45, Math.PI / 4), C.red], [[[-.53, 0], [.53, 0]], C.red], [[[0, -.53], [0, .53]], C.red]],
    'show': () => [[star(5, .5, .21, .3), C.cyan], [circle(.62), C.mag, { dash: '.02 .05' }], [wave(.08, 4, -.78, -.7, .7), C.green], [circle(.18, -.62, .62), C.yel], [circle(.18, .62, .62), C.yel]],
    'empty': () => [],
  };

  function render(el) {
    const sc = (S[el.dataset.laser] || S.empty)();
    const k = ++uid, g = parseFloat(el.dataset.glow || '1');
    const w = parseFloat(el.dataset.w || '1');
    let h = `<svg viewBox="-1 -1 2 2" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">`;
    h += `<defs><filter id="g${k}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${.018 * g}" result="a"/><feGaussianBlur in="SourceGraphic" stdDeviation="${.006 * g}" result="b"/>`;
    h += `<feMerge><feMergeNode in="a"/><feMergeNode in="a"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#g${k})" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
    for (const [pts, col, o = {}] of sc) {
      h += `<path d="${P(pts)}" stroke="${col}" stroke-width="${(o.w || 1.3) * .011 * w}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
    }
    h += '</g></svg>';
    el.innerHTML = h;
  }

  function icons() {
    document.querySelectorAll('[data-i]').forEach(e => {
      const cls = 'i ' + (e.className || '');
      e.outerHTML = `<svg class="${cls}" viewBox="0 0 24 24">${window.ICONS[e.dataset.i] || ''}</svg>`;
    });
  }

  // Mini-courbes d'automation (Show) : data-curve="0,.2 .5,.8 1,.4" (x 0..1, y 0..1)
  function curves() {
    document.querySelectorAll('[data-curve]').forEach(el => {
      const W = el.clientWidth, H = el.clientHeight, pad = 5;
      const pts = el.dataset.curve.trim().split(/\s+/).map(s => s.split(',').map(Number));
      const step = el.dataset.step === '1', sine = el.dataset.sine;
      let d = '';
      if (sine) {
        const [cyc, amp] = sine.split(',').map(Number);
        for (let i = 0; i <= 200; i++) { const x = i / 200; const y = .5 + amp * Math.sin(x * cyc * TAU); d += (i ? 'L' : 'M') + (x * W).toFixed(1) + ' ' + (pad + (1 - y) * (H - 2 * pad)).toFixed(1); }
      } else {
        pts.forEach((p, i) => {
          const x = p[0] * W, y = pad + (1 - p[1]) * (H - 2 * pad);
          if (!i) d += `M${x} ${y}`;
          else if (step) { const py = pad + (1 - pts[i - 1][1]) * (H - 2 * pad); d += `L${x} ${py}L${x} ${y}`; }
          else { const px = pts[i - 1][0] * W, py = pad + (1 - pts[i - 1][1]) * (H - 2 * pad), m = (px + x) / 2; d += `C${m} ${py} ${m} ${y} ${x} ${y}`; }
        });
      }
      const col = el.dataset.col || '#d6d7db';
      let s = `<svg width="${W}" height="${H}" style="display:block"><path d="${d}" fill="none" stroke="${col}" stroke-opacity=".85" stroke-width="1.4"/>`;
      if (!sine) pts.forEach(p => { const x = p[0] * W, y = pad + (1 - p[1]) * (H - 2 * pad); s += `<path d="M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z" fill="#1d1e22" stroke="${col}" stroke-width="1.1"/>`; });
      el.innerHTML = s + '</svg>';
    });
  }

  // Forme d'onde de la musique
  function waves() {
    document.querySelectorAll('[data-wave]').forEach(el => {
      const W = el.clientWidth, H = el.clientHeight; let s = `<svg width="${W}" height="${H}" style="display:block">`;
      let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
      for (let x = 0; x < W; x += 2) {
        const beat = Math.pow(Math.max(0, Math.cos((x / W) * 64 * Math.PI)), 6);
        const sec = x / W; const env = sec < .25 ? .35 : sec < .5 ? .55 : sec < .75 ? .95 : .6;
        const a = (0.15 + 0.55 * beat + 0.3 * rnd()) * env * H / 2;
        s += `<rect x="${x}" y="${H / 2 - a}" width="1.2" height="${2 * a}" fill="#5b6070"/>`;
      }
      el.innerHTML = s + '</svg>';
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    icons();
    document.querySelectorAll('[data-laser]').forEach(render);
    curves(); waves();
    document.body.dataset.ready = '1';
  });
})();

const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  for (const n of process.argv.slice(2)) {
    await p.goto('file://' + __dirname + '/' + n + '.html');
    await p.waitForSelector('body[data-ready="1"]');
    await p.waitForTimeout(150);
    await p.screenshot({ path: __dirname + '/' + n + '.png' });
    console.log('ok', n);
  }
  await b.close();
})();

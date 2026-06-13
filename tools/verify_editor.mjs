// Smoke-test the dev editor foundation: enter the game, press F2, confirm the
// shell HUD + Admin Hub appear, close the hub, fly the camera, exit.
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'tools/_verify_editor';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 896 } });
page.on('console', (m) => console.log('[console]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const tap = async (key, ms = 120) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

await page.goto('http://localhost:4444/');
await page.waitForTimeout(3000);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);

// Enter editor mode
await page.keyboard.press('F2');
await page.waitForTimeout(800);
const hubVisible = await page.evaluate(() => document.body.textContent.includes('ADMIN HUB'));
const barVisible = await page.evaluate(() => document.body.textContent.includes('EDITOR'));
console.log('hub visible:', hubVisible, '| shell bar visible:', barVisible);
await page.screenshot({ path: `${OUT}/1_hub.png` });

// Close hub -> shell with free camera; pan east and check the camera moved
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const camBefore = await page.evaluate(() => window.__eb.game ? null : null); // camera not exposed; use readout
await tap('d', 700);
await page.waitForTimeout(300);
const readout = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('span')];
  return spans.map((s) => s.textContent).find((t) => t && t.includes('px(')) ?? 'NO READOUT';
});
console.log('readout:', readout);
await page.screenshot({ path: `${OUT}/2_shell_panned.png` });

// Wheel zoom out: world point under the cursor should stay anchored
await page.mouse.move(512, 448); // canvas center
await page.mouse.wheel(0, 240);  // two notches out
await page.mouse.wheel(0, 240);
await page.waitForTimeout(400);
const zoomReadout = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('span')];
  return spans.map((s) => s.textContent).find((t) => t && t.includes('px(')) ?? 'NO READOUT';
});
console.log('zoomed readout:', zoomReadout);
await page.screenshot({ path: `${OUT}/2b_zoomed_out.png` });

// Placement tool: open hub, launch the tool, check the panel loaded entries
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('text=Placement Editor', { force: true });
await page.waitForTimeout(1500);
const panelInfo = await page.evaluate(() => {
  const panel = [...document.querySelectorAll('div')].find((d) => d.querySelector('button[data-tab]'));
  return panel ? panel.children[1].textContent : 'NO PANEL';
});
console.log('placement panel (npcs):', panelInfo);
await page.screenshot({ path: `${OUT}/3_placement.png` });

// Switch to the spawn and doors tabs
for (const tab of ['SPAWN', 'DOORS']) {
  await page.click(`button:text-is("${tab}")`, { force: true });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.querySelector('button[data-tab]'));
    return panel ? panel.children[1].textContent : 'NO PANEL';
  });
  console.log(`placement panel (${tab.toLowerCase()}):`, info);
  await page.screenshot({ path: `${OUT}/4_${tab.toLowerCase()}.png` });
}

// Collision painter: back to hub, launch, paint nothing â€” just check it loads
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('text=Collision & Priority Painter', { force: true });
await page.waitForTimeout(800);
const painterUp = await page.evaluate(() => document.body.textContent.includes('COLLISION PAINTER'));
console.log('collision painter panel:', painterUp);
await page.screenshot({ path: `${OUT}/5_collision.png` });

// Exit back to game
await page.keyboard.press('F2');
await page.waitForTimeout(300);
const barGone = await page.evaluate(() => !document.body.textContent.includes('âš’ EDITOR'));
console.log('exited cleanly (bar removed):', barGone);

await browser.close();
console.log('done');


// Verify fixed prop anchors in the running game: teleport into the Onett
// drugstore, screenshot, then Q the ATM on the back wall.
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'tools/_verify_props';
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

// Drugstore interior: ATM placement is (7784,1480); stand just below it.
await page.evaluate(() => window.__eb.game.debugTeleport(7784, 1512));
await page.waitForTimeout(2500);
await tap('ArrowUp', 60); // face the ATM
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/1_drugstore.png` });

await tap('q');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/2_atm_dialogue.png` });
await tap('q');

// Onett intersection: traffic light at (1552,1192).
await page.evaluate(() => window.__eb.game.debugTeleport(1552, 1216));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/3_traffic_light.png` });

await browser.close();
console.log('done');

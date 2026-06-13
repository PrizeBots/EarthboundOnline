// Verify sprite-priority rendering at the canonical spots:
//  1. Pressed directly behind the Onett stop sign (0x03) — WHOLE body hidden.
//  2. One row back from the sign (0x01) — legs hidden, head above the sign.
//  3. Onett hospital bench sitters (0x03 seats) — render whole-behind too
//     (ROM semantics; their ROM sprites are sitting poses).
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'tools/_verify_priority';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 896 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:4444/');
await page.waitForTimeout(3000);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);

// 1. Pressed behind the stop sign (pole base solid at mty 148; feet land 1184).
await page.evaluate(() => window.__eb.game.debugTeleport(1712, 1184));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/1_behind_sign.png` });

// 2. One row back — head should clear the sign top.
await page.evaluate(() => window.__eb.game.debugTeleport(1712, 1172));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/2_one_row_back.png` });

// 3. Hospital bench sitters.
await page.evaluate(() => window.__eb.game.debugTeleport(6984, 9850));
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/3_hospital_bench.png` });

await browser.close();
console.log('done');

// Drive the game in a real browser and screenshot the NPC dialogue flow.
// Run: node tools/verify_dialogue.mjs
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'tools/_verify_dialogue';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 896 } });
const logs = [];
page.on('console', (m) => {
  logs.push(m.text());
  console.log('[console]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const tap = async (key, ms = 120) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

await page.goto('http://localhost:4444/');
await page.waitForTimeout(3000); // load -> charselect

// First cell is CREATE — move right to Ness, then confirm; wait for load.
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);

// Walk toward the NPC home at (1320,1136): spawn is (1296,1168).
await tap('ArrowUp', 280);
await tap('ArrowRight', 180);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/3_next_to_npc.png` });

// The NPC wanders (server-side), so try Q facing each direction; the
// "Talk:" console log tells us when we actually hit her. After a miss,
// Q again closes the fallback box before turning.
let hit = false;
for (const dir of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
  await tap(dir, 50); // turn (and step a couple px)
  await page.waitForTimeout(100);
  const before = logs.length;
  await tap('q');
  await page.waitForTimeout(600);
  const talkLog = logs.slice(before).find((l) => l.startsWith('Talk:'));
  if (talkLog && talkLog.includes('npc(')) {
    hit = true;
    await page.screenshot({ path: `${OUT}/4_dialogue_typing.png` });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/5_dialogue_full.png` });
    break;
  }
  await tap('q'); // close fallback box
  await page.waitForTimeout(300);
}
console.log('NPC HIT:', hit);

// Advance through all boxes with Q until closed.
for (let i = 0; i < 12; i++) {
  await tap('q');
  await page.waitForTimeout(1800);
}
await page.screenshot({ path: `${OUT}/6_after_advancing.png` });

// Walk away into empty space, then Q -> check fallback.
await tap('ArrowDown', 700);
await tap('ArrowLeft', 400);
await tap('q');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/7_check_nothing.png` });

// Close it and confirm movement unfreezes.
await tap('q');
await page.waitForTimeout(300);
await tap('ArrowDown', 300);
await page.screenshot({ path: `${OUT}/8_closed_moving.png` });

await browser.close();
console.log('done');

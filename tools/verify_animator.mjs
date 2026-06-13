// Smoke-test the NPC Sprite Animator: hub -> tool -> search -> open a group's
// editor overlay -> check the live test pane runs. Screenshots are ROM pixels
// — delete after review.
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = 'tools/_verify_animator';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 896 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:4444/');
await page.waitForTimeout(3000);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);

await page.keyboard.press('F2');
await page.waitForTimeout(600);
await page.click('text=NPC Sprite Animator', { force: true });
await page.waitForTimeout(800);
console.log('animator panel:', await page.evaluate(() => document.body.textContent.includes('SPRITE ANIMATOR')));

await page.fill('input[placeholder="search name or id…"]', 'frank');
await page.waitForTimeout(600);
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('div')]
    .filter((d) => d.textContent?.startsWith('153'))
    .length
);
console.log('search hit for Frank:', rows > 0);

await page.click('text=153 Frank', { force: true });
await page.waitForTimeout(1200);
console.log('overlay open:', await page.evaluate(() => document.body.textContent.includes('#153 Frank')));
await page.screenshot({ path: `${OUT}/1_animator.png` });

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('overlay closed:', await page.evaluate(() => !document.body.textContent.includes('#153 Frank')));

await browser.close();
console.log('done');

#!/usr/bin/env node
'use strict';

// Records actual DOM interactions in an isolated local browser, never a real call.
// Set NODE_PATH to the existing Playwright installation before running this file.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {setTimeout: delay} = require('node:timers/promises');
const {chromium} = require('playwright');

const origin = process.env.MEASUREBACK_RECORD_ORIGIN || 'http://127.0.0.1:8793';
const parsed = new URL(origin);
assert.equal(parsed.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Recording is restricted to loopback');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(__dirname, '../output/demo', runId);
const scenes = [];
const browserErrors = [];
const forbiddenRequests = [];
let start = 0;

async function at(seconds) {
  const remaining = seconds * 1000 - (performance.now() - start);
  if (remaining > 0) await delay(remaining);
}

function scene(name, detail) {
  const seconds = Number(((performance.now() - start) / 1000).toFixed(3));
  scenes.push({seconds, name, detail});
  process.stdout.write(`${seconds.toFixed(1)}s ${name}\n`);
}

function ingredient(page, name) {
  return page.locator('#ingredients .ingredient').filter({
    has: page.locator('.ingredient-name', {hasText: new RegExp(`^${name}`)}),
  });
}

async function waitForAmount(page, name, amount) {
  await page.waitForFunction(({name, amount}) => {
    const row = [...document.querySelectorAll('#ingredients .ingredient')]
      .find(el => el.querySelector('.ingredient-name')?.textContent.startsWith(name));
    return row?.querySelector('.quantity')?.textContent.startsWith(amount);
  }, {name, amount});
}

async function deliberateClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, 'Click target must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 10});
  await delay(350);
  await locator.click();
}

(async () => {
  await fs.mkdir(path.join(output, 'raw'), {recursive: true});
  const browser = await chromium.launch({headless: true});
  let context;
  try {
    context = await browser.newContext({
      viewport: {width: 1920, height: 1080},
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      recordVideo: {dir: path.join(output, 'raw'), size: {width: 1920, height: 1080}},
    });
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      const forbiddenCall = requestUrl.pathname.startsWith('/api/call/') && requestUrl.pathname !== '/api/call/preview';
      if (requestUrl.origin !== parsed.origin || forbiddenCall) {
        forbiddenRequests.push(forbiddenCall ? 'provider call route attempted' : requestUrl.origin);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') browserErrors.push(message.text());});
    const video = page.video();
    const navigation = performance.now();
    const response = await page.goto(origin, {waitUntil: 'networkidle'});
    assert.equal(response.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelectorAll('#ingredients .ingredient').length === 6);
    assert.match(await page.locator('#live-note').textContent(), /live calling is disabled/i);
    assert.match(await page.locator('.example-note').textContent(), /Authored conversation/);
    assert.equal(await page.locator('#measure-value').textContent(), '?');
    const loadLeadInSeconds = Number(((performance.now() - navigation) / 1000).toFixed(3));
    start = performance.now();
    scene('Missing measurement', 'Authored example remains labelled; two bowls have no assumed capacity.');

    await at(20);
    await deliberateClick(page, page.locator('[data-stage="clarified"]'));
    await waitForAmount(page, 'Rice', '750 ml');
    scene('Clarification', 'The cook states 250 ml per bowl; the app derives 750 ml for six servings.');

    await at(40);
    await deliberateClick(page, page.locator('[data-stage="corrected"]'));
    await waitForAmount(page, 'Water', '1350 ml');
    scene('Read-back correction', 'The authored read-back corrects original water from 1000 ml to 900 ml.');
    await at(44);
    await deliberateClick(page, ingredient(page, 'Water').locator('button'));
    assert.match(await page.locator('#featured-quote').textContent(), /900 ml.*1000 ml/);
    scene('Correction evidence', 'The real source-expansion control shows the cook’s quoted correction.');

    await at(60);
    await deliberateClick(page, page.getByRole('button', {name: 'One fewer serving'}));
    await page.waitForFunction(() => document.querySelector('#display-servings').textContent === '5');
    await deliberateClick(page, page.getByRole('button', {name: 'One fewer serving'}));
    await waitForAmount(page, 'Rice', '500 ml');
    await waitForAmount(page, 'Water', '900 ml');
    scene('Four servings', 'Actual serving controls restore the original measured amounts.');
    await at(67);
    await deliberateClick(page, page.getByRole('button', {name: 'One more serving'}));
    await page.waitForFunction(() => document.querySelector('#display-servings').textContent === '5');
    await deliberateClick(page, page.getByRole('button', {name: 'One more serving'}));
    await waitForAmount(page, 'Rice', '750 ml');
    await waitForAmount(page, 'Water', '1350 ml');
    assert.match(await ingredient(page, 'Cinnamon stick').textContent(), /Decide how to divide/);
    scene('Six servings', 'Fractional whole pieces retain a human decision and salt remains to taste.');

    await at(75);
    await page.locator('.below').scrollIntoViewIfNeeded();
    assert.match(await page.locator('#steps').textContent(), /18 min · as spoken/);
    scene('Method and transcript', 'Cooking time and dependency order remain as spoken, alongside the labelled illustrative transcript.');
    await at(82);
    await page.locator('#transcript').hover();
    await page.mouse.wheel(0, 420);
    await delay(500);
    scene('Later transcript turns', 'Scroll inside the actual conversation pane to the read-back and sharing decision.');

    await at(90);
    await page.locator('#call-setup').scrollIntoViewIfNeeded();
    scene('Local interview setup', 'The form is a real local no-call preview; the destination is a reserved fictional example.');
    for (const [name, value] of [
      ['requester', 'Alex'],
      ['cook_name', 'Example Cook'],
      ['recipe_title', 'Our Sunday cumin rice'],
      ['phone', '+12025550123'],
    ]) {
      const field = page.locator(`[name="${name}"]`);
      await field.click();
      await field.pressSequentially(value, {delay: 45});
    }
    await page.locator('[name="consent"]').check();
    await page.locator('[name="sharing_consent"]').check();
    await at(103);
    await page.locator('[name="locale"]').selectOption('en-IN');
    await page.locator('[name="language_mode"]').selectOption('fixed');
    scene('Fixed language', 'The initial language and fixed conversation mode are explicitly selected.');
    await at(106);
    await page.locator('[name="language_mode"]').selectOption('adaptive');
    scene('Adaptive preference', 'The actual selector labels following the cook as best effort.');
    await at(109);
    await deliberateClick(page, page.getByRole('button', {name: 'Preview the call', exact: true}));
    await page.locator('#call-preview').waitFor({state: 'visible'});
    assert.match(await page.locator('#call-preview').textContent(), /•••• 0123/);
    assert.equal(await page.locator('#execute-call').isVisible(), false);
    assert.match(await page.locator('#call-state').textContent(), /Live calling is disabled/);
    await page.locator('#call-preview').scrollIntoViewIfNeeded();
    scene('Masked no-call preview', 'One reviewed interview request is prepared; no call is executed.');

    await at(120);
    await page.mouse.move(1100, 400);
    await page.mouse.wheel(0, -5000);
    await page.locator('h1').waitFor({state: 'visible'});
    await page.waitForFunction(() => scrollY < 10);
    scene('Return to recipe', 'The finished workbench keeps measured rice, corrected water and remaining human decisions together.');
    await at(129);
    await page.screenshot({path: path.join(output, 'final-workbench.png')});
    await at(130);
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(forbiddenRequests, []);
    const displayedDurationSeconds = Number(((performance.now() - start) / 1000).toFixed(3));
    await context.close();
    context = null;
    const videoPath = path.join(output, 'measureback-demo.webm');
    await video.saveAs(videoPath);
    await fs.writeFile(path.join(output, 'recording.json'), JSON.stringify({
      origin,
      viewport: {width: 1920, height: 1080},
      source: 'Actual Playwright recording of DOM interactions, not a slideshow',
      example: 'Authored fictional conversation; no live CALL E recording is claimed',
      narration: 'To be supplied separately',
      loadLeadInSeconds,
      displayedDurationSeconds,
      scenes,
      browserErrors,
      forbiddenRequests,
      videoPath,
    }, null, 2));
    process.stdout.write(`Recording complete: ${videoPath}\nScene timings: ${path.join(output, 'recording.json')}\n`);
  } finally {
    if (context) await context.close();
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

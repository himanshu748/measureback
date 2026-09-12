#!/usr/bin/env node
'use strict';

// Independent checks of the deployed static example. Never submits forms or
// permits API/call traffic; uses a new browser profile with service workers off.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const url = 'https://himanshu748.github.io/measureback/';
const origin = new URL(url).origin;
const output = path.resolve(__dirname, '../artifacts/public-verification');
const checks = [];
const errors = [];
const failedResponses = [];
const forbiddenRequests = [];
const requests = [];
const states = [];

async function check(name, work) {
  await work();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function ingredient(page, name) {
  return page.locator('#ingredients .ingredient').filter({
    has: page.locator('.ingredient-name', { hasText: new RegExp(`^${name}`) }),
  });
}

async function amount(page, name, expected) {
  await page.waitForFunction(({ name, expected }) => [...document.querySelectorAll('#ingredients .ingredient')]
    .find(row => row.querySelector('.ingredient-name')?.textContent.startsWith(name))
    ?.querySelector('.quantity')?.textContent.startsWith(expected), { name, expected });
}

async function captureState(page, stage) {
  states.push({ stage, servings: await page.locator('#display-servings').textContent(),
    measure: await page.locator('#measure-title').textContent(), value: await page.locator('#measure-value').textContent(),
    rice: await ingredient(page, 'Rice').locator('.quantity').textContent(),
    water: await ingredient(page, 'Water').locator('.quantity').textContent() });
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      const target = new URL(request.url());
      requests.push({ method: request.method(), path: target.pathname });
      if (target.origin !== origin || target.pathname.includes('/api/') || !['GET', 'HEAD'].includes(request.method())) {
        forbiddenRequests.push({ method: request.method(), url: request.url() });
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
    const configResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/measureback/config.json');
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    const configResponse = await configResponsePromise;
    const config = await configResponse.json();

    await check('public page returns HTTP 200 and JavaScript renders the workbench', async () => {
      assert.equal(response.status(), 200);
      assert.equal(page.url(), url);
      await page.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('#ingredients .ingredient').length === 6);
      assert.equal(await page.locator('#error').isVisible(), false);
      assert.equal(await page.locator('#mode-label').textContent(), 'Interactive example');
      assert.equal(await page.locator('#recipe-title').textContent(), 'Cumin rice');
    });
    await check('deployed configuration is static and live calling is disabled', async () => {
      assert.equal(configResponse.status(), 200);
      assert.equal(config.local, false);
      assert.equal(config.live_enabled, false);
      assert.match(await page.locator('#live-note').textContent(), /Public example mode/);
    });
    await check('bundled Atkinson font loads and is applied', async () => {
      await page.evaluate(() => document.fonts.ready);
      const font = await page.evaluate(() => ({
        loaded: [...document.fonts].some(face => face.family.replace(/["']/g, '') === 'MB' && face.status === 'loaded'),
        body: getComputedStyle(document.body).fontFamily,
      }));
      assert.equal(font.loaded, true);
      assert.match(font.body, /^MB/);
    });
    await check('stage one keeps the original rice measure unknown', async () => {
      assert.equal(await page.locator('[data-stage="unresolved"]').getAttribute('aria-pressed'), 'true');
      await amount(page, 'Rice', 'Measure needed');
      assert.equal(await page.locator('#measure-value').textContent(), '?');
      await captureState(page, 'unresolved');
    });
    await check('stage two resolves rice to 750 ml for six servings', async () => {
      await page.locator('[data-stage="clarified"]').click();
      await amount(page, 'Rice', '750 ml');
      assert.equal(await page.locator('#display-servings').textContent(), '6');
      assert.equal(await page.locator('#measure-value').textContent(), '750');
      await captureState(page, 'clarified');
    });
    await check('stage three shows 1350 ml water and its correction evidence', async () => {
      await page.locator('[data-stage="corrected"]').click();
      await amount(page, 'Water', '1350 ml');
      await ingredient(page, 'Water').locator('button').click();
      assert.equal(await ingredient(page, 'Water').locator('.evidence').isVisible(), true);
      assert.match(await page.locator('#featured-quote').textContent(), /900 ml.*1000 ml/);
      assert.equal(await page.locator('#measure-value').textContent(), '1350');
      await captureState(page, 'corrected');
    });
    await check('eight servings scales selected water to 1800 ml without closing evidence', async () => {
      await page.getByRole('button', { name: 'One more serving' }).click();
      await page.waitForFunction(() => document.querySelector('#display-servings').textContent === '7');
      await page.getByRole('button', { name: 'One more serving' }).click();
      await amount(page, 'Water', '1800 ml');
      assert.equal(await page.locator('#display-servings').textContent(), '8');
      assert.equal(await page.locator('#measure-title').textContent(), 'The water measure');
      assert.equal(await page.locator('#measure-value').textContent(), '1800');
      assert.equal(await ingredient(page, 'Water').locator('.evidence').isVisible(), true);
      await captureState(page, 'corrected-eight');
    });
    await check('public phone form and import are disabled and approval is absent', async () => {
      const fields = page.locator('#call-form input, #call-form select');
      for (let index = 0; index < await fields.count(); index++) assert.equal(await fields.nth(index).isDisabled(), true);
      assert.equal(await page.locator('#preview-call').isDisabled(), true);
      assert.equal(await page.locator('#import-file').isDisabled(), true);
      assert.equal(await page.locator('#import-label').getAttribute('aria-disabled'), 'true');
      assert.equal(await page.locator('#execute-call').isVisible(), false);
      assert.equal(await page.locator('#call-preview').isVisible(), false);
    });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    let mobile;
    await check('mobile at 390 pixels has no horizontal overflow', async () => {
      mobile = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(mobile.document <= mobile.viewport + 1, JSON.stringify(mobile));
      assert.ok(mobile.body <= mobile.viewport + 1, JSON.stringify(mobile));
      assert.equal(await page.locator('#measure-value').textContent(), '1800');
    });
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    await check('no browser errors, failed assets or API/form traffic occurred', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(failedResponses, []);
      assert.deepEqual(forbiddenRequests, []);
      assert.equal(requests.some(request => request.path.includes('/api/') || request.method !== 'GET'), false);
      assert.ok(requests.some(request => request.path === '/measureback/data.json'));
    });
    const receipt = {
      checkedAt: new Date().toISOString(), url: page.url(), status: response.status(),
      deploymentHeaders: response.headers(), config, checks, states, requests,
      mobile, errors, failedResponses, forbiddenRequests,
      screenshots: ['desktop.png', 'mobile.png'],
      scope: 'Independent live public deployment checks; counted separately from local browser checks.',
    };
    await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await context.close();
    process.stdout.write(`Verified ${checks.length} independent public checks. Receipt: ${path.join(output, 'receipt.json')}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

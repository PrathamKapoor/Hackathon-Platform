import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, createBrowserHarness, type BrowserHarness } from '../browser.ts';

/**
 * Browser coverage for the three routes that existed only as links.
 *
 * Each of these was a URL the product handed to a human with no route behind
 * it. A browser test is the only thing that catches that class of defect,
 * because the API happily returns a string that the SPA cannot serve — no unit
 * test of the API would ever notice.
 */
describe('browser: newly routed surfaces', () => {
  let harness: BrowserHarness;

  before(async () => {
    harness = await createBrowserHarness();
  });

  after(async () => {
    await harness.close();
  });

  test('a gallery card opens the project page, with content and links', async () => {
    const context = await harness.freshContext();
    const page = await context.newPage();
    await page.goto(`/e/dogfood-2026/gallery`);
    await page.waitForSelector('article a[href*="/projects/"]');

    const firstCard = page.locator('article a[href*="/projects/"]').first();
    const href = await firstCard.getAttribute('href');
    assert.ok(href !== null && href.includes('/projects/'), `unexpected card link: ${String(href)}`);

    await firstCard.click();
    await page.waitForURL('**/projects/**');

    /*
     * Wait for the project to load, not just the route.
     *
     * The route matches as soon as the URL changes, which is while the page is
     * still showing "Loading project". Reading the body at that point found
     * neither the 404 page nor any project content, and the assertion below —
     * which exists precisely to prove the page is populated — failed on a
     * perfectly good page.
     */
    await page.waitForSelector('h1', { timeout: 20_000 });
    await page.waitForSelector('text=Community vote', { timeout: 20_000 });

    const heading = (await page.locator('h1').first().innerText()).trim();
    assert.ok(heading.length > 0, 'the project page has a name');

    const body = await page.locator('main').innerText();
    assert.ok(!body.includes('Nothing here'), 'the project page is not the 404 page');
    assert.ok(!body.includes('Loading project'), 'the project page is still loading');
    // Screenshots or the long description, so the page is genuinely populated.
    assert.ok(
      body.includes('About this project') || body.includes('The problem') || body.includes('Screenshots'),
      `the project page renders no project content:\n${body.slice(0, 400)}`,
    );
    await harness.shot(page, 'public-project');
    await context.close();
  });

  test('the project page shows a signed-out visitor why they cannot vote', async () => {
    const context = await harness.freshContext();
    const page = await context.newPage();
    await page.goto(`/e/dogfood-2026/gallery`);
    await page.waitForSelector('article a[href*="/projects/"]');
    await page.locator('article a[href*="/projects/"]').first().click();
    await page.waitForURL('**/projects/**');

    await page.waitForSelector('text=Community vote');
    const body = await page.locator('main').innerText();
    assert.ok(
      body.includes('Sign in to vote') || body.includes('Sign in to vote for a project'),
      'a signed-out visitor is told signing in is what voting needs',
    );
    await context.close();
  });

  test('a signed-in participant sees their own vote state on a project', async () => {
    const page = await harness.signedIn(ACCOUNTS.participant);
    await page.goto(`/e/dogfood-2026/gallery`);
    await page.waitForSelector('article a[href*="/projects/"]');
    await page.locator('article a[href*="/projects/"]').first().click();
    await page.waitForURL('**/projects/**');
    await page.waitForSelector('text=Community vote');

    const body = await page.locator('main').innerText();
    // The demo event has voting enabled with a window, so the control resolves
    // to either the vote button or the withdraw control depending on whether
    // this account already voted - never to a bare dead button.
    assert.ok(
      body.includes('Vote for this project') || body.includes('Withdraw my vote'),
      'the vote control reflects real server-side vote state',
    );
    await page.context().close();
  });

  test('a certificate reference resolves and reports a real verification status', async () => {
    const reference = harness.db.value<string>('SELECT reference FROM certificates LIMIT 1');
    assert.ok(reference !== null, 'seeding issues at least one certificate');

    const context = await harness.freshContext();
    const page = await context.newPage();
    await page.goto(`/certificates/${reference}`);
    await page.waitForSelector('h1');

    const body = await page.locator('main').innerText();
    assert.ok(!body.includes('Nothing here'), 'the certificate route resolves');
    assert.ok(
      body.includes('Valid') || body.includes('Tampered') || body.includes('Revoked'),
      'the page states the verification verdict',
    );
    // The hash is shown, because the point is that anyone can check it.
    assert.ok(/[0-9a-f]{16,}/i.test(body), 'the certificate page shows the integrity hash');
    await harness.shot(page, 'public-certificate');
    await context.close();
  });

  test('an unknown certificate reference explains itself instead of erroring', async () => {
    const context = await harness.freshContext();
    const page = await context.newPage();
    await page.goto('/certificates/CRT-00000-00000');
    await page.waitForSelector('h1');
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('not found') || body.includes('Not found'), 'an unknown reference is handled');
    await context.close();
  });

  test('an invitation link reaches the invitation page, not the 404', async () => {
    // The preview is public, so a signed-out visitor is the honest case: the
    // route must resolve and explain that signing in is required.
    const code = harness.db.value<string>("SELECT code FROM team_invitations WHERE status = 'PENDING' LIMIT 1");
    if (code === null) {
      // The seeded dataset does not guarantee a pending invitation; the
      // route-agreement test covers the API-issued URL shape in that case.
      return;
    }
    const context = await harness.freshContext();
    const page = await context.newPage();
    await page.goto(`/invite/${code}`);
    await page.waitForSelector('h1');
    const body = await page.locator('main').innerText();
    assert.ok(!body.includes('Nothing here'), 'the invitation route resolves');
    assert.ok(body.includes('Team invitation'), 'the invitation page identifies itself');
    await harness.shot(page, 'invite');
    await context.close();
  });
});

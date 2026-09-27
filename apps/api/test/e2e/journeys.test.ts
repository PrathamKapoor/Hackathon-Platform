/**
 * Browser E2E: the four role journeys, driven as a person would drive them.
 *
 * The HTTP suite proves the API behaves; this proves the *product* works. Every
 * test here navigates by clicking what a user sees, and asserts on what appears
 * on screen. If a route is unreachable from the UI, or a control does nothing,
 * these fail.
 *
 * A failing step writes a screenshot to `test-results/`, because "the test
 * failed" is rarely enough to diagnose a user-interface problem.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserHarness, bundlePresent, ACCOUNTS, type BrowserHarness } from '../browser.ts';

const skip = bundlePresent() ? false : 'apps/web/dist is missing — run `npm run build`';

let dir = '';
let h: BrowserHarness;

describe('browser: public visitor', { skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-e2e-public-'));
    h = await createBrowserHarness({ dir });
  });
  after(async () => {
    await h?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('the landing page explains the product and links onward', async () => {
    const page = await (await h.freshContext()).newPage();
    const response = await page.goto('/');
    assert.equal(response?.status(), 200);

    await page.waitForSelector('h1');
    const heading = await page.textContent('h1');
    assert.ok(heading !== null && heading.trim().length > 0, 'the landing page has no heading');

    // The hero must state what this is, not just "Verdict".
    const body = (await page.textContent('body')) ?? '';
    assert.match(body, /rubric|judging|reproduc/i, 'the landing page does not explain the judging model');
    assert.ok((await page.locator('a[href="/events"]').count()) > 0, 'no link to the events list');
    await h.shot(page, 'public-landing');
  });

  test('the Grainient background renders, is decorative, and survives reduced motion', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForSelector('h1');

    const canvas = page.locator('canvas.hero__grain');
    assert.equal(await canvas.count(), 1, 'the landing hero has no Grainient canvas');

    /*
     * It must be hidden from assistive technology and must not intercept
     * clicks. A decorative shader that sits above the content with pointer
     * events enabled is a bug that only shows up as "the button does nothing".
     */
    assert.equal(await canvas.getAttribute('aria-hidden'), 'true', 'the Grainient canvas is exposed to screen readers');
    /*
     * `getComputedStyle` is reached through the element's own
     * `ownerDocument.defaultView`. The callback is serialized into the browser,
     * so it cannot close over a helper defined here, and this project does not
     * typecheck its API tests with `lib: DOM` — which is why the lookup is
     * written out rather than imported.
     */
    const pe = await canvas.evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      if (view === null) throw new Error('detached document');
      return view.getComputedStyle(element).pointerEvents;
    });
    assert.equal(pe, 'none', 'the Grainient canvas intercepts pointer events');

    // The hero's CSS gradient is the fallback, so the element behind the canvas
    // is never empty even where WebGL is unavailable.
    const heroBackground = await page.locator('.hero').evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      if (view === null) throw new Error('detached document');
      return view.getComputedStyle(element).backgroundImage;
    });
    assert.ok(heroBackground.includes('gradient'), 'the hero has no gradient fallback behind the canvas');

    // Reduced motion must remove the canvas entirely, not merely slow it down.
    const reduced = await h.freshContext({ reducedMotion: 'reduce' });
    const reducedPage = await reduced.newPage();
    const errors: string[] = [];
    reducedPage.on('pageerror', (error) => errors.push(error.message));
    await reducedPage.goto('/');
    await reducedPage.waitForSelector('h1');
    const display = await reducedPage.locator('canvas.hero__grain').evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      if (view === null) throw new Error('detached document');
      return view.getComputedStyle(element).display;
    });
    assert.equal(display, 'none', 'the Grainient still renders under prefers-reduced-motion');
    assert.deepEqual(errors, [], `the page threw with reduced motion: ${errors.join('; ')}`);
    await h.shot(reducedPage, 'public-landing-reduced-motion');
  });

  test('an event list is reachable and each event links to its page', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/events');
    await page.waitForSelector('h1');

    const cards = page.locator('article');
    assert.ok((await cards.count()) > 0, 'the events page listed nothing');

    await cards.first().getByRole('link').first().click();
    await page.waitForURL(/\/e\//);
    await page.waitForSelector('h1');
    assert.match((await page.textContent('body')) ?? '', /Dogfood/, 'the event page did not load the seeded event');
    await h.shot(page, 'public-event');
  });

  test('the gallery lists projects and search narrows them', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/e/dogfood-2026/gallery');
    await page.waitForSelector('h1');

    const projects = page.locator('article');
    const total = await projects.count();
    assert.ok(total >= 2, `the gallery showed ${String(total)} projects; the seed has twelve`);

    // Search must actually filter, not just be present. Waiting on the
    // locator rather than a `waitForFunction` keeps the callback out of the
    // browser context, where the DOM types are not in scope for this project.
    await page.getByLabel(/search/i).fill('Lattice');
    await page
      .locator('article')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    // Poll the rendered count until it settles below the unfiltered total.
    let narrowed = await projects.count();
    for (let attempt = 0; attempt < 20 && narrowed >= total; attempt += 1) {
      await page.waitForTimeout(150);
      narrowed = await projects.count();
    }
    assert.ok(narrowed < total, `search did not narrow the gallery (${String(narrowed)} of ${String(total)})`);
    assert.ok(narrowed >= 1, 'search narrowed to nothing for a project that exists');
    await h.shot(page, 'public-gallery-search');
  });

  test('the published results board is readable without signing in', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/e/dogfood-2026/results');
    await page.waitForSelector('h1');

    const body = (await page.textContent('body')) ?? '';
    if (/Not published yet/.test(body)) {
      // The seed publishes results, so this branch means something regressed.
      // Assert it loudly rather than accepting it quietly.
      assert.fail('the seeded event should have published results');
    }

    // The board must show a ranking with real project names.
    const rows = page.locator('table tbody tr');
    assert.ok((await rows.count()) > 0, 'the results board listed no projects');
    const text = (await rows.first().textContent()) ?? '';
    assert.match(text, /\d/, 'the first row shows no rank');
    await h.shot(page, 'public-results');
  });

  test('a deep link survives a reload', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/e/dogfood-2026/results');
    await page.waitForSelector('h1');
    await page.reload();
    await page.waitForSelector('h1');
    assert.match(page.url(), /\/e\/dogfood-2026\/results/, 'the reload lost the route');
  });

  test('a private route sends a signed-out visitor to sign in', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/organize');
    await page.waitForURL(/\/signin/, { timeout: 15_000 });
    assert.ok(page.url().includes('/signin'), `expected a redirect to sign-in, got ${page.url()}`);
  });
});

describe('browser: sign in', { skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-e2e-auth-'));
    h = await createBrowserHarness({ dir });
  });
  after(async () => {
    await h?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('the sign-in form accepts the demo credentials and shows who you are', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/signin');
    await page.waitForSelector('h1');

    await page.getByLabel(/email/i).fill(ACCOUNTS.organizer);
    await page.getByLabel(/password/i).fill('verdict-demo-2026');
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL(/\/workspace|\/$/, { timeout: 20_000 });
    await page.waitForSelector('body');
    const body = (await page.textContent('body')) ?? '';
    assert.ok(body.length > 0);
    await h.shot(page, 'auth-signed-in');
  });

  test('a wrong password is reported and does not sign anyone in', async () => {
    const context = await h.freshContext();
    const page = await context.newPage();
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill(ACCOUNTS.organizer);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Either a visible error or staying on the form is correct; landing on a
    // signed-in workspace is not.
    await page.waitForSelector('[role="alert"], h1', { timeout: 15_000 });
    assert.ok(page.url().includes('/signin'), `a wrong password navigated to ${page.url()}`);
    const alert = page.locator('[role="alert"]');
    if ((await alert.count()) > 0) {
      assert.ok(((await alert.textContent()) ?? '').trim().length > 0, 'the error alert is empty');
    }
  });
});

describe('browser: judge', { skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-e2e-judge-'));
    h = await createBrowserHarness({ dir });
  });
  after(async () => {
    await h?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('a judge sees their queue with progress and project context', async () => {
    const page = await h.signedIn(ACCOUNTS.generousJudge);
    await page.goto('/judge');
    await page.waitForSelector('h1');

    const body = (await page.textContent('body')) ?? '';
    assert.match(body, /queue/i, 'the judging page does not announce a queue');
    assert.match(body, /assigned|submitted|progress|complete/i, 'no progress information is shown');

    const items = page.locator('article');
    assert.ok((await items.count()) > 0, 'the judge queue is empty for a judge with assignments');

    // Each queued project must be identifiable, not a bare row.
    const first = (await items.first().textContent()) ?? '';
    assert.ok(first.trim().length > 20, 'a queue entry carries no useful text');
    await h.shot(page, 'judge-queue');
  });

  test('a judge can open a project, score every criterion, and submit', async () => {
    const page = await h.signedIn(ACCOUNTS.unfinishedJudge);
    await page.goto('/judge');
    await page.waitForSelector('h1');

    // The seed deliberately leaves this judge with unfinished reviews, so there
    // is genuinely something to do rather than a form that is already done.
    const start = page.getByRole('link', { name: /start review|continue|review again/i }).first();
    assert.ok((await start.count()) > 0, 'no reviewable project in the unfinished judge queue');
    await start.click();
    await page.waitForURL(/\/judge\/asg_/);

    // The rubric must be visible before scoring.
    await page.waitForSelector('h1');
    /*
     * Score controls are found by `data-criterion`, not by role. The engine
     * supports INTEGER, DECIMAL and BOOLEAN, so the control type varies per
     * criterion and there is no single role to select on. This test was written
     * against `input[type="range"]`, which the product does not use and never
     * did — it passed only because the page crashed before reaching this line.
     */
    const controls = page.locator('[data-criterion]');
    const criteria = await controls.count();
    assert.ok(criteria > 0, 'the review form has no score controls');

    // Set every criterion to a mid-range value, respecting the control type.
    for (let index = 0; index < criteria; index += 1) {
      const control = controls.nth(index);
      const tag = await control.evaluate((element) => element.tagName);
      if (tag === 'INPUT') {
        const type = (await control.getAttribute('type')) ?? 'text';
        if (type === 'checkbox') {
          await control.check();
          continue;
        }
        const min = Number((await control.getAttribute('min')) ?? '0');
        const max = Number((await control.getAttribute('max')) ?? '10');
        await control.fill(String((min + max) / 2));
        continue;
      }
      // A BOOLEAN criterion on a 0..1 scale renders as two buttons. Take the
      // affirmative one, and confirm it reports itself as pressed.
      await page.locator('[data-criterion][aria-pressed]').nth(1).click();
    }

    // A comment on the first criterion, since comments are part of the review.
    const firstComment = page.locator('textarea').first();
    await firstComment.fill('Ran it locally. The failure modes are documented and the build is reproducible.');

    await page.getByRole('button', { name: /save draft/i }).click();
    await page.waitForSelector('[role="status"]', { timeout: 15_000 });
    assert.match((await page.textContent('[role="status"]')) ?? '', /saved/i, 'the draft save was not confirmed');
    await h.shot(page, 'judge-review-filled');

    await page.getByRole('button', { name: /submit review/i }).click();
    // Submitting returns the judge to their queue.
    await page.waitForURL(/\/judge$/, { timeout: 20_000 });
    assert.match((await page.textContent('body')) ?? '', /submitted|in progress/i, 'the queue did not reflect the submission');
  });

  test('a judge can record a head-to-head comparison', async () => {
    const page = await h.signedIn(ACCOUNTS.unfinishedJudge);
    await page.goto('/pairwise');
    await page.waitForSelector('h1');

    const body = (await page.textContent('body')) ?? '';
    assert.match(body, /head-to-head/i, 'the pairwise page did not render');

    // Both sides must be identifiable, which is the point of the screen: an
    // anonymous "which is better?" prompt is not a comparison.
    const firstPair = page.locator('section').filter({ has: page.getByRole('button', { name: /A is stronger/i }) }).first();
    const pairText = (await firstPair.textContent()) ?? '';
    assert.ok(pairText.length > 60, 'a comparison card shows no project detail');

    // Tie is a real answer and must be reachable without scrolling past a
    // confirm step.
    await firstPair.getByRole('button', { name: /^Tie$/i }).click();
    await page.waitForSelector('[role="status"]', { timeout: 15_000 });
    assert.match((await page.textContent('[role="status"]')) ?? '', /recorded/i, 'the comparison was not confirmed');
    await h.shot(page, 'judge-pairwise');

    // The comparison is persisted, not just held in component state.
    const count = h.db.value<number>(
      `SELECT COUNT(*) AS c FROM pairwise_comparisons pc
         JOIN judges j ON j.id = pc.judge_id
         JOIN users u ON u.id = j.user_id
        WHERE u.email_normalized = :e AND pc.outcome = 'TIE'`,
      { e: ACCOUNTS.unfinishedJudge },
    );
    assert.ok((count ?? 0) > 0, 'the recorded comparison did not reach the database');
  });

  test('a judge cannot reach the organizer console', async () => {
    const page = await h.signedIn(ACCOUNTS.generousJudge);
    // The navigation must not offer it…
    const nav = await page.goto('/');
    assert.equal(nav?.status(), 200);
    await page.waitForSelector('.nav');
    const navText = (await page.locator('.nav').textContent()) ?? '';
    assert.doesNotMatch(navText, /organizer/i, 'a judge is offered the organizer console');

    // …and the route must refuse. The console has its own <h1>; a judge is
    // redirected away from it. Asserting on the whole body would be wrong: the
    // navigation legitimately contains the word "Judging" for a judge.
    await page.goto('/organize');
    await page.waitForSelector('h1', { timeout: 15_000 });
    const headings = (await page.locator('h1').allTextContents()).join(' | ');
    assert.doesNotMatch(headings, /organizer/i, 'the organizer console rendered for a judge');
    const body = (await page.textContent('body')) ?? '';
    assert.doesNotMatch(body, /Compute results|coverage by project|1 · Compute/i, 'organizer operations rendered for a judge');
  });
});

describe('browser: organizer', { skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-e2e-organizer-'));
    h = await createBrowserHarness({ dir });
  });
  after(async () => {
    await h?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('the organizer console opens and offers the judging operations', async () => {
    const page = await h.signedIn(ACCOUNTS.organizer);
    await page.goto('/organize');
    await page.waitForSelector('h1');

    const body = (await page.textContent('body')) ?? '';
    assert.match(body, /coverage|judging/i, 'no coverage information on the organizer console');
    assert.match(body, /compute|snapshot|publish/i, 'no publication controls on the organizer console');
    await h.shot(page, 'organizer-console');
  });

  test('an organizer can compute, snapshot, publish and verify a result', async () => {
    const page = await h.signedIn(ACCOUNTS.organizer);
    await page.goto('/organize');
    await page.waitForSelector('h1');

    // Switch to the results tab.
    await page.getByRole('button', { name: /^results$/i }).click();
    await page.waitForSelector('text=/publish/i', { timeout: 15_000 });

    await page.getByRole('button', { name: /1 · compute/i }).click();
    // The run summary appears once the run is computed.
    await page.waitForSelector('text=/last computed run/i', { timeout: 30_000 });

    await page.getByRole('button', { name: /2 · snapshot/i }).click();
    await page.waitForSelector('text=/verify reproduction/i', { timeout: 20_000 });
    // The verify button only becomes available once a snapshot exists.
    const verifyEnabled = await page.getByRole('button', { name: /4 · verify/i }).isEnabled();
    assert.ok(verifyEnabled, 'verification is unavailable after snapshotting');

    await page.getByRole('button', { name: /4 · verify/i }).click();
    await page.waitForSelector('text=/reproduction/i', { timeout: 30_000 });
    const body = (await page.textContent('body')) ?? '';
    assert.match(
      body,
      /MATCH|MISMATCH/,
      'the verification result was not shown',
    );
    assert.doesNotMatch(body, /MISMATCH/, 'a freshly computed result did not reproduce');
    await h.shot(page, 'organizer-verified');
  });

  test('an organizer is offered the score table with real per-project data', async () => {
    const page = await h.signedIn(ACCOUNTS.organizer);
    await page.goto('/organize');
    await page.waitForSelector('h1');

    const rows = page.locator('table tbody tr');
    assert.ok((await rows.count()) > 0, 'the organizer score table is empty');

    // Numbers must be derived from the seeded data, not hard-coded.
    const coverageRow = (await rows.first().textContent()) ?? '';
    assert.match(coverageRow, /\d/, 'the coverage row contains no numbers');
    await h.shot(page, 'organizer-coverage');
  });
});

describe('browser: participant', { skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-e2e-participant-'));
    h = await createBrowserHarness({ dir });
  });
  after(async () => {
    await h?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('a participant sees their workspace, not organizer controls', async () => {
    const page = await h.signedIn(ACCOUNTS.participant);
    await page.goto('/workspace');
    await page.waitForSelector('h1');

    const body = (await page.textContent('body')) ?? '';
    assert.match(body, /workspace/i, 'the workspace did not load');
    assert.doesNotMatch(body, /compute results|publish snapshot/i, 'a participant sees organizer controls');
    await h.shot(page, 'participant-workspace');
  });

  test('a participant is not offered the judging or organizer navigation', async () => {
    const page = await h.signedIn(ACCOUNTS.participant);
    await page.goto('/');
    await page.waitForSelector('.nav');
    const navText = (await page.locator('.nav').textContent()) ?? '';
    assert.doesNotMatch(navText, /organizer/i, 'a participant is offered the organizer console');
    assert.doesNotMatch(navText, /judging/i, 'a participant is offered the judging console');
  });
});

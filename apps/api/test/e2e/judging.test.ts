import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, createBrowserHarness, type BrowserHarness } from '../browser.ts';

/**
 * The judge scoring surface, in detail.
 *
 * The existing journey proves a judge can score and submit. This covers the
 * things that make scoring thirty to a hundred projects survivable: the project
 * context is on the page, work is never lost, the judge knows where they are,
 * and moving on costs one action.
 */
describe('browser: judge scoring surface', () => {
  let harness: BrowserHarness;

  before(async () => {
    harness = await createBrowserHarness();
  });

  after(async () => {
    await harness.close();
  });

  /** Open the first reviewable project in the queue. */
  const openFirstReview = async (email: string): Promise<import('playwright').Page> => {
    const page = await harness.signedIn(email);
    await page.goto('/judge');
    await page.waitForSelector('h1');
    const start = page.getByRole('link', { name: /start review|continue|review again/i }).first();
    await start.click();
    await page.waitForURL(/\/judge\/asg_/);
    // The form mounts with its criteria; wait for a score control rather than
    // the heading, since the rubric arrives on the same request as the review.
    await page.waitForSelector('[data-criterion]', { timeout: 20_000 });
    return page;
  };

  test('the review page shows the project context, not just the score boxes', async () => {
    const page = await openFirstReview(ACCOUNTS.unfinishedJudge);
    const body = (await page.locator('main').innerText()).toLowerCase();

    // A judge cannot score a project they have not read, so the description and
    // the rubric guidance belong above the controls.
    assert.ok(body.includes('read the full description'), 'the project description is not available on the review page');
    assert.ok(
      body.includes('what this rubric is asking'),
      'the judge guidance is not shown before scoring',
    );
    // Scale and weight, so the judge knows what a number means.
    assert.ok(/weight \d+%/.test(body), 'criterion weight is not shown');
    assert.ok(/required|optional/.test(body), 'required criteria are not marked');
    await harness.shot(page, 'judge-review-context');
    await page.context().close();
  });

  test('the review page orients the judge in the queue and can move between projects', async () => {
    const page = await openFirstReview(ACCOUNTS.unfinishedJudge);

    const nav = page.locator('.review-nav');
    await nav.waitFor({ timeout: 20_000 });
    const navText = await nav.innerText();
    assert.ok(
      /\d+ of \d+/.test(navText),
      `the review page does not say where the judge is in the queue: "${navText}"`,
    );
    assert.ok(/left/.test(navText), 'the review page does not report how much is left');

    // Progress is also a meter, exposed to assistive technology.
    const meter = page.locator('[role="progressbar"][aria-label="Queue completion"]');
    assert.ok((await meter.count()) > 0, 'queue completion is not exposed as a progress bar');

    // There is a direct link to the next project, so a judge working a list
    // never has to return to the queue to find it.
    const nextLink = nav.getByRole('link', { name: /→/ });
    assert.ok((await nextLink.count()) > 0, 'no next-project link is offered');

    const firstHref = await nextLink.getAttribute('href');
    await nextLink.click();
    await page.waitForURL('**/judge/asg_**', { timeout: 20_000 });
    await page.waitForSelector('[data-criterion]', { timeout: 20_000 });
    assert.notEqual(await page.url(), firstHref, 'the next link did not navigate to another project');
    await page.context().close();
  });

  test('a draft is autosaved without the judge pressing save', async () => {
    const page = await openFirstReview(ACCOUNTS.unfinishedJudge);

    const control = page.locator('input[data-criterion]').first();
    const min = Number((await control.getAttribute('min')) ?? '0');
    const max = Number((await control.getAttribute('max')) ?? '10');
    const value = String(Math.round((min + max) / 2));

    // Scoped to the criterion actually being edited. `data-criterion` is the
    // criterion id, so the same control can be found again after a reload even
    // though "the first input" is not a stable identity.
    const criterionId = (await control.getAttribute('data-criterion')) as string;
    await control.fill(value);

    // The state becomes visible without a request being made by hand, then
    // settles on saved — which is the promise autosave makes.
    //
    // Matched on the machine-readable state rather than the rendered text:
    // Playwright's `:has-text()` is a case-insensitive substring match, so
    // "Saved" also matches the region that says "Score every required criterion
    // first", the wait would resolve before the autosave timer had even fired,
    // and the test would pass against a draft that was never written.
    await page.locator('[data-save-state="dirty"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-save-state="saved"]').waitFor({ timeout: 20_000 });

    // Prove the draft really is on the server: reload and it is still there.
    const before = await page.url();
    await page.reload();
    await page.waitForSelector('input[data-criterion]', { timeout: 20_000 });

    // Read the property, never match on the attribute: React sets `value` on
    // the DOM property and not as an attribute, so `[value="..."]` never
    // matches a controlled input however it is filled. The predicate is passed
    // as a source string because this file is compiled without the DOM library,
    // and a callback would have to type-check `document` for no benefit.
    const restored = page.locator(`input[data-criterion="${criterionId}"]`);
    await restored.waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      `document.querySelector('input[data-criterion=${JSON.stringify(criterionId)}]')?.value === ${JSON.stringify(value)}`,
      undefined,
      { timeout: 20_000 },
    );

    assert.equal(await page.url(), before, 'the reload lost the draft');
    assert.equal(
      await restored.inputValue(),
      value,
      'the autosaved value did not survive a reload',
    );
    await page.context().close();
  });

  test('submitting states where the judge is taken next, before they commit', async () => {
    const page = await openFirstReview(ACCOUNTS.unfinishedJudge);

    // Score everything so submit is enabled.
    const controls = page.locator('[data-criterion]');
    const count = await controls.count();
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const tag = await control.evaluate((element) => element.tagName);
      if (tag === 'INPUT') {
        const min = Number((await control.getAttribute('min')) ?? '0');
        const max = Number((await control.getAttribute('max')) ?? '10');
        await control.fill(String(Math.round((min + max) / 2)));
        continue;
      }
      await page.locator('[data-criterion][aria-pressed]').nth(1).click();
    }

    const submit = page.getByRole('button', { name: /submit review/i });
    await submit.waitFor({ timeout: 20_000 });
    assert.ok(await submit.isEnabled(), 'submit is disabled with every criterion scored');

    // The button names the action; the consequence is stated beside it.
    const body = (await page.locator('main').innerText()).toLowerCase();
    if (body.includes('the next in your queue')) {
      assert.ok(
        body.includes('locks this review'),
        'the auto-advance is not explained before the judge commits',
      );
    }
    await page.context().close();
  });

  test('a submitted review is read-only and says so', async () => {
    const page = await openFirstReview(ACCOUNTS.unfinishedJudge);

    const controls = page.locator('[data-criterion]');
    const count = await controls.count();
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const tag = await control.evaluate((element) => element.tagName);
      if (tag === 'INPUT') {
        const min = Number((await control.getAttribute('min')) ?? '0');
        const max = Number((await control.getAttribute('max')) ?? '10');
        await control.fill(String(Math.round((min + max) / 2)));
        continue;
      }
      await page.locator('[data-criterion][aria-pressed]').nth(1).click();
    }

    await page.getByRole('button', { name: /submit review/i }).click();
    // Either the next project or the queue.
    await page.waitForURL(/\/judge(\/asg_[^/]*)?$/, { timeout: 25_000 });

    // Come back and look at what was just submitted.
    await page.goto('/judge');
    await page.waitForSelector('h1');
    await page.waitForSelector('text=/\\d+ assigned/', { timeout: 20_000 });
    const again = page.getByRole('link', { name: /review again/i }).first();
    if ((await again.count()) > 0) {
      await again.click();
      await page.waitForURL(/\/judge\/asg_/, { timeout: 20_000 });
      await page.waitForSelector('[data-criterion]', { timeout: 20_000 });
      const body = (await page.locator('main').innerText()).toLowerCase();
      assert.ok(
        body.includes('submitted and can no longer be changed'),
        'a submitted review does not tell the judge it is locked',
      );
      // Every score control must actually be disabled.
      const enabled = await page.locator('[data-criterion]:not([disabled])').count();
      assert.equal(enabled, 0, 'a submitted review still has editable score controls');
    }
    await page.context().close();
  });
});

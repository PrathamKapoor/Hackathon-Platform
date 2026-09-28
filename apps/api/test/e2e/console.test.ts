import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { ACCOUNTS, createBrowserHarness, type BrowserHarness } from '../browser.ts';

/**
 * The organizer console, section by section, in a real browser.
 *
 * The console is the product's operating surface, and it is built from eleven
 * panels that each hit a different part of the API. A panel can be present,
 * labelled correctly, and still be broken — a 403 in a `useApi` hook, a field
 * that never renders, a table that stays empty because the response shape was
 * transcribed wrong. None of that is visible to a type checker, and all of it is
 * visible here.
 *
 * So this walks every section, asserts it renders real data from the seeded
 * event, and drives the two most consequential interactions end to end:
 * preview-then-commit the assignment engine, and compute-then-snapshot-then-
 * verify a result.
 */
describe('browser: organizer console', () => {
  let harness: BrowserHarness;
  let context: BrowserContext;
  let page: Page;

  before(async () => {
    harness = await createBrowserHarness();
  });

  after(async () => {
    await context?.close();
    await harness.close();
  });

  /**
   * Case-insensitive text assertion.
   *
   * Playwright's `innerText` returns *rendered* text, so a table header with
   * `text-transform: uppercase` comes back as "EXPERTISE" even though the source
   * says "Expertise". Every metric tile and column header in this design system
   * is uppercased, so a case-sensitive `includes` against the source casing can
   * never match — which produced a run of "panel is broken" failures for a panel
   * that was rendering perfectly. Comparing case-insensitively tests what the
   * user actually sees.
   */
  const sees = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.toLowerCase());

  /**
   * Sign in as the organizer and open a section.
   *
   * Waiting on the panel's `h2` is not enough: the heading mounts in the same
   * commit as the panel shell, while the data arrives on a later one, so
   * reading `innerText` immediately after sees a correctly-labelled but still
   * empty section. Every section here therefore waits for the content it is
   * about to assert on. Reading early here is a flaky-test bug that would
   * otherwise get "fixed" by weakening the assertion.
   */
  const openSection = async (label: string, name: string): Promise<void> => {
    if (context === undefined) {
      context = await harness.freshContext();
      page = await harness.signedIn(ACCOUNTS.organizer);
    }
    if (!page.url().includes('/organize')) {
      await page.goto('/organize');
      await page.waitForSelector('h1');
    }
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForSelector(`h2:text-is("${name}")`, { timeout: 20_000 });
  };

  test('the console shell offers every section', async () => {
    if (context === undefined) {
      context = await harness.freshContext();
      page = await harness.signedIn(ACCOUNTS.organizer);
    }
    await page.goto('/organize');
    await page.waitForSelector('h1');

    const nav = page.locator('.console__nav');
    const labels = await nav.locator('button').allInnerTexts();
    for (const expected of [
      'Overview', 'Registrations', 'Teams', 'Panel', 'Assignments',
      'Rubric', 'Results', 'Diagnostics', 'Community', 'Integrations', 'Audit',
    ]) {
      assert.ok(labels.includes(expected), `the console nav is missing ${expected}. Found: ${labels.join(', ')}`);
    }
    // Platform is ADMIN-only and this account is an organizer, not an admin.
    assert.ok(!labels.includes('Platform'), 'a non-admin organizer is not offered the platform section');
    await harness.shot(page, 'organizer-console-nav');
  });

  test('Overview shows real counted numbers, not placeholders', async () => {
    await openSection('Overview', 'Dogfood 2026');
    const text = await page.locator('main').innerText();

    // Metrics must be real counts. The seed creates 12 projects and 5 judges,
    // so a "—" here would mean the panel is not reading the API at all.
    assert.ok(/\b12\b/.test(text), `the project count is not shown as a real number:\n${text.slice(0, 400)}`);
    assert.ok(/\b5\b/.test(text), 'the judge count is not shown as a real number');
    assert.ok(!/—/.test(text.slice(0, 600)), 'a metric rendered as a placeholder dash instead of a count');
    await harness.shot(page, 'organizer-overview');
  });

  test('Registrations lists applicants with a decision control each', async () => {
    await openSection('Registrations', 'Applicants');
    await page.waitForSelector('table.data tbody tr');
    const rows = await page.locator('table.data tbody tr').count();
    assert.ok(rows > 0, 'the applicant queue is empty against the seeded event');

    const body = await page.locator('main').innerText();
    // The form questions and the export must both be present, not just the table.
    assert.ok(body.includes('Application form'), 'the registration form is not shown');
    assert.ok(body.includes('Download registrations CSV'), 'the CSV export is not offered');
    await harness.shot(page, 'organizer-registrations');
  });

  test('Panel shows judges, workload and the conflict register', async () => {
    await openSection('Panel', 'Judges');
    await page.waitForSelector('table.data tbody tr', { timeout: 20_000 });
    const body = await page.locator('main').innerText();
    assert.ok(sees(body, 'Expertise'), 'judge expertise is not shown');
    assert.ok(sees(body, 'Conflict register'), 'the conflict register is missing');
    assert.ok(sees(body, 'Load balance'), 'the load balance view is missing');
    await harness.shot(page, 'organizer-panel');
  });

  test('Assignments previews a plan and commits exactly that plan', async () => {
    await openSection('Assignments', 'Generate an assignment plan');

    await page.getByRole('button', { name: /Preview plan/ }).click();
    // The dry run renders with its own heading and the input hash.
    await page.waitForSelector('h2:has-text("Dry run")', { timeout: 25_000 });
    // The metrics are the payload, so wait for one of them rather than the shell.
    await page.waitForSelector('.metric__label:text-is("Fully covered")', { timeout: 25_000 });
    const dryRun = await page.locator('main').innerText();
    assert.ok(sees(dryRun, 'inputHash'), 'the dry run does not show the input hash that binds the plan');
    assert.ok(sees(dryRun, 'Fully covered'), 'the dry run does not report coverage');
    assert.ok(sees(dryRun, 'Load spread'), 'the dry run does not report the load spread');

    /*
     * A plan with warnings cannot be committed until the warnings are
     * acknowledged — the seeded panel deliberately has less capacity than the
     * requested coverage, so this path is exercised rather than skipped.
     */
    const commit = page.getByRole('button', { name: 'Commit this plan' });
    assert.ok(await commit.isDisabled(), 'a plan with warnings must not be committable without confirmation');
    const acknowledge = page.getByRole('checkbox', { name: /read these/i });
    await acknowledge.waitFor({ timeout: 10_000 });
    await acknowledge.check();
    await commit.waitFor({ state: 'visible' });
    assert.ok(!(await commit.isDisabled()), 'confirming the warnings must enable the commit');

    // Committing the very plan we were shown.
    await commit.click();
    await page.waitForSelector('.notice--ok', { timeout: 25_000 });
    const committed = await page.locator('.notice--ok').first().innerText();
    assert.ok(/Committed version \d+/.test(committed), `the commit did not confirm a version: ${committed}`);
    await harness.shot(page, 'organizer-assignments');
  });

  test('Rubric shows the locked version and refuses to edit it in place', async () => {
    await openSection('Rubric', 'Rubrics');
    // The lock badge arrives with the version list, so wait for the data rather
    // than the panel shell. "Current version" always renders, immediately.
    await page.waitForSelector('.badge:text-is("Locked")', { timeout: 25_000 });
    const body = await page.locator('main').innerText();
    // The seeded rubric has scores against it, so it must read as locked.
    assert.ok(sees(body, 'Locked'), `the seeded rubric should be locked:\n${body.slice(0, 600)}`);
    assert.ok(sees(body, 'publishing a new version'), 'the locked-state explanation is missing');

    // The editor offers a *new version*, not an edit.
    const newVersion = page.getByRole('button', { name: 'Publish a new version' });
    await newVersion.waitFor({ timeout: 20_000 });
    await newVersion.click();
    await page.waitForSelector('h2:has-text("Publish a new version")');
    // The seeded criteria are loaded into the editor.
    await page.waitForSelector('fieldset.criterion', { timeout: 20_000 });

    // The editor shows the weight total and validates before publishing.
    const editor = await page.locator('main').innerText();
    assert.ok(sees(editor, 'Total weight'), 'the rubric editor does not show the weight total');
    assert.ok(sees(editor, 'Add criterion'), 'the rubric editor cannot add a criterion');
    assert.ok(sees(editor, 'Required'), 'the rubric editor cannot mark a criterion required');
    assert.ok(
      sees(editor, 'Scoring'),
      'the editor offers no scoring-type control',
    );
    await harness.shot(page, 'organizer-rubric');
  });

  test('Results exposes the normalization proof and the full publish sequence', async () => {
    await openSection('Results', '1 · Compute');
    const body = await page.locator('main').innerText();
    assert.ok(sees(body, 'Normalization proof'), 'the normalization proof surface is missing');
    assert.ok(sees(body, 'Snapshots'), 'the snapshot history is missing');

    // Pick an alternative method and read the actual comparison table.
    await page.locator('#norm-method').selectOption('Z_SCORE');
    await page.waitForSelector('.metric__label:text-is("Projects moved")', { timeout: 25_000 });
    const proof = await page.locator('main').innerText();
    assert.ok(sees(proof, 'Projects moved'), 'the comparison does not report how many projects moved');
    assert.ok(sees(proof, 'Compare against raw using'), 'the method selector is missing');
    await harness.shot(page, 'organizer-normalization');

    // Compute.
    await page.getByRole('button', { name: 'Compute', exact: true }).click();
    await page.waitForSelector('h2:has-text("Computed run")', { timeout: 25_000 });
    const run = await page.locator('main').innerText();
    assert.ok(/Integrity hash/.test(run), 'the computed run does not show an integrity hash');

    // Snapshot, then verify reproduction.
    await page.getByRole('button', { name: '2 · Snapshot' }).click();
    await page.waitForSelector('text=Working with snapshot', { timeout: 20_000 });
    await page.getByRole('button', { name: '4 · Verify reproduction' }).click();
    await page.waitForSelector('.notice--ok, .notice--error', { timeout: 25_000 });
    const verdict = await page.locator('.notice--ok, .notice--error').first().innerText();
    assert.ok(
      verdict.includes('MATCH'),
      `reproduction of a snapshot taken moments ago should MATCH, got: ${verdict.slice(0, 200)}`,
    );
    await harness.shot(page, 'organizer-results');
  });

  test('Diagnostics explains that an anomaly is not misconduct', async () => {
    await openSection('Diagnostics', 'Panel health');
    await page.waitForSelector('table.data tbody tr', { timeout: 25_000 });
    const body = await page.locator('main').innerText();
    assert.ok(
      sees(body, 'not misconduct'),
      `the diagnostics framing that an anomaly is not misconduct is missing:\n${body.slice(0, 400)}`,
    );
    assert.ok(sees(body, 'Completion'), 'per-judge completion is not shown');
    assert.ok(sees(body, 'Std dev'), 'per-judge standard deviation is not shown');
    assert.ok(sees(body, 'Panel z'), 'panel deviation is not shown');
    assert.ok(sees(body, 'Range'), 'the score range is not shown');
    assert.ok(sees(body, 'Review flags'), 'the review flag register is missing');
    await harness.shot(page, 'organizer-diagnostics');
  });

  test('Integrations lists certificates and the export kinds', async () => {
    await openSection('Integrations', 'Webhooks');
    await page.getByRole('tab', { name: 'Certificates' }).click();
    await page.waitForSelector('h2:has-text("Certificates")', { timeout: 15_000 });
    await page.waitForSelector('table.data tbody tr', { timeout: 15_000 });
    const certs = await page.locator('main').innerText();
    assert.ok(/CRT-/.test(certs), 'no certificate reference is shown');
    assert.ok(sees(certs, 'Participation records'), 'participation records are missing');

    await page.getByRole('tab', { name: 'Data' }).click();
    await page.waitForSelector('h2:has-text("Export")', { timeout: 15_000 });
    const data = await page.locator('main').innerText();
    assert.ok(sees(data, 'Download') || sees(data, 'Registrations'), 'the export kinds are not offered');
    assert.ok(sees(data, 'Import'), 'the import surface is missing');
    await harness.shot(page, 'organizer-integrations');
  });

  test('Audit shows entries and the tamper-evidence chain digest', async () => {
    await openSection('Audit', 'Audit ledger');
    await page.waitForSelector('table.data tbody tr', { timeout: 20_000 });
    const body = await page.locator('main').innerText();
    assert.ok(sees(body, 'Chain digest'), 'the chain digest is not shown');
    assert.ok(sees(body, 'outcome') || sees(body, 'DENIED') || sees(body, 'SUCCESS'), 'no audit outcome is shown');
    await harness.shot(page, 'organizer-audit');
  });

  test('an organizer cannot reach the platform section, and the server refuses it too', async () => {
    await page.goto('/organize');
    await page.waitForSelector('.console__nav');
    const labels = await page.locator('.console__nav button').allInnerTexts();
    assert.ok(!labels.includes('Platform'), 'an organizer is offered the ADMIN-only platform section');

    // And the endpoints themselves are refused, not merely hidden.
    const refusal = await page.request.get('/api/admin/overview');
    assert.equal(refusal.status(), 403, `the admin overview must refuse an organizer, got ${String(refusal.status())}`);
  });

  test('an admin reaches the platform section and sees the matrix', async () => {
    const admin = await harness.signedIn(ACCOUNTS.admin);
    await admin.goto('/organize');
    await admin.waitForSelector('.console__nav');
    const labels = await admin.locator('.console__nav button').allInnerTexts();
    assert.ok(labels.includes('Platform'), 'an admin is not offered the platform section');

    await admin.getByRole('button', { name: 'Platform', exact: true }).click();
    await admin.waitForSelector('h2:has-text("System")', { timeout: 20_000 });
    const body = await admin.locator('main').innerText();
    assert.ok(sees(body, 'Create an event'), 'the admin cannot create an event from the console');

    // Role management is its own tab, so it has to be opened before asserting,
    // and the grant/revoke controls only exist once a user is actually found.
    await admin.getByRole('tab', { name: 'Users' }).click();
    await admin.waitForSelector('h2:has-text("Users and roles")', { timeout: 15_000 });
    await admin.locator('#us-search').fill('organizer');
    await admin.waitForSelector('table.data tbody tr', { timeout: 20_000 });
    const users = await admin.locator('main').innerText();
    assert.ok(sees(users, 'Event scope'), 'the event-scoped role control is missing');
    assert.ok(sees(users, 'Grant') && sees(users, 'Revoke'), 'role grant and revoke are missing');
    assert.ok(sees(users, 'Suspend'), 'account suspension is missing');

    await admin.getByRole('tab', { name: 'Matrix' }).click();
    await admin.waitForSelector('h2:has-text("Authorization matrix")', { timeout: 15_000 });
    await admin.waitForSelector('table.data tbody tr', { timeout: 15_000 });
    const matrix = await admin.locator('main').innerText();
    for (const role of ['PARTICIPANT', 'JUDGE', 'ORGANIZER', 'ADMIN']) {
      assert.ok(matrix.includes(role), `the matrix does not show ${role}`);
    }
    await harness.shot(admin, 'admin-platform');
    await admin.context().close();
  });
});

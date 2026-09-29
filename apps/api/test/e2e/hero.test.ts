import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHarness, bundlePresent, type BrowserHarness } from '../browser.ts';
import type { Page } from 'playwright';

/**
 * The landing page's interactive panel.
 *
 * The claim under test is arithmetic, so the assertions are on numbers read out
 * of the rendered table rather than on the prose beside it. A hero that quietly
 * stopped being true - a slider wired to nothing, a normalized column that moved
 * when it should not - would still look finished, and would be the worst place
 * in the product for a decorative lie.
 *
 * The parity between this panel's stages and the server's full pipeline is
 * asserted separately, in `packages/core/test/landing-parity.test.ts`, for every
 * setting the slider offers. This suite checks that the panel is actually wired
 * to those stages and reachable by a visitor.
 */

const skip = !bundlePresent() ? 'apps/web/dist is not built' : false;

let harness: BrowserHarness | null = null;

async function shared(): Promise<BrowserHarness> {
  if (harness === null) harness = await createBrowserHarness();
  return harness;
}

/*
 * One hook for the whole file, rather than a per-test `after`.
 *
 * The harness holds a Chrome process and a listening socket. Registering the
 * close on individual tests meant the first test tore it down while the rest
 * still needed it, and whichever test held the last reference never closed it -
 * so the suite passed its assertions and then hung until the runner was killed.
 * A top-level hook closes whatever is open, whenever the file ends.
 */
test.after(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

type Board = Record<string, { averaged: number; normalized: number; mean: string }>;

/** Read the rendered table, so the assertion is about the engine's output. */
async function readBoard(page: Page): Promise<Board> {
  return page.evaluate(`(() => {
    const out = {};
    for (const row of document.querySelectorAll('.lab__table tbody tr')) {
      const project = row.getAttribute('data-project');
      const cells = row.querySelectorAll('td');
      if (project === null || cells.length < 3) continue;
      out[project] = {
        mean: (cells[0].textContent || '').trim(),
        averaged: Number((cells[1].textContent || '').trim()),
        normalized: Number((cells[2].textContent || '').trim()),
      };
    }
    return out;
  })()`) as Promise<Board>;
}

function orderOf(board: Board, key: 'averaged' | 'normalized'): string[] {
  return Object.entries(board)
    .sort((a, b) => a[1][key] - b[1][key])
    .map(([id]) => id);
}

/** The panel's project ids and display names, for matching a sentence to a row. */
const PROJECT_NAMES: Record<string, string> = {
  p_lattice: 'Lattice',
  p_beacon: 'Beacon',
  p_ferrite: 'Ferrite',
  p_quill: 'Quill',
};

async function setGenerosity(page: Page, value: number): Promise<void> {
  await page.locator('#lab-generosity').fill(String(value));
  // The range input fires `input` on fill, and React re-renders synchronously
  // after, but the assertion below reads the DOM, so wait for a real change
  // rather than racing the render.
  await page.waitForFunction(
    `document.querySelector('#lab-generosity-value')?.textContent?.includes('${value === 0 ? 'no bias' : `+${value} points`}')`,
    undefined,
    { timeout: 5_000 },
  );
}

test('the panel shows four projects and a labelled control', { skip, timeout: 300_000 }, async () => {
  const h = await shared();

  const context = await h.freshContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('.lab__table tbody tr');

  // The heading is real, and it is a level below the h1 with no level skipped.
  const heading = await page.locator('#lab-heading').textContent();
  assert.match(heading ?? '', /generous judge/i, 'the panel has no heading');

  // The control is a range input with an accessible name, which is what makes
  // it operable by keyboard and announced by a screen reader.
  const range = page.locator('#lab-generosity');
  assert.equal(await range.count(), 1, 'the generosity control is missing');
  assert.equal(await range.getAttribute('type'), 'range', 'the control is not a range input');
  assert.equal(await range.getAttribute('max'), '22', 'the control advertises an unexpected range');
  const label = await page.locator('label[for="lab-generosity"]').textContent();
  assert.match(label ?? '', /generosity|scores every project/i, 'the control has no readable label');

  const board = await readBoard(page);
  assert.equal(Object.keys(board).length, 4, `expected four projects, got ${JSON.stringify(Object.keys(board))}`);
  for (const [id, row] of Object.entries(board)) {
    assert.match(row.mean, /^\d+\.\d$/, `${id} has no mean score`);
    assert.ok(row.averaged >= 1 && row.averaged <= 4, `${id} has an out-of-range averaged rank`);
    assert.ok(row.normalized >= 1 && row.normalized <= 4, `${id} has an out-of-range normalized rank`);
  }

  await context.close();
});

test('moving one judge changes the averaged ranking and not the normalized one', { skip, timeout: 300_000 }, async () => {
  const h = await shared();

  const context = await h.freshContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('.lab__table tbody tr');

  await setGenerosity(page, 0);
  const calm = await readBoard(page);

  await setGenerosity(page, 22);
  const generous = await readBoard(page);

  // The averages themselves must move, or the control is disconnected.
  assert.notDeepEqual(
    Object.values(calm).map((row) => row.mean),
    Object.values(generous).map((row) => row.mean),
    'the generosity control did not change any project average',
  );

  // The claim.
  assert.notEqual(
    orderOf(calm, 'averaged').join('>'),
    orderOf(generous, 'averaged').join('>'),
    `the averaged ranking did not move. At +0: ${orderOf(calm, 'averaged').join(' > ')}. At +22: ${orderOf(generous, 'averaged').join(' > ')}`,
  );
  assert.equal(
    orderOf(calm, 'normalized').join('>'),
    orderOf(generous, 'normalized').join('>'),
    `the normalized ranking moved with generosity. At +0: ${orderOf(calm, 'normalized').join(' > ')}. At +22: ${orderOf(generous, 'normalized').join(' > ')}`,
  );

  // And the two orderings genuinely disagree somewhere in between, or the panel
  // is showing two identical columns and calling it a comparison.
  assert.notEqual(
    orderOf(generous, 'averaged').join('>'),
    orderOf(generous, 'normalized').join('>'),
    'at maximum generosity the two rankings agree, so the panel is comparing nothing',
  );

  await context.close();
});

test('the panel works from the keyboard alone', { skip, timeout: 300_000 }, async () => {
  const h = await shared();

  const context = await h.freshContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('.lab__table tbody tr');

  const before = await readBoard(page);

  // Focus the control the way a keyboard user reaches it, then drive it with
  // arrow keys - which is what a range input is for.
  await page.locator('#lab-generosity').focus();
  const focused = await page.evaluate("document.activeElement?.id");
  assert.equal(focused, 'lab-generosity', 'the range input could not take keyboard focus');

  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
  await page.waitForFunction("document.querySelector('#lab-generosity-value')?.textContent === '+14 points'", undefined, {
    timeout: 5_000,
  });

  const after = await readBoard(page);
  assert.notDeepEqual(
    Object.values(before).map((row) => row.mean),
    Object.values(after).map((row) => row.mean),
    'arrow keys did not change the panel',
  );

  // The focus ring is what makes the focused control findable. Checked on the
  // outline, because that is what the stylesheet actually sets.
  const outline = await page.evaluate<{ width: string; style: string } | null>(`(() => {
    const el = document.querySelector('#lab-generosity');
    if (el === null) return null;
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  })()`);
  assert.ok(outline !== null, 'the range input disappeared');
  assert.notEqual(outline.width, '0px', 'the focused control has no visible focus ring');

  await context.close();
});

test('no cell in the panel is clipped, at any width', { skip, timeout: 300_000 }, async () => {
  const h = await shared();

  /*
   * The general layout audit cannot catch this. It exempts anything inside a
   * horizontally scrollable container - correctly, because the score table is
   * twenty columns wide and meant to scroll - and the panel's table sits in one
   * of those wrappers. So a cell clipped by `table-layout: fixed` is invisible
   * to it, which is how "Rank: normalized" shipped rendering as
   * "RANK: NORMALI" on a 390px phone.
   *
   * This reads the cells back instead: a cell whose content is wider than the
   * cell itself has been cut off, whatever the CSS says about the wrapper.
   */
  for (const width of [390, 768, 1280, 1440]) {
    const context = await h.freshContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForSelector('.lab__table tbody tr');

    const clipped = await page.evaluate<{ text: string; over: number }[]>(`(() => {
      const problems = [];
      const cells = document.querySelectorAll('.lab__table th, .lab__table td');
      for (const cell of cells) {
        const over = cell.scrollWidth - cell.clientWidth;
        if (over > 1) problems.push({ text: (cell.textContent || '').trim().slice(0, 30), over });
      }
      return problems;
    })()`);

    assert.deepEqual(
      clipped.slice(0, 5),
      [],
      `the panel clips cells at ${String(width)}px:\n${clipped.slice(0, 5).map((c) => `  ${JSON.stringify(c.text)} overflows by ${String(c.over)}px`).join('\n')}`,
    );

    await context.close();
  }
});

test('the sentence under the panel quotes ranks the table actually shows', { skip, timeout: 300_000 }, async () => {
  const h = await shared();

  const context = await h.freshContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('.lab__table tbody tr');

  const sentence = async (): Promise<string> => (await page.locator('[data-finding]').textContent())?.trim() ?? '';

  /*
   * Checked at both ends of the slider, and against the rendered table rather
   * than a stored expectation. The valuable assertion is not the wording, it is
   * that the sentence's mean, its averaged rank and its normalized rank are the
   * three numbers in the row it names - a sentence that drifted from the data
   * would be the single most damaging thing on this page, because it is the part
   * a visitor would quote back at a losing team.
   */
  for (const value of [0, 22]) {
    await setGenerosity(page, value);
    const text = await sentence();
    const board = await readBoard(page);

    assert.match(
      text,
      /standardiz|normaliz/i,
      `at +${String(value)} the sentence does not say the two rankings differ by method: ${text}`,
    );

    const mean = text.match(/averages (\d+\.\d)/);
    const averagedRank = text.match(/(\d+)(?:st|nd|rd|th) of 4 on the raw/);
    const normalizedRank = text.match(/comes (\d+)(?:st|nd|rd|th) once every judge/);
    const named = Object.keys(board).find((id) => text.includes(PROJECT_NAMES[id] ?? ' '));

    assert.ok(mean !== null, `at +${String(value)} the sentence quotes no mean: ${text}`);
    assert.ok(averagedRank !== null, `at +${String(value)} the sentence quotes no averaged rank: ${text}`);
    assert.ok(normalizedRank !== null, `at +${String(value)} the sentence quotes no normalized rank: ${text}`);
    assert.ok(named !== undefined, `at +${String(value)} the sentence names no project in the table: ${text}`);

    const row = board[named];
    assert.ok(row !== undefined);
    assert.equal(row.mean, mean[1], `at +${String(value)} the sentence's mean is not the table's: ${text}`);
    assert.equal(row.averaged, Number(averagedRank[1]), `at +${String(value)} the sentence's averaged rank is not the table's: ${text}`);
    assert.equal(
      row.normalized,
      Number(normalizedRank[1]),
      `at +${String(value)} the sentence's normalized rank is not the table's: ${text}`,
    );
    assert.notEqual(
      row.averaged,
      row.normalized,
      `at +${String(value)} the sentence claims a move for a project that did not move`,
    );
  }

  await context.close();
});

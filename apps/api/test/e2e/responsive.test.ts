import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHarness, bundlePresent, VIEWPORTS, ACCOUNTS, type BrowserHarness, type Viewport } from '../browser.ts';
import type { Page } from 'playwright';

/**
 * Layout and accessibility at the sizes people actually use.
 *
 * The rest of the browser suite runs at 1440x900 because that is a convenient
 * default, which is exactly why a layout that only works at 1440 would pass it.
 * This suite drives the real bundle at four viewports and asserts the things
 * that break quietly when a stylesheet is written for one width:
 *
 *   - horizontal overflow, the most common responsive bug and the one a
 *     screenshot hides, because a full-page capture simply gets wider;
 *   - tap targets too small to hit with a thumb on a phone;
 *   - form controls with no accessible name, which a mouse user never notices
 *     and a screen reader user cannot use at all;
 *   - heading levels that skip, which breaks navigation by heading;
 *   - a missing `lang`, which leaves a screen reader guessing at pronunciation.
 *
 * In-page code is passed as a string rather than a function. The Node
 * typecheck deliberately omits the DOM library so that a stray `document` in
 * server code fails to compile, and the alternative - reaching the DOM through
 * `element.ownerDocument` - makes the measurement code unreadable. The strings
 * are small, and a typo surfaces as a loud failure rather than a passing test:
 * every check either throws in the page or comes back as a value the assertion
 * compares explicitly.
 */

const skip = !bundlePresent() ? 'apps/web/dist is not built' : false;

const PUBLIC_PAGES = [
  { name: 'landing', path: '/' },
  { name: 'events', path: '/events' },
  { name: 'event', path: '/e/dogfood-2026' },
  { name: 'gallery', path: '/e/dogfood-2026/gallery' },
  { name: 'results', path: '/e/dogfood-2026/results' },
  { name: 'sign-in', path: '/signin' },
];

let harness: BrowserHarness | null = null;

async function shared(): Promise<BrowserHarness> {
  if (harness === null) harness = await createBrowserHarness();
  return harness;
}

/** A readable path to an element, so a failure names something actionable. */
const PATH_HELPER = `
  function pathOf(el) {
    var parts = [];
    var node = el;
    for (var depth = 0; depth < 4 && node && node.tagName !== 'BODY'; depth += 1) {
      var part = node.tagName.toLowerCase();
      var id = node.getAttribute('id');
      if (id) part += '#' + id;
      var cls = node.getAttribute('class');
      if (cls) part += '.' + cls.trim().split(/\\s+/).slice(0, 2).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
`;

/** Wait for the app to have rendered something other than a spinner. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction("document.querySelector('#root') && document.querySelector('#root').children.length > 0", undefined, {
    timeout: 20_000,
  });
  await page
    .waitForFunction("!document.body.innerText.includes('Loading')", undefined, { timeout: 20_000 })
    .catch(() => undefined);
  // One frame for layout, then the webfonts, so measurements are of the final
  // layout rather than of a fallback font.
  await page.evaluate("document.fonts.ready.then(function () { return new Promise(function (r) { requestAnimationFrame(function () { r(null); }); }); })");
}

type Offender = { path: string; right: number; text: string };

/**
 * Elements sticking out past the right edge.
 *
 * Anything inside a horizontally scrollable container is skipped. The score
 * table is twenty columns wide and is meant to scroll sideways, and failing it
 * would only teach everyone to ignore this check.
 */
const OVERFLOW_PROBE = `
  (function () {
    ${PATH_HELPER}
    var limit = document.documentElement.clientWidth;
    var found = [];
    function inScroller(node) {
      var parent = node.parentElement;
      while (parent && parent !== document.body) {
        var overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
        parent = parent.parentElement;
      }
      return false;
    }
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
      var box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right <= limit + 1) continue;
      if (inScroller(el)) continue;
      found.push({ path: pathOf(el), right: Math.round(box.right), text: (el.textContent || '').trim().slice(0, 40) });
    }
    return found;
  })()
`;

type Heading = { level: number; text: string };

const HEADING_PROBE = `
  (function () {
    var out = [];
    var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < all.length; i += 1) {
      out.push({ level: Number(all[i].tagName.slice(1)), text: (all[i].textContent || '').trim().slice(0, 40) });
    }
    return out;
  })()
`;

type Unnamed = { path: string };

/**
 * Controls a screen reader would announce as "button" with no name.
 *
 * The name may come from an `aria-label`, an `aria-labelledby` reference, a
 * real `<label>`, a placeholder, or the control's own text.
 */
const UNNAMED_PROBE = `
  (function () {
    function describe(el) {
      var aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria;
      var labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var text = labelledBy.split(/\\s+/).map(function (id) {
          var target = document.getElementById(id);
          return target ? target.textContent : '';
        }).join(' ').trim();
        if (text) return text;
      }
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (el.labels && el.labels.length > 0) {
          var joined = Array.prototype.map.call(el.labels, function (l) { return l.textContent || ''; }).join(' ');
          if (joined.trim()) return joined;
        }
        var placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return placeholder;
        var title = el.getAttribute('title');
        if (title && title.trim()) return title;
      }
      return (el.textContent || '').trim();
    }
    var problems = [];
    var controls = document.querySelectorAll('input, select, textarea, button, a[href], [role="button"], [role="tab"]');
    for (var i = 0; i < controls.length; i += 1) {
      var el = controls[i];
      var tag = el.tagName;
      if (tag === 'INPUT') {
        var type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;
      }
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (describe(el) === '') problems.push({ path: tag.toLowerCase() + (el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '') });
    }
    return problems;
  })()
`;

type Small = { path: string; width: number; height: number };

/**
 * Targets under 40px tall on a 390px phone.
 *
 * 44px is the WCAG 2.5.5 target-size floor and 24px the 2.5.8 minimum. 40px is
 * asserted because it is what a thumb reliably hits, and because anything grown
 * to 40px has usually cleared 24px as well. Links inside a paragraph are prose
 * rather than targets, and 2.5.8 exempts them.
 */
const SMALL_TARGET_PROBE = `
  (function () {
    var problems = [];
    var targets = document.querySelectorAll('button, a.button, [role="button"], [role="tab"], input[type="checkbox"], input[type="radio"], input[type="submit"]');
    for (var i = 0; i < targets.length; i += 1) {
      var el = targets[i];
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.tagName === 'A' && el.closest('p, li') && (el.getAttribute('class') || '').indexOf('button') === -1) continue;
      var box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.height >= 40) continue;
      problems.push({ path: el.tagName.toLowerCase() + (el.getAttribute('class') ? '.' + el.getAttribute('class').trim().split(/\\s+/)[0] : ''), width: Math.round(box.width), height: Math.round(box.height) });
    }
    return problems;
  })()
`;

async function auditLayout(page: Page, label: string, viewport: Viewport): Promise<void> {
  await settled(page);

  const sideways = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  assert.ok(
    sideways <= 1,
    `${label} at ${String(viewport.width)}x${String(viewport.height)} scrolls sideways by ${String(sideways)}px`,
  );

  const offenders = (await page.evaluate<Offender[]>(OVERFLOW_PROBE)).slice(0, 4);
  assert.deepEqual(
    offenders,
    [],
    `${label} at ${String(viewport.width)}x${String(viewport.height)} has elements past the ${String(viewport.width)}px right edge:\n${offenders
      .map((o) => `  ${o.path} right=${String(o.right)} ${JSON.stringify(o.text)}`)
      .join('\n')}`,
  );

  const headings = await page.evaluate<Heading[]>(HEADING_PROBE);
  const h1s = headings.filter((heading) => heading.level === 1);
  assert.ok(
    h1s.length <= 1,
    `${label} has ${String(h1s.length)} h1 headings: ${h1s.map((heading) => heading.text).join(' | ')}`,
  );
  for (let i = 1; i < headings.length; i += 1) {
    const previous = headings[i - 1];
    const current = headings[i];
    if (previous !== undefined && current !== undefined && current.level > previous.level + 1) {
      assert.fail(
        `${label} skips a heading level: h${String(previous.level)} "${previous.text}" then h${String(current.level)} "${current.text}"`,
      );
    }
  }

  const lang = await page.evaluate<string | null>("document.documentElement.getAttribute('lang')");
  assert.ok(lang !== null && lang.trim() !== '', `${label} has no lang on <html>`);
}

test('no page scrolls sideways at any viewport', { skip, timeout: 900_000 }, async (t) => {
  const h = await shared();
  t.after(async () => {
    await h.close();
    harness = null;
  });

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const target of PUBLIC_PAGES) {
      const context = await h.freshContext({ viewport });
      const page = await context.newPage();
      await page.goto(target.path);
      await auditLayout(page, `${target.name} (signed out)`, viewport);
      await h.shot(page, `responsive-${name}-${target.name}`);
      await context.close();
    }
  }
});

test('signed-in surfaces hold up at every viewport', { skip, timeout: 900_000 }, async () => {
  const h = await shared();

  // The review page needs a real assignment id from the demo data. Read from
  // the database when this harness owns it; otherwise from the API, which is
  // the only route to the same fact that does not cross a volume boundary.
  let assignmentId: string | null = null;
  if (h.db !== null) {
    const assignment = h.db.get<{ id: string }>(
      `SELECT a.id FROM judge_assignments a
        WHERE a.event_id = :e AND a.status <> 'REASSIGNED'
        ORDER BY a.id LIMIT 1`,
      { e: h.eventId },
    );
    assignmentId = assignment?.id ?? null;
  } else {
    /*
     * Ask as the organizer.
     *
     * Two things make this less obvious than it looks. The assignments list is
     * `assignment:read` inside an organized event, so an anonymous caller gets
     * 401 - a silent null here reads as "the demo has no assignment", pointing
     * at the wrong thing. And the judge's pairwise queue is no substitute: it
     * returns *submission* ids, while the review route is addressed by
     * *assignment* id.
     */
    const asOrganizer = await h.signedIn(ACCOUNTS.organizer);
    const queued = await asOrganizer.request.get(`${h.base}/api/events/${h.eventId}/assignments?perPage=1`);
    if (queued.ok()) {
      const body = (await queued.json()) as { data?: { id: string }[] };
      assignmentId = body.data?.[0]?.id ?? null;
    }
    await asOrganizer.context().close();
  }
  assert.ok(assignmentId !== null, 'the demo has an assignment to review');

  const surfaces: { name: string; path: string; email: string }[] = [
    { name: 'workspace', path: '/workspace', email: ACCOUNTS.participant },
    { name: 'organizer-console', path: '/organize', email: ACCOUNTS.organizer },
    { name: 'judge-queue', path: '/judge', email: ACCOUNTS.generousJudge },
    { name: 'judge-review', path: `/judge/${assignmentId}`, email: ACCOUNTS.generousJudge },
  ];

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const surface of surfaces) {
      const page = await h.signedIn(surface.email, { viewport });
      await page.goto(surface.path);
      await auditLayout(page, `${surface.name} (${surface.email})`, viewport);
      await h.shot(page, `responsive-${name}-${surface.name}`);
      await page.context().close();
    }
  }
});

test('every control has an accessible name', { skip, timeout: 900_000 }, async (t) => {
  const h = await shared();
  t.after(async () => {
    await h.close();
    harness = null;
  });

  const check = async (page: Page, label: string): Promise<void> => {
    await settled(page);
    const unnamed = (await page.evaluate<Unnamed[]>(UNNAMED_PROBE)).slice(0, 6);
    assert.deepEqual(
      unnamed,
      [],
      `${label} has ${String(unnamed.length)} control(s) a screen reader would announce without a name:\n${unnamed
        .map((u) => `  ${u.path}`)
        .join('\n')}`,
    );
  };

  for (const target of PUBLIC_PAGES) {
    const context = await h.freshContext({ viewport: VIEWPORTS.mobile });
    const page = await context.newPage();
    await page.goto(target.path);
    await check(page, `${target.name} (signed out)`);
    await context.close();
  }

  // The dense screens, where a nameless control is most likely to hide.
  const signedInPages: { name: string; path: string; email: string }[] = [
    { name: 'organizer-console', path: '/organize', email: ACCOUNTS.organizer },
    { name: 'judge-queue', path: '/judge', email: ACCOUNTS.generousJudge },
    { name: 'workspace', path: '/workspace', email: ACCOUNTS.participant },
  ];
  for (const target of signedInPages) {
    const page = await h.signedIn(target.email, { viewport: VIEWPORTS.mobile });
    await page.goto(target.path);
    await check(page, `${target.name} (${target.email})`);
    await page.context().close();
  }
});

test('buttons are big enough to hit on a phone', { skip, timeout: 900_000 }, async (t) => {
  const h = await shared();
  t.after(async () => {
    await h.close();
    harness = null;
  });

  const pages: { name: string; path: string; email?: string }[] = [
    { name: 'landing', path: '/' },
    { name: 'events', path: '/events' },
    { name: 'gallery', path: '/e/dogfood-2026/gallery' },
    { name: 'event', path: '/e/dogfood-2026' },
    { name: 'organizer-console', path: '/organize', email: ACCOUNTS.organizer },
    { name: 'judge-queue', path: '/judge', email: ACCOUNTS.generousJudge },
    { name: 'workspace', path: '/workspace', email: ACCOUNTS.participant },
  ];

  for (const target of pages) {
    let page: Page;
    if (target.email === undefined) {
      const context = await h.freshContext({ viewport: VIEWPORTS.mobile });
      page = await context.newPage();
    } else {
      page = await h.signedIn(target.email, { viewport: VIEWPORTS.mobile });
    }
    await page.goto(target.path);
    await settled(page);
    const small = (await page.evaluate<Small[]>(SMALL_TARGET_PROBE)).slice(0, 6);
    assert.deepEqual(
      small,
      [],
      `${target.name} on a 390px phone has ${String(small.length)} target(s) under 40px tall:\n${small
        .map((s) => `  ${s.path} ${String(s.width)}x${String(s.height)}`)
        .join('\n')}`,
    );
    await page.context().close();
  }
});

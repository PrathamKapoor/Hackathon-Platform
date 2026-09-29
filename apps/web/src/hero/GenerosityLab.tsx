import { useMemo, useState, type ChangeEvent } from 'react';
import {
  LAB_ADJUSTABLE_JUDGE,
  LAB_JUDGES,
  LAB_MAX_GENEROSITY,
  labRows,
  type LabRow,
} from './lab.ts';

/**
 * The landing page's interactive argument.
 *
 * The page opens by claiming that one generous judge can move three places,
 * which is a claim, and claims are cheap. So this lets a visitor do it: move
 * one judge's generosity and watch the two orderings disagree.
 *
 * The two rank columns are the whole point. "Averaged" is what a hackathon
 * normally does - average the numbers, sort, publish. "Normalized" is what this
 * product does instead - standardize each judge against their own habit before
 * aggregating. Every figure comes from `computeResultRun` in `lab.ts`, so the
 * disagreement on screen is the engine's and not an animation timed to look
 * convincing.
 *
 * The normalized *scores* are deliberately not shown. Under z-score
 * normalization they are not on the same scale as a raw mean, and printing 1.3
 * next to 79.5 would present two different things as one comparison. The ranks
 * are the claim, and ranks are unambiguous.
 *
 * Coverage is deliberately uneven - three of the four projects are covered by
 * the adjustable judge and one is not. A uniform panel could not demonstrate
 * anything, because a constant added to one judge's scores for every project
 * shifts every mean equally and the ranking cannot move. The panel that is
 * short of a review is exactly the panel that suffers, which is the real failure
 * this is about.
 */
export function GenerosityLab() {
  const [generosity, setGenerosity] = useState(6);
  const rows = useMemo(() => labRows(generosity), [generosity]);
  const adjustable = LAB_JUDGES.find((judge) => judge.id === LAB_ADJUSTABLE_JUDGE);

  const onSlide = (event: ChangeEvent<HTMLInputElement>): void => {
    setGenerosity(Number(event.target.value));
  };

  return (
    <section className="lab" aria-labelledby="lab-heading">
      <h2 className="lab__title" id="lab-heading">
        One generous judge, four projects, and two rankings that disagree
      </h2>
      <p className="lab__sub">
        Four judges, three reviews each, unevenly assigned. Drag{adjustable === undefined ? ' the judge' : ` ${adjustable.name}`}
        &rsquo;s generosity up: the averaged ranking moves, the normalized one barely does. Both columns are computed by the
        same engine the API calls, here in your browser, from the reviews below.
      </p>

      <div className="lab__control">
        <label className="lab__label" htmlFor="lab-generosity">
          {adjustable === undefined ? 'Judge generosity' : `${adjustable.name}'s generosity`}
          <span className="lab__label-note">
            points added to every project they scored
          </span>
        </label>
        <input
          id="lab-generosity"
          className="lab__range"
          type="range"
          min={0}
          max={LAB_MAX_GENEROSITY}
          step={1}
          value={generosity}
          onChange={onSlide}
          aria-describedby="lab-generosity-value"
        />
        <span className="lab__value" id="lab-generosity-value">
          {generosity === 0 ? 'no bias' : `+${String(generosity)} points`}
        </span>
      </div>

      <div className="table-wrap lab__table-wrap">
        <table className="data lab__table">
          <caption className="lab__caption">
            Ranked by the normalized result, which does not change. The averaged column is what a
            published leaderboard would have said.
          </caption>
          <thead>
            {/*
              The classes here have to mirror the body row's exactly, including
              `lab__num--mean`. `table-layout: fixed` takes the column widths from
              the first row, so a header cell that is not hidden when its body
              cell is leaves the table with a column the body has no cell for -
              which is how the project column ended up 1% wide and every name
              overflowed by 60px.
            */}
            <tr>
              <th scope="col" className="lab__project">Project</th>
              <th scope="col" className="lab__num lab__num--mean">Avg score</th>
              <th scope="col" className="lab__num">
                <span className="lab__th-prefix">Rank: </span>averaged
              </th>
              <th scope="col" className="lab__num">
                <span className="lab__th-prefix">Rank: </span>normalized
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.project.id} data-project={row.project.id}>
                <th scope="row" className="lab__project">
                  {row.project.name}
                  {/*
                    The mean is rendered twice and only one is ever displayed.
                    On a 390px phone the two rank headers - "averaged" and
                    "normalized" - need the room that the score column was taking,
                    and `table-layout: fixed` breaks a long word rather than
                    letting it overflow, so a third numeric column meant
                    "NORMAL IZED" and "AVERAGE D". Folding the mean under the
                    project name on narrow screens fixes it without abbreviating
                    the two words that carry the comparison. The hidden copy is
                    `display: none`, so it is out of the accessibility tree too
                    and nothing is announced twice.
                  */}
                  <span className="lab__mean-inline">{row.rawMean.toFixed(1)}</span>
                </th>
                <td className="lab__num lab__num--mean">{row.rawMean.toFixed(1)}</td>
                <td className="lab__num">
                  <span className="lab__rank">{String(row.rawRank)}</span>
                </td>
                <td className="lab__num">
                  <span className="lab__rank lab__rank--final">{String(row.normalizedRank)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="lab__finding" data-finding>
        {finding(rows)}
      </p>
    </section>
  );
}

/**
 * Name the biggest disagreement, from the rows themselves.
 *
 * A sentence written per state would rot the moment the data changed, and
 * quietly claiming a disagreement the numbers no longer show would be the exact
 * kind of decoration this product exists to argue against. So this reads the rows
 * and says what they say.
 *
 * The disagreement is present at every setting, not only at the generous end,
 * and that is worth being straight about. The four projects are covered
 * unevenly, and the one project the harsh judge never saw already carries a
 * flattering average before anyone moves the slider: generosity widens a gap
 * that is there to begin with. A panel that agreed at zero would look tidier and
 * would be hiding the more interesting fact, which is that a short review list is
 * itself a way to flatter a project.
 */
function finding(rows: LabRow[]): string {
  let worst: LabRow | undefined;
  let gap = 0;
  for (const row of rows) {
    const movement = Math.abs(row.rawRank - row.normalizedRank);
    if (movement > gap) {
      gap = movement;
      worst = row;
    }
  }
  if (worst === undefined) return '';

  if (gap === 0) {
    return 'Averaged and normalized agree at this setting, so there is nothing here for the panel to show you.';
  }

  const plural = gap === 1 ? 'place' : 'places';
  const towards = worst.normalizedRank > worst.rawRank ? 'down' : 'up';
  return (
    `${worst.project.name} averages ${worst.rawMean.toFixed(1)} — ${ordinal(worst.rawRank)} of ${String(rows.length)} on the raw ` +
    `scores — and comes ${ordinal(worst.normalizedRank)} once every judge is standardized against their own habit. ` +
    `A move of ${String(gap)} ${plural} ${towards}, decided by ${String(rows.length - 1)} of the ${String(rows.length)} judges, ` +
    `because the fourth never scored it.`
  );
}

function ordinal(value: number): string {
  const teens = value % 100 >= 11 && value % 100 <= 13;
  const suffix = teens ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');
  return `${String(value)}${suffix}`;
}

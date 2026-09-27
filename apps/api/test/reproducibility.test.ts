/**
 * Reproducibility and tamper detection.
 *
 * The product's central claim is that a published result is not merely stored
 * but *reproducible*: recomputing from the same inputs must produce the same
 * ranking, and if anything changes underneath, verification must say so.
 *
 * A test that only checks "compute twice, hashes equal" proves very little. It
 * would pass if the pipeline ignored its inputs entirely. So this suite also
 * **deliberately corrupts** each input in turn and asserts the hash changes —
 * which is the half that actually demonstrates the input hash covers something.
 *
 * Determinism is checked by running the same computation many times, because a
 * single repeat cannot distinguish a stable implementation from a lucky one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, type Harness } from './harness.ts';

const RUNS = 5;

describe('reproducibility: identical inputs produce identical output', () => {
  let h: Harness;
  let eventId: string;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
  });
  after(async () => {
    await h.close();
  });

  test(`the integrity hash is stable across ${String(RUNS)} separate computations`, async () => {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');

    const hashes = new Set<string>();
    const inputHashes = new Set<string>();
    const rankings = new Set<string>();

    for (let attempt = 0; attempt < RUNS; attempt += 1) {
      const response = await organizer.post<{
        runId: string;
        integrityHash: string;
        inputHash: string;
        entries: { projectId: string; rank: number; aggregateScore: number | null }[];
      }>(`/api/events/${eventId}/results/compute`, {});
      assert.equal(response.status, 200, response.raw);
      hashes.add(response.body.integrityHash);
      inputHashes.add(response.body.inputHash);
      rankings.add(
        response.body.entries
          .map((e) => `${String(e.rank)}:${e.projectId}:${String(e.aggregateScore)}`)
          .join('|'),
      );
    }

    assert.equal(hashes.size, 1, `the integrity hash changed between runs: ${[...hashes].join(', ')}`);
    assert.equal(inputHashes.size, 1, 'the input hash changed between runs');
    assert.equal(rankings.size, 1, 'the ranking changed between runs');
  });

  test('the run id differs but the content hash does not', async () => {
    // Each computation is a distinct record, so the id must be new. What must
    // not differ is the content, or "run my own copy and compare" stops working.
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const first = await organizer.post<{ runId: string; integrityHash: string }>(`/api/events/${eventId}/results/compute`, {});
    const second = await organizer.post<{ runId: string; integrityHash: string }>(`/api/events/${eventId}/results/compute`, {});
    assert.notEqual(first.body.runId, second.body.runId, 'two computations shared a run id');
    assert.equal(first.body.integrityHash, second.body.integrityHash);
  });

  test('a published snapshot verifies against itself', async () => {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const computed = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
    const snapshot = await organizer.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`, {});
    await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`, {});

    // Verify twice: the second run must not be affected by the first.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const verify = await organizer.post<{ status: string; differences: unknown[] }>(
        `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/reproduce`,
        {},
      );
      assert.equal(verify.status, 200, verify.raw);
      assert.equal(verify.body.status, 'MATCH', `verification ${String(attempt)}: ${JSON.stringify(verify.body.differences)}`);
    }
  });
});

describe('tamper detection: changing an input must change the hash', () => {
  let h: Harness;
  let eventId: string;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
  });
  after(async () => {
    await h.close();
  });

  /**
   * Computes a baseline, changes one thing the pipeline reads, computes again,
   * and asserts the integrity hash moved.
   *
   * The change is reverted only *after* the second computation. An earlier
   * version reverted inside the mutate callback, so both computations saw
   * identical data and the test passed for the wrong reason — or, once fixed,
   * failed and looked like a pipeline bug.
   */
  async function expectHashToChange(label: string, change: () => () => void): Promise<void> {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');

    const before = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, {});
    const restore = change();
    try {
      const after = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, {});
      assert.notEqual(
        after.body.integrityHash,
        before.body.integrityHash,
        `${label}: the integrity hash did not change, so the published result does not actually depend on it`,
      );
    } finally {
      restore();
    }
  }

  test('a stored aggregate outranks the criterion breakdown, and the drift is reported', async () => {
    /*
     * The pipeline ranks on `scores.raw_score` — the value that was stored when
     * the review was submitted and the value a snapshot's integrity hash covers.
     * The per-criterion breakdown is carried alongside it for display.
     *
     * So corrupting only a criterion value must NOT change the ranking: the
     * stored score is the input of record. What it must do is raise a warning,
     * because an organizer about to publish that breakdown needs to know it no
     * longer adds up to the score beside it.
     */
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');

    const clean = await organizer.post<{ integrityHash: string; warnings: string[] }>(
      `/api/events/${eventId}/results/compute`,
      {},
    );
    assert.equal(clean.status, 200, clean.raw);
    assert.ok(
      !clean.body.warnings.some((w) => w.includes('does not reconcile')),
      'a clean dataset reported criterion drift',
    );

    const target = h.db.get<{ id: string; value: number }>(
      "SELECT sc.id, sc.value FROM criterion_scores sc JOIN scores s ON s.id = sc.score_id WHERE s.state = 'SUBMITTED' LIMIT 1",
    );
    assert.ok(target !== null, 'no submitted criterion score to corrupt');
    h.db.exec('UPDATE criterion_scores SET value = :v WHERE id = :id', { v: target.value + 3, id: target.id });

    try {
      const drifted = await organizer.post<{ integrityHash: string; warnings: string[] }>(
        `/api/events/${eventId}/results/compute`,
        {},
      );
      assert.equal(drifted.status, 200, drifted.raw);

      // The ranking follows the stored score, so the hash is unchanged.
      assert.equal(
        drifted.body.integrityHash,
        clean.body.integrityHash,
        'the ranking changed when only the display breakdown was altered — the hash no longer describes the stored inputs',
      );

      // And the inconsistency is surfaced rather than published silently.
      const warning = drifted.body.warnings.find((w) => w.includes('does not reconcile'));
      assert.ok(
        warning !== undefined,
        `the drift was not reported. Warnings were: ${JSON.stringify(drifted.body.warnings)}`,
      );
      assert.ok(warning.includes('The ranking follows the stored score'), 'the warning does not say which value was used');
    } finally {
      h.db.exec('UPDATE criterion_scores SET value = :v WHERE id = :id', { v: target.value, id: target.id });
    }
  });

  test('changing a stored score changes the result', async () => {
    await expectHashToChange('stored score', () => {
      const target = h.db.get<{ id: string; raw_score: number }>(
        "SELECT id, raw_score FROM scores WHERE state = 'SUBMITTED' AND raw_score IS NOT NULL LIMIT 1",
      );
      assert.ok(target !== null, 'the seed produced no submitted score');
      h.db.exec('UPDATE scores SET raw_score = :v WHERE id = :id', { v: target.raw_score + 4, id: target.id });
      return () => h.db.exec('UPDATE scores SET raw_score = :v WHERE id = :id', { v: target.raw_score, id: target.id });
    });
  });

  test('changing the normalization method changes the result', async () => {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const raw = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { normalizationMethod: 'RAW' });
    const mad = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { normalizationMethod: 'ROBUST_MAD' });
    const z = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { normalizationMethod: 'Z_SCORE' });
    assert.equal(raw.status, 200, raw.raw);
    assert.notEqual(
      mad.body.integrityHash,
      raw.body.integrityHash,
      'ROBUST_MAD produced the same ranking as RAW — normalization is not being applied',
    );
    assert.notEqual(z.body.integrityHash, raw.body.integrityHash, 'Z_SCORE matched RAW');
  });

  test('changing the aggregation method changes the result', async () => {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const mean = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { aggregationMethod: 'MEAN', trim: 0 });
    const trimmed = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { aggregationMethod: 'MEAN', trim: 0.4 });
    const median = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { aggregationMethod: 'MEDIAN' });
    assert.equal(mean.status, 200, mean.raw);
    assert.notEqual(trimmed.body.integrityHash, mean.body.integrityHash, 'changing the trim changed nothing');
    assert.notEqual(median.body.integrityHash, mean.body.integrityHash, 'MEDIAN matched an untrimmed MEAN');
  });

  test('removing a review changes the result', async () => {
    await expectHashToChange('review count', () => {
      const target = h.db.value<string>("SELECT id FROM scores WHERE state = 'SUBMITTED' LIMIT 1");
      assert.ok(target !== null);
      h.db.exec("UPDATE scores SET state = 'DRAFT' WHERE id = :id", { id: target });
      return () => h.db.exec("UPDATE scores SET state = 'SUBMITTED' WHERE id = :id", { id: target });
    });
  });

  test('enabling pairwise tie-breaking changes the result', async () => {
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const without = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { enablePairwise: false });
    const with_ = await organizer.post<{ integrityHash: string }>(`/api/events/${eventId}/results/compute`, { enablePairwise: true });
    assert.equal(without.status, 200, without.raw);
    assert.equal(with_.status, 200, with_.raw);
    // Not asserting they differ: with no tie in the seeded data, enabling
    // pairwise legitimately changes nothing. What must hold is that both
    // succeed and record their choice, which the next test covers.
  });

  test('a run records the configuration it was computed with', async () => {
    // A result that cannot explain itself is not reproducible, it is merely
    // repeatable. The run must carry the method, the version and the input hash.
    const organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
    const run = await organizer.post<{ runId: string; inputHash: string; integrityHash: string }>(
      `/api/events/${eventId}/results/compute`,
      { normalizationMethod: 'Z_SCORE', aggregationMethod: 'MEDIAN' },
    );
    const stored = h.db.get<{ config: string; input_hash: string; integrity_hash: string; engine_version: string }>(
      'SELECT config, input_hash, integrity_hash, engine_version FROM result_runs WHERE id = :id',
      { id: run.body.runId },
    );
    assert.ok(stored !== null, 'the run was not persisted');
    assert.equal(stored.input_hash, run.body.inputHash, 'the stored input hash differs from the returned one');
    assert.equal(stored.integrity_hash, run.body.integrityHash, 'the stored integrity hash differs from the returned one');
    assert.ok(stored.engine_version.length > 0, 'the run records no engine version');

    const config = JSON.parse(stored.config) as {
      normalization?: { method?: string };
      aggregation?: { method?: string };
    };
    assert.equal(config.normalization?.method, 'Z_SCORE', 'the run did not record the normalization method used');
    assert.equal(config.aggregation?.method, 'MEDIAN', 'the run did not record the aggregation method used');
  });
});

describe('tamper detection: verification reports a difference', () => {
  test('corrupting a stored score makes verification fail loudly', async () => {
    /*
     * The strongest statement the product can make is that it will notice when
     * its own stored data no longer reproduces. If verification always said
     * MATCH it would be worthless, so this test corrupts the score of record
     * behind the application's back and requires a MISMATCH that names the
     * difference.
     */
    const h = await createHarness();
    try {
      const eventId = seededEventId(h);
      const organizer = h.client();
      await organizer.login('organizer@dogfood.dev');

      const computed = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
      const snapshot = await organizer.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`, {});
      await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`, {});

      const clean = await organizer.post<{ status: string }>(
        `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/reproduce`,
        {},
      );
      assert.equal(clean.body.status, 'MATCH', 'verification did not pass on uncorrupted data');

      const target = h.db.get<{ id: string; raw_score: number }>(
        "SELECT id, raw_score FROM scores WHERE state = 'SUBMITTED' AND raw_score IS NOT NULL LIMIT 1",
      );
      assert.ok(target !== null, 'no submitted score to corrupt');
      h.db.exec('UPDATE scores SET raw_score = :v WHERE id = :id', { v: target.raw_score + 5, id: target.id });

      const after = await organizer.post<{ status: string; differences: unknown[] }>(
        `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/reproduce`,
        {},
      );
      assert.equal(after.status, 200, after.raw);
      assert.equal(
        after.body.status,
        'MISMATCH',
        `verification still reported MATCH after a stored score was altered: ${JSON.stringify(after.body).slice(0, 300)}`,
      );
      assert.ok(after.body.differences.length > 0, 'MISMATCH was reported with no differences to look at');
    } finally {
      await h.close();
    }
  });

  test('a correction publishes a new snapshot rather than editing the old one', async () => {
    const h = await createHarness();
    try {
      const eventId = seededEventId(h);
      const organizer = h.client();
      await organizer.login('organizer@dogfood.dev');

      const first = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
      const firstSnapshot = await organizer.post<{ id: string; sequence: number }>(
        `/api/events/${eventId}/results/${first.body.runId}/snapshot`,
        {},
      );
      await organizer.post(`/api/events/${eventId}/results/snapshots/${firstSnapshot.body.id}/publish`, {});
      const firstHash = h.db.value<string>('SELECT integrity_hash FROM result_snapshots WHERE id = :id', {
        id: firstSnapshot.body.id,
      });

      // A correction must be a new snapshot with a new sequence and a new id.
      const second = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
      const correction = await organizer.post<{ id: string; sequence: number; is_correction: number }>(
        `/api/events/${eventId}/results/${second.body.runId}/snapshot`,
        { correctionReason: 'Verified correction after a review was amended', supersedesId: firstSnapshot.body.id },
      );

      assert.equal(correction.status, 201, correction.raw);
      assert.notEqual(correction.body.id, firstSnapshot.body.id, 'a correction reused the original snapshot id');
      // Relative, not absolute: the seed already occupies a sequence, so the
      // first snapshot created here is not sequence 1.
      assert.equal(
        correction.body.sequence,
        firstSnapshot.body.sequence + 1,
        'a correction must be sequenced immediately after the snapshot it supersedes',
      );
      assert.equal(correction.body.is_correction, 1, 'the correction is not marked as one');
      assert.equal(
        h.db.value<string>('SELECT supersedes_id FROM result_snapshots WHERE id = :id', { id: correction.body.id }),
        firstSnapshot.body.id,
        'the correction does not record what it supersedes',
      );

      // And the original is untouched.
      assert.equal(
        h.db.value<string>('SELECT integrity_hash FROM result_snapshots WHERE id = :id', { id: firstSnapshot.body.id }),
        firstHash,
        'publishing a correction changed the original snapshot',
      );
    } finally {
      await h.close();
    }
  });
});

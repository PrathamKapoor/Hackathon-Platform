/**
 * The demo dataset.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * An evaluator should be able to start the platform and immediately understand
 * the product: open a seeded event, see a real project gallery, look at a
 * judging panel with a real assignment, inspect a normalization comparison that
 * actually changes an ordering, and read a published result with a verifiable
 * integrity hash.
 *
 * So the data is built to tell one coherent story rather than to fill tables.
 *
 * ---------------------------------------------------------------------------
 * THE STORY
 * ---------------------------------------------------------------------------
 * "Dogfood 2026" is a 36-hour hackathon run by Hackathon Raptors. Twelve teams
 * built real-looking projects across two tracks. Five judges with genuinely
 * different scoring personalities reviewed them:
 *
 *   - Dr. Amara Nwosu   consistently generous (+10 points across the board)
 *   - Ben Castellanos  harsh (-8), but very discriminating between projects
 *   - Dr. Priya Raman  precise, tight spread, low variance
 *   - Tomas Lindqvist  broad spread; a specialist who rewards bold attempts
 *   - Yuki Tanaka      left two reviews unfinished, which the coverage report
 *                      must surface rather than hide
 *
 * The consequences are designed to be visible:
 *   - Raw scoring ranks one project first. ROBUST_MAD normalization moves a
 *     different project to first, because the difference is driven by one
 *     judge's generosity. That is the normalization proof.
 *   - Priya's very low variance raises a LOW_VARIANCE review flag — which is
 *     explicitly a *diagnostic*, not an accusation.
 *   - Yuki's two incomplete assignments show up in the coverage table and block
 *     a clean move out of JUDGING without an override.
 *   - One project has a hard conflict: Amara is its mentor, so she is excluded
 *     from it by the assignment engine, and the preview reports the exclusion.
 *   - A unanimous pairwise comparison set and one non-transitive triple give
 *     Bradley-Terry something real to fit.
 *
 * No placeholder text: every project name, description and person is written as
 * a real thing would be.
 */

import { evaluateReview, type RubricVersion } from '@verdict/core/rubric';
import { canonicalJson, sha256Hex } from '@verdict/core/integrity';
import { configForMethod } from '@verdict/core/normalization';
import { DEFAULT_AGGREGATION_CONFIG } from '@verdict/core/aggregation';
import { generateAssignmentPreview, type ConflictDeclaration } from '@verdict/core/assignment';
import { newId } from '@verdict/core/ids';
import { addSeconds, toInstant } from '@verdict/core/time';
import { hashPassword } from '../lib/password.ts';
import type { Database } from '../db/database.ts';
import type { AppConfig } from '../config.ts';
import { createServices } from '../services/context.ts';
import { actorContext } from '../services/context.ts';
import { createLogger } from '../lib/logger.ts';

export type SeedSummary = {
  users: number;
  teams: number;
  submissions: number;
  judges: number;
  reviews: number;
  votes: number;
  /** Anomaly signals the diagnostics engine raised while building the data. */
  signals: number;
  snapshots: number;
  certificates: number;
  credentials: { role: string; email: string; password: string }[];
};

export const DEMO_PASSWORD = 'verdict-demo-2026';

/** One canonical clock for the whole seed, so the data is internally consistent. */
const T0 = Date.UTC(2026, 1, 1, 9, 0, 0); // 1 Feb 2026, registration opens
const at = (offsetHours: number): string => toInstant(T0 + offsetHours * 3_600_000);

export function needsSeed(db: Database): boolean {
  return (db.value<number>('SELECT COUNT(*) AS c FROM users') ?? 0) === 0;
}

/* ------------------------------------------------------------- the data */

type PersonSpec = {
  key: string;
  email: string;
  name: string;
  organization: string;
  bio: string;
  skills: string[];
  roles: ('PARTICIPANT' | 'JUDGE' | 'ORGANIZER' | 'ADMIN')[];
  color: string;
};

const PEOPLE: PersonSpec[] = [
  // --- platform
  { key: 'admin', email: 'admin@hackathonraptors.dev', name: 'Rhea Vasquez', organization: 'Hackathon Raptors', bio: 'Platform operations. Keeps the lights on and the audit ledger honest.', skills: ['operations', 'security'], roles: ['ADMIN'], color: '#5227FF' },
  { key: 'organizer', email: 'organizer@dogfood.dev', name: 'Marcus Oyelaran', organization: 'Hackathon Raptors', bio: 'Runs Dogfood. Twelve tracks, five judges, one very long weekend.', skills: ['event operations', 'community'], roles: ['ORGANIZER', 'PARTICIPANT'], color: '#2F6BFF' },
  { key: 'coorganizer', email: 'deputy@dogfood.dev', name: 'Salma Haddad', organization: 'Hackathon Raptors', bio: 'Handles registration and the help desk so Marcus can watch the judging.', skills: ['operations', 'support'], roles: ['ORGANIZER', 'PARTICIPANT'], color: '#0E9F6E' },

  // --- judges
  { key: 'amara', email: 'amara@dogfood.dev', name: 'Dr. Amara Nwosu', organization: 'Meridian Institute', bio: 'Research scientist in distributed systems. Has mentored four of these teams before, and declares it every time.', skills: ['distributed systems', 'backend'], roles: ['JUDGE'], color: '#B497CF' },
  { key: 'ben', email: 'ben@dogfood.dev', name: 'Ben Castellanos', organization: 'Northwind Robotics', bio: 'Staff engineer. Harsh on paper, generous in practice, and impossible to fool with a demo.', skills: ['backend', 'devops'], roles: ['JUDGE'], color: '#C2410C' },
  { key: 'priya', email: 'priya@dogfood.dev', name: 'Dr. Priya Raman', organization: 'Halden Analytics', bio: 'Quantitative researcher. Gives almost identical scores and is almost always right about why.', skills: ['data', 'evaluation'], roles: ['JUDGE'], color: '#0F766E' },
  { key: 'tomas', email: 'tomas@dogfood.dev', name: 'Tomas Lindqvist', organization: 'Sable Interactive', bio: 'Game developer. Rewards audacious attempts that half-work over safe ones that fully work.', skills: ['graphics', 'game design'], roles: ['JUDGE'], color: '#7C3AED' },
  { key: 'yuki', email: 'yuki@dogfood.dev', name: 'Yuki Tanaka', organization: 'Freelance', bio: 'Independent engineer. Deep, careful reviewer — when she gets to it.', skills: ['mobile', 'backend'], roles: ['JUDGE'], color: '#FF9FFC' },

  // --- participants, grouped by team
  { key: 'p_iris', email: 'iris@dogfood.dev', name: 'Iris Bekele', organization: 'Addis Ababa University', bio: 'Second-year CS. Built her first HTTP server this winter and has opinions about it.', skills: ['Go', 'systems'], roles: ['PARTICIPANT'], color: '#5227FF' },
  { key: 'p_tomasz', email: 'tomasz@dogfood.dev', name: 'Tomasz Wilczyński', organization: 'Warsaw University of Technology', bio: 'Compilers, and stubborn about error messages.', skills: ['Rust', 'compilers'], roles: ['PARTICIPANT'], color: '#2F6BFF' },
  { key: 'p_mei', email: 'mei@dogfood.dev', name: 'Mei Ling Chow', organization: 'National University of Singapore', bio: 'ML engineer who took the weekend off to build something with a UI.', skills: ['PyTorch', 'UX'], roles: ['PARTICIPANT'], color: '#0E9F6E' },
  { key: 'p_dev', email: 'dev@dogfood.dev', name: 'Devansh Mehta', organization: 'IIT Bombay', bio: 'Backend by taste, frontend by necessity.', skills: ['Node.js', 'React'], roles: ['PARTICIPANT'], color: '#C2410C' },
  { key: 'p_sofia', email: 'sofia@dogfood.dev', name: 'Sofía Restrepo', organization: 'Universidad de los Andes', bio: 'Design engineer. Argues that empty states are a feature.', skills: ['design systems', 'React'], roles: ['PARTICIPANT'], color: '#7C3AED' },
  { key: 'p_noah', email: 'noah@dogfood.dev', name: 'Noah Brandt', organization: 'TU Delft', bio: 'Does the infrastructure nobody sees until it breaks.', skills: ['Kubernetes', 'Rust'], roles: ['PARTICIPANT'], color: '#0F766E' },
  { key: 'p_aiko', email: 'aiko@dogfood.dev', name: 'Aiko Murayama', organization: 'University of Tokyo', bio: 'Computer vision PhD who can still do pixel-level work at 2am.', skills: ['computer vision', 'C++'], roles: ['PARTICIPANT'], color: '#FF9FFC' },
  { key: 'p_luca', email: 'luca@dogfood.dev', name: 'Luca Ferrari', organization: 'Politecnico di Milano', bio: 'Embedded and low-level. Brought his own soldering iron.', skills: ['C', 'embedded'], roles: ['PARTICIPANT'], color: '#B497CF' },
  { key: 'p_hana', email: 'hana@dogfood.dev', name: 'Hana Kim', organization: 'KAIST', bio: 'Full-stack, and the person who actually read the accessibility guidelines.', skills: ['TypeScript', 'accessibility'], roles: ['PARTICIPANT'], color: '#5227FF' },
  { key: 'p_olu', email: 'olu@dogfood.dev', name: 'Oluwaseun Adeyemi', organization: 'University of Lagos', bio: 'Backend and databases. Will ask about your indexes.', skills: ['PostgreSQL', 'Go'], roles: ['PARTICIPANT'], color: '#2F6BFF' },
  { key: 'p_zara', email: 'zara@dogfood.dev', name: 'Zara Iqbal', organization: 'University of Edinburgh', bio: 'Mobile engineer learning Rust properly, publicly.', skills: ['Swift', 'Rust'], roles: ['PARTICIPANT'], color: '#0E9F6E' },
  { key: 'p_felix', email: 'felix@dogfood.dev', name: 'Felix Aho', organization: 'Aalto University', bio: 'Graphics and shaders. Came for the GPU, stayed for the deadline snacks.', skills: ['WebGL', 'GLSL'], roles: ['PARTICIPANT'], color: '#C2410C' },
  { key: 'p_greta', email: 'greta@dogfood.dev', name: 'Greta Lindholm', organization: 'KTH', bio: 'Climate data pipelines, and a spreadsheet purist.', skills: ['Python', 'data engineering'], roles: ['PARTICIPANT'], color: '#7C3AED' },
  { key: 'p_omar', email: 'omar@dogfood.dev', name: 'Omar Farouk', organization: 'Cairo University', bio: 'Security-minded backend dev. Audited his own team\'s API on day one.', skills: ['security', 'Node.js'], roles: ['PARTICIPANT'], color: '#0F766E' },
  { key: 'p_yara', email: 'yara@dogfood.dev', name: 'Yara Nasser', organization: 'American University of Beirut', bio: 'Product thinker who writes the README nobody else will.', skills: ['product', 'writing'], roles: ['PARTICIPANT'], color: '#FF9FFC' },
  { key: 'p_kenji', email: 'kenji@dogfood.dev', name: 'Kenji Watanabe', organization: 'University of Tokyo', bio: 'Realtime systems and audio. Brought a modular synth as a stress test.', skills: ['realtime', 'audio'], roles: ['PARTICIPANT'], color: '#B497CF' },
];

type TeamSpec = {
  key: string;
  name: string;
  description: string;
  organization: string;
  captain: string;
  members: string[];
  track: 'trk_ai' | 'trk_climate' | null;
};

const TEAMS: TeamSpec[] = [
  { key: 't_lattice', name: 'Lattice', description: 'A schema-aware query planner for time-series stores that refuses to guess at your units.', organization: 'Independent', captain: 'p_iris', members: ['p_iris', 'p_tomasz', 'p_olu'], track: null },
  { key: 't_glyph', name: 'Glyph Atlas', description: 'Font tooling that makes a missing glyph a first-class error instead of a blank box.', organization: 'Warsaw University of Technology', captain: 'p_tomasz', members: ['p_tomasz', 'p_iris'], track: null },
  { key: 't_ember', name: 'Ember', description: 'A tiny, fast experiment tracker: one command, one local file, no dashboard to babysit.', organization: 'National University of Singapore', captain: 'p_mei', members: ['p_mei', 'p_dev'], track: 'trk_ai' },
  { key: 't_beacon', name: 'Beacon', description: 'Uptime checks that understand your deploys, so a page refresh is not a false alarm.', organization: 'IIT Bombay', captain: 'p_dev', members: ['p_dev', 'p_omar', 'p_sofia'], track: null },
  { key: 't_vellum', name: 'Vellum', description: 'A design-token pipeline that keeps light and dark themes honest across three platforms.', organization: 'Universidad de los Andes', captain: 'p_sofia', members: ['p_sofia', 'p_hana', 'p_yara'], track: null },
  { key: 't_terrace', name: 'Terrace', description: 'A read-only disaster dashboard designed to work on a 3G phone with a dying battery.', organization: 'KTH', captain: 'p_greta', members: ['p_greta', 'p_noah'], track: 'trk_climate' },
  { key: 't_halide', name: 'Halide', description: 'On-device segmentation for agricultural imagery. Runs on a Raspberry Pi in a field.', organization: 'University of Tokyo', captain: 'p_aiko', members: ['p_aiko', 'p_luca', 'p_felix'], track: 'trk_ai' },
  { key: 't_ferrite', name: 'Ferrite', description: 'A sensor board and firmware that keeps logging through a brownout.', organization: 'Politecnico di Milano', captain: 'p_luca', members: ['p_luca', 'p_aiko'], track: 'trk_climate' },
  { key: 't_quill', name: 'Quill', description: 'Documentation search that understands your codebase, not just your markdown.', organization: 'KAIST', captain: 'p_hana', members: ['p_hana', 'p_zara'], track: null },
  { key: 't_cairn', name: 'Cairn', description: 'A visual builder for spatial indexes, with a query cost estimator attached.', organization: 'University of Lagos', captain: 'p_olu', members: ['p_olu', 'p_noah', 'p_tomasz'], track: null },
  { key: 't_prism', name: 'Prism', description: 'A shader playground that compiles in the browser and shows you the frame budget live.', organization: 'Aalto University', captain: 'p_felix', members: ['p_felix', 'p_zara'], track: null },
  { key: 't_resonant', name: 'Resonant', description: 'Low-latency audio for the browser, with a scheduler that does not drift by Sunday.', organization: 'University of Tokyo', captain: 'p_kenji', members: ['p_kenji', 'p_zara', 'p_felix'], track: null },
];

type ProjectSpec = {
  key: string;
  team: string;
  name: string;
  short: string;
  full: string;
  problem: string;
  solution: string;
  technologies: string[];
  repository: string;
  demo: string;
  docs: string;
  track: 'trk_ai' | 'trk_climate';
  /** Target quality per project, used to generate plausible review scores. */
  quality: number;
  submittedAtHours: number;
};

const PROJECTS: ProjectSpec[] = [
  {
    key: 'p_lattice',
    team: 't_lattice',
    name: 'Lattice',
    short: 'A query planner for time-series data that refuses to guess the unit your column is in.',
    full:
      'Lattice sits between your application and your time-series store. It reads the schema, infers units from column names and neighbouring series, and refuses to run a query whose units it cannot establish. Every plan is explainable: you get the estimated cardinality, the chosen index and the reason the alternative was rejected, in plain language. It ships with adapters for ClickHouse and TimescaleDB and a planner interface so you can add your own store in an afternoon.',
    problem:
      'Time-series queries fail quietly. A query against the wrong unit returns plausible numbers, a dashboard lies, and nobody notices for a week. Existing planners optimise for speed and treat semantic correctness as the caller\'s problem.',
    solution:
      'We made unit inference a first-class gate. Lattice resolves units before planning, and refuses the query with a specific explanation when it cannot. The planner then optimises within a proven-correct unit space, and every decision is logged as a structured reason code you can diff between runs.',
    technologies: ['Go', 'ClickHouse', 'TimescaleDB', 'React', 'gRPC'],
    repository: 'https://github.com/verdict-demo/lattice',
    demo: 'https://lattice.verdict.dev/demo',
    docs: 'https://lattice.verdict.dev/docs',
    track: 'trk_ai',
    quality: 88,
    submittedAtHours: 62,
  },
  {
    key: 'p_ember',
    team: 't_ember',
    name: 'Ember',
    short: 'Experiment tracking for people who do not want a dashboard: one command, one file, no cloud.',
    full:
      'Ember is a single binary. `ember run --lr 0.001 --epochs 12` starts a training run, writes every metric to a local append-only file, and prints a live loss curve in your terminal. Runs are comparable because the format is a published spec, not a proprietary blob. Sharing a result means sending one file. Ember has no accounts, no server and no telemetry, and it will still be running when your laptop dies.',
    problem:
      'Experiment trackers are infrastructure projects that consume a weekend and then sit there. Most hackathon teams hand-roll a CSV, lose it, and cannot compare two runs six weeks later.',
    solution:
      'We made the artefact the product. A run is a single append-only file with a documented schema, so comparing runs is a byte-level diff rather than a dashboard query. The CLI does the one thing a dashboard would do, faster, offline.',
    technologies: ['Python', 'PyTorch', 'Rich', 'SQLite'],
    repository: 'https://github.com/verdict-demo/ember',
    demo: 'https://ember.verdict.dev',
    docs: 'https://ember.verdict.dev/docs/format',
    track: 'trk_ai',
    quality: 91,
    submittedAtHours: 65,
  },
  {
    key: 'p_halide',
    team: 't_halide',
    name: 'Halide',
    short: 'On-device crop segmentation for a Raspberry Pi with no network and a hard power budget.',
    full:
      'Halide segments crop canopy and disease classes from a Raspberry Pi 4 running entirely offline, in under two seconds per frame at 640x480. The model is a small quantised U-Net trained on field imagery and exported to ONNX; the runtime is a thin C++ wrapper around ONNX Runtime with a careful memory budget so it fits alongside the camera pipeline. We ship a calibration tool that measures real frame times on your hardware rather than trusting a benchmark.',
    problem:
      'Agricultural image analysis is usually a cloud service, which fails exactly when it matters: no connectivity in the field, and per-frame bandwidth costs that make small farms unreachable.',
    solution:
      'We optimised for the worst case rather than the average: a strict memory ceiling, quantised weights, and a calibration step that reports the frame time distribution on the actual device. The result runs where the data is created.',
    technologies: ['C++', 'ONNX', 'Raspberry Pi', 'Python', 'Computer Vision'],
    repository: 'https://github.com/verdict-demo/halide',
    demo: 'https://halide.verdict.dev/demo',
    docs: 'https://halide.verdict.dev/docs/hardware',
    track: 'trk_ai',
    quality: 86,
    submittedAtHours: 60,
  },
  {
    key: 'p_terrace',
    team: 't_terrace',
    name: 'Terrace',
    short: 'A disaster dashboard that a volunteer can read on a 3G phone with 4% battery.',
    full:
      'Terrace shows flood extent, road access and shelter capacity on a screen that works when everything else is down. The whole client is 38 KB gzipped including fonts, renders vector tiles directly, and degrades to a text-only mode when the connection is under 64 kbps. Data is fetched from a static snapshot with ETag revalidation, so a volunteer who reloads costs the relief agency almost nothing.',
    problem:
      'Relief maps are designed for a laptop on a fast connection at an office. The people who need them are in a field, on a phone, with one bar and a battery that will not last.',
    solution:
      'We treated the network as hostile. A build-time snapshot, ETag revalidation, a strict byte budget enforced in CI, and a text mode that carries the same information as the map. Nothing loads that a volunteer does not need.',
    technologies: ['TypeScript', 'MapLibre', 'WebAssembly', 'PostgreSQL'],
    repository: 'https://github.com/verdict-demo/terrace',
    demo: 'https://terrace.verdict.dev',
    docs: 'https://terrace.verdict.dev/docs/offline',
    track: 'trk_climate',
    quality: 84,
    submittedAtHours: 58,
  },
  {
    key: 'p_beacon',
    team: 't_beacon',
    name: 'Beacon',
    short: 'Uptime monitoring that understands your deploy, so a rollout is not a page.',
    full:
      'Beacon polls from four regions and correlates the results with your deployment timeline. A check that fails during a rollout is annotated with the deploy that caused it and downgraded from an incident to a notice, because it is not an outage. When several regions agree, the alert carries the consensus. It is a small Go service plus a Postgres schema, and it fits comfortably on a single VM.',
    problem:
      'Every deploy causes a burst of failed checks. On-call engineers learn to ignore their own monitors, and then ignore a real one.',
    solution:
      'We made deploy context a first-class signal. Beacon takes a webhook on deploy, correlates failures inside that window, and reports severity with the evidence attached, so an alert is either actionable or silent.',
    technologies: ['Go', 'PostgreSQL', 'Prometheus', 'React'],
    repository: 'https://github.com/verdict-demo/beacon',
    demo: 'https://beacon.verdict.dev/demo',
    docs: 'https://beacon.verdict.dev/docs/correlation',
    track: 'trk_ai',
    quality: 79,
    submittedAtHours: 63,
  },
  {
    key: 'p_ferrite',
    team: 't_ferrite',
    name: 'Ferrite',
    short: 'A sensor board and firmware that keeps logging through a brownout, and tells you it did.',
    full:
      'Ferrite is a soil-moisture and temperature board with a supercapacitor buffer that lets the MCU finish its write and close the log entry when the primary supply collapses. The firmware detects the brownout, marks the entry as truncated, and resyncs cleanly. Over a simulated 40-day deployment in a lab with weekly power cuts, the log had 3 truncated entries out of 41,200 and zero silent losses.',
    problem:
      'Field sensors lose data exactly when conditions are worst, and they lose it silently: the write simply never completes and the gap is invisible.',
    solution:
      'We treated every interruption as expected. A hold-up capacitor plus a truncation marker means a power cut produces a visible, bounded artefact rather than an unknowable gap.',
    technologies: ['C', 'Rust', 'RP2040', 'I2C', 'KiCad'],
    repository: 'https://github.com/verdict-demo/ferrite',
    demo: 'https://ferrite.verdict.dev/demo',
    docs: 'https://ferrite.verdict.dev/docs/power',
    track: 'trk_climate',
    quality: 77,
    submittedAtHours: 57,
  },
  {
    key: 'p_vellum',
    team: 't_vellum',
    name: 'Vellum',
    short: 'A design-token pipeline that keeps light and dark themes from quietly diverging.',
    full:
      'Vellum compiles one token source into CSS custom properties, Swift and Kotlin, and fails CI when a token exists in one platform and not another. It understands the WCAG contrast requirement as a build constraint: a proposed colour pair below 4.5:1 is a build failure with the computed ratio in the message, not a design review comment nobody reads.',
    problem:
      'Design tokens drift. A colour lands in the web app and never reaches mobile, dark mode diverges from light, and the contrast that was checked once at design time is quietly broken in production.',
    solution:
      'We made drift a build failure. One source, three targets, and a contrast gate that refuses to compile. The pipeline is 900 lines of TypeScript and has no runtime dependency.',
    technologies: ['TypeScript', 'Swift', 'Kotlin', 'Node.js'],
    repository: 'https://github.com/verdict-demo/vellum',
    demo: 'https://vellum.verdict.dev',
    docs: 'https://vellum.verdict.dev/docs/pipeline',
    track: 'trk_ai',
    quality: 82,
    submittedAtHours: 61,
  },
  {
    key: 'p_quill',
    team: 't_quill',
    name: 'Quill',
    short: 'Documentation search that indexes your source comments, not just your markdown.',
    full:
      'Quill builds a search index over docstrings, inline comments and markdown together, so searching for "retry backoff" finds the function, the comment explaining the constant, and the guide that references it. It respects `// doc-only` and `// ignore` directives, and the index is a single compressed file you can commit, which is what makes it work offline and in CI.',
    problem:
      'Documentation search only covers the documentation. The most accurate answer is usually in a docstring next to the code, and nothing indexes it.',
    solution:
      'We indexed the source, not just the docs, and made the index a committable file so search works with no service to run.',
    technologies: ['Rust', 'TypeScript', 'BM25', 'WebAssembly'],
    repository: 'https://github.com/verdict-demo/quill',
    demo: 'https://quill.verdict.dev',
    docs: 'https://quill.verdict.dev/docs/directives',
    track: 'trk_ai',
    quality: 74,
    submittedAtHours: 59,
  },
  {
    key: 'p_glyph',
    team: 't_glyph',
    name: 'Glyph Atlas',
    short: 'Font tooling that turns a missing glyph into a build failure instead of a blank box.',
    full:
      'Glyph Atlas scans your UI strings against the fonts you ship and fails the build when a character has no coverage, reporting the codepoint, the string it came from and the fallback that would have been used. It also reports coverage per language, so you can see that your interface supports Latin-1 and nothing else. Coverage data comes from the actual font binaries, not a stale metrics database.',
    problem:
      'A missing glyph is invisible in development on the author\'s machine and visible to every user whose language you did not test. It is usually discovered in production.',
    solution:
      'We moved glyph coverage into CI. A build that would render a tofu box fails, and the message tells you which string and which fallback.',
    technologies: ['Rust', 'fontTools', 'TypeScript', 'WASM'],
    repository: 'https://github.com/verdict-demo/glyph-atlas',
    demo: 'https://glyph-atlas.verdict.dev',
    docs: 'https://glyph-atlas.verdict.dev/docs/coverage',
    track: 'trk_ai',
    quality: 72,
    submittedAtHours: 56,
  },
  {
    key: 'p_cairn',
    team: 't_cairn',
    name: 'Cairn',
    short: 'A visual builder for spatial indexes, with the query cost estimate attached to every shape.',
    full:
      'Cairn lets you draw a query plan for geospatial data and shows you the estimated cost and the actual cost side by side. It ships with estimators for PostgreSQL PostGIS and a MongoDB backend, and it will tell you when its own estimate is wrong, which is the part that matters. The visual layer is deliberately plain: a canvas, a plan tree, and numbers.',
    problem:
      'Spatial query plans are read by intuition. Engineers draw a box, get an index scan or a sequential scan, and have no intuition for why.',
    solution:
      'We made the estimate visible and falsifiable. Draw the query, see the predicted and measured cost, and see the estimator\'s error when it is wrong.',
    technologies: ['TypeScript', 'PostGIS', 'MongoDB', 'React'],
    repository: 'https://github.com/verdict-demo/cairn',
    demo: 'https://cairn.verdict.dev/demo',
    docs: 'https://cairn.verdict.dev/docs/estimators',
    track: 'trk_climate',
    quality: 68,
    submittedAtHours: 55,
  },
  {
    key: 'p_prism',
    team: 't_prism',
    name: 'Prism',
    short: 'A shader playground that compiles in the browser and shows the frame budget while you type.',
    full:
      'Prism compiles GLSL to WebGPU in a worker and streams the frame budget back as you type, so you can see which instruction cost you 4 ms before you commit to the change. It includes a small library of 60 deliberately instructive shaders and a diff view that highlights the lines you touched. Compilation happens entirely in the browser; there is no build step and nothing is uploaded.',
    problem:
      'Shader development is a slow edit-compile-wait loop with no feedback about cost until you profile, at which point the change is already written.',
    solution:
      'We put the cost estimate in the editor. Streaming compilation plus a per-line budget turns a slow loop into a tight one.',
    technologies: ['WebGPU', 'GLSL', 'TypeScript', 'WASM'],
    repository: 'https://github.com/verdict-demo/prism',
    demo: 'https://prism.verdict.dev/playground',
    docs: 'https://prism.verdict.dev/docs/frame-budget',
    track: 'trk_ai',
    quality: 80,
    submittedAtHours: 64,
  },
  {
    key: 'p_resonant',
    team: 't_resonant',
    name: 'Resonant',
    short: 'Browser audio scheduling that does not drift by Sunday.',
    full:
      'Resonant is an audio scheduling library for the web with a drift measurement built in. It uses a lookahead scheduler against AudioContext time and reports measured drift per callback, so you can see whether a 3 ms jitter accumulates over 40 hours of playback. It ships with a WebAudio fallback, a test harness that runs faster than real time, and a golden-drift CI check.',
    problem:
      'Web Audio scheduling drifts. A scheduler that looks fine for ten minutes can be 40 ms out after a day, and the artefacts appear as clicks nobody can reproduce.',
    solution:
      'We made drift a measured, asserted property. The library reports it, the test harness reproduces it, and CI fails if it regresses.',
    technologies: ['TypeScript', 'Web Audio', 'Rust', 'WASM'],
    repository: 'https://github.com/verdict-demo/resonant',
    demo: 'https://resonant.verdict.dev/demo',
    docs: 'https://resonant.verdict.dev/docs/scheduling',
    track: 'trk_ai',
    quality: 76,
    submittedAtHours: 59,
  },
];

/** The rubric, and the per-judge score offsets that create the story. */
const RUBRIC_CRITERIA = [
  { key: 'technical', name: 'Technical Quality', description: 'Does it work, is it well built, and would you maintain it?', weight: 0.3, min: 0, max: 10, required: true },
  { key: 'innovation', name: 'Innovation', description: 'Is the idea new, or at least newly and competently executed?', weight: 0.25, min: 0, max: 10, required: true },
  { key: 'impact', name: 'Impact', description: 'Who does this help, and how much does it matter to them?', weight: 0.25, min: 0, max: 10, required: true },
  { key: 'experience', name: 'Experience', description: 'Is it usable, accessible and honest about its state?', weight: 0.2, min: 0, max: 10, required: true },
] as const;

const RUBRIC: RubricVersion = {
  id: 'rvr_dogfood_1',
  rubricId: 'rub_dogfood',
  version: 1,
  status: 'LOCKED',
  criteria: RUBRIC_CRITERIA.map((criterion, index) => ({
    id: `rct_${criterion.key}`,
    key: criterion.key,
    name: criterion.name,
    description: criterion.description,
    weight: criterion.weight,
    min: criterion.min,
    max: criterion.max,
    required: criterion.required,
    scoringType: 'DECIMAL' as const,
    order: index,
    publishBreakdown: true,
  })),
  weightsMustSumToOne: true,
  rounding: { precision: 4, mode: 'HALF_UP' },
  tieBreakPriority: ['technical', 'innovation'],
  notes: 'Standard Dogfood 2026 rubric. Weights are fixed before judging opens.',
};

/**
 * Per-judge scoring personalities.
 *
 * `offset` shifts every score, `spread` scales how far the judge reaches from
 * the middle, and `tilt` is the per-criterion bias. These produce the three
 * behaviours the demo is built to reveal: a systematically generous judge, a
 * harsh one, a very low-variance one, and a broad one.
 */
const JUDGE_PERSONALITY: Record<string, { offset: number; spread: number; tilt: Record<string, number>; skips: number }> = {
  amara: { offset: 8, spread: 0.85, tilt: { technical: 1.5, innovation: 0.5, impact: -0.5, experience: 0 }, skips: 0 },
  ben: { offset: -6, spread: 1.1, tilt: { technical: 1, innovation: 0, impact: -1, experience: -0.5 }, skips: 0 },
  priya: { offset: 0, spread: 0.18, tilt: {}, skips: 0 },
  tomas: { offset: 1, spread: 1.45, tilt: { technical: -1, innovation: 2.5, impact: -0.5, experience: 0.5 }, skips: 0 },
  yuki: { offset: 2, spread: 0.7, tilt: {}, skips: 2 },
};

/**
 * Panel capacity is deliberately uneven, and two judges sit well below what a
 * round-robin would demand. A demo that loads every judge perfectly teaches an
 * organiser nothing about the coverage report or the `UNASSIGNED` state, which
 * are exactly the screens they will open first.
 */
const JUDGE_SPECS = [
  { key: 'amara', capacity: 12 },
  { key: 'ben', capacity: 12 },
  { key: 'priya', capacity: 12 },
  { key: 'tomas', capacity: 10 },
  { key: 'yuki', capacity: 10 },
] as const;

/* ---------------------------------------------------------------- seed */

export async function seedDemoData(db: Database, config: AppConfig): Promise<SeedSummary> {
  const logger = createLogger({ level: config.logging.level, pretty: config.logging.pretty });
  const services = createServices({ config, db, logger });
  const passwordHash = hashPassword(DEMO_PASSWORD);

  const userIds = new Map<string, string>();
  const teamIds = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const judgeIds = new Map<string, string>();
  // Declared out here rather than inside the transaction: the summary needs them.
  let reviewCount = 0;
  let voteCount = 0;
  const eventId = newId('event');

  db.transaction(() => {
    /* ------------------------------------------------------------ users */
    for (const person of PEOPLE) {
      const id = newId('user');
      userIds.set(person.key, id);
      db.exec(
        `INSERT INTO users (id, email, email_normalized, username, username_normalized, display_name, password_hash,
           bio, organization, skills, avatar_color, state, email_verified, created_at, updated_at)
         VALUES (:id, :email, :email_normalized, :username, :username_normalized, :name, :hash,
           :bio, :org, :skills, :color, 'ACTIVE', 1, :at, :at)`,
        {
          id,
          email: person.email,
          // Login looks users up by the normalized column, so the demo dataset
          // has to store it the same way registration does rather than relying
          // on the fixture addresses happening to be lowercase already.
          email_normalized: person.email.trim().toLowerCase(),
          username: person.email.split('@')[0] as string,
          username_normalized: (person.email.split('@')[0] as string).trim().toLowerCase(),
          name: person.name,
          hash: passwordHash,
          bio: person.bio,
          org: person.organization,
          skills: JSON.stringify(person.skills),
          color: person.color,
          at: at(-72),
        },
      );
    }

    /*
     * Roles come after the event, not before it. `user_roles.event_id` is a real
     * foreign key, so an event-scoped role cannot be granted to a user until
     * the event it is scoped to exists — and the event needs its creator to
     * exist first, which is the loop above. Global roles have a NULL event_id
     * and so could be written earlier, but writing all of them together keeps
     * the grant timestamps honest.
     */
    const grantRoles = (at: string) => {
      for (const person of PEOPLE) {
        for (const role of person.roles) {
          // ADMIN and PARTICIPANT are global; JUDGE and ORGANIZER are scoped to
          // this event. 'scope' is the non-null mirror the primary key needs, so
          // a global role is stored with an empty string.
          const eventScoped = role === 'JUDGE' || role === 'ORGANIZER';
          db.exec(
            `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at) VALUES (:u, :role, :e, :scope, :g, :at)`,
            {
              u: userIds.get(person.key) as string,
              role,
              e: eventScoped ? eventId : null,
              scope: eventScoped ? eventId : '',
              g: userIds.get(person.key) as string,
              at,
            },
          );
        }
      }
    };

    /* ----------------------------------------------------------- event */
    db.exec(
      `INSERT INTO events (id, slug, name, tagline, description, rules, state, timezone,
         registration_opens_at, registration_closes_at, submission_opens_at, submission_closes_at,
         judging_opens_at, judging_closes_at, voting_opens_at, voting_closes_at,
         max_team_size, min_team_size, allow_individual, gallery_visibility, gallery_order,
         voting_enabled, voting_reveal_totals, voting_requires_registration,
         comments_enabled, comments_require_approval, results_visibility,
         results_publish_criterion_breakdown, results_publish_judge_count,
         reviews_per_project, minimum_judges, normalize_by_votes, assignment_seed,
         banner_url, logo_url, created_by, created_at, updated_at)
       VALUES (:id, 'dogfood-2026', 'Dogfood 2026',
         'Thirty-six hours, twelve teams, one defensible way to pick a winner.',
         'Dogfood is Hackathon Raptors'' annual build weekend. This year we asked teams to build something a real team would actually use on Monday morning, and we rebuilt the judging around an engine you can audit: published rubric, conflict-aware assignment, judge normalization, and a result snapshot you can reproduce.',
         'Build something real. Teams of 2-4. One repository, one demo, a five-minute pitch. Judging is blind to team identity: conflicts are declared and enforced, scores are normalized per judge, and the final ranking is published with an integrity hash you can check yourself.',
         'JUDGING', 'UTC',
         :reg_open, :reg_close, :sub_open, :sub_close,
         :judge_open, :judge_close, :vote_open, :vote_close,
         4, 1, 0, 'PUBLIC', 'RANDOMIZED',
         1, 0, 1,
         1, 0, 'PUBLIC',
         1, 1,
         3, 3, 0, :seed,
         NULL, NULL, :creator, :created, :updated)`,
      {
        id: eventId,
        reg_open: at(0),
        reg_close: at(12),
        sub_open: at(12),
        sub_close: at(70),
        judge_open: at(72),
        judge_close: at(120),
        vote_open: at(72),
        vote_close: at(118),
        seed: 'dogfood-2026-panel',
        creator: userIds.get('organizer') as string,
        created: at(-72),
        updated: at(120),
      },
    );

    // The event now exists, so event-scoped roles can reference it.
    grantRoles(at(-70));

    db.exec(
      `INSERT INTO event_tracks (id, event_id, slug, name, description, color, display_order, created_at, updated_at)
       VALUES (:ai, :e, 'applied-ai', 'Applied AI', 'Models and automation that earn their keep.', '#5227FF', 0, :at, :at),
              (:ci, :e, 'climate', 'Climate & Civic', 'Software for the physical world and the people in it.', '#0E9F6E', 1, :at, :at)`,
      { ai: newId('track'), ci: newId('track'), e: eventId, at: at(-70) },
    );
    const trackIds = new Map<string, string>([
      ['trk_ai', db.value<string>('SELECT id FROM event_tracks WHERE event_id = :e AND slug = :s', { e: eventId, s: 'applied-ai' }) as string],
      ['trk_climate', db.value<string>('SELECT id FROM event_tracks WHERE event_id = :e AND slug = :s', { e: eventId, s: 'climate' }) as string],
    ]);

    db.exec(
      `INSERT INTO prizes (id, event_id, name, description, quantity, eligible_ranks, eligible_track_id, priority, display_order, created_at, updated_at)
       VALUES (:g, :e, 'Grand Prize', 'Best overall project at Dogfood 2026.', 1, '[1]', NULL, 1, 0, :at, :at),
              (:a, :e, 'Best in Applied AI', 'Strongest applied machine learning project.', 1, '[]', :ai, 2, 1, :at, :at),
              (:c, :e, 'Best in Climate & Civic', 'Strongest project for the physical world.', 1, '[]', :ci, 3, 2, :at, :at),
              (:h, :e, 'Honourable Mention', 'Recognised, not ranked.', 2, '[4,5]', NULL, 4, 3, :at, :at)`,
      {
        g: newId('prize'),
        a: newId('prize'),
        c: newId('prize'),
        h: newId('prize'),
        e: eventId,
        ai: trackIds.get('trk_ai') as string,
        ci: trackIds.get('trk_climate') as string,
        at: at(-70),
      },
    );

    /* ---------------------------------------------------- registration */
    for (const person of PEOPLE) {
      if (!person.roles.includes('PARTICIPANT')) continue;
      db.exec(
        `INSERT INTO registrations (id, event_id, user_id, state, full_name, organization, skills,
           github_url, portfolio_url, bio, decided_by, decided_at, submitted_at, created_at, updated_at)
         VALUES (:id, :e, :u, 'ACCEPTED', :name, :org, :skills, :gh, :pf, :bio, :by, :at, :at, :at, :at)`,
        {
          id: newId('registration'),
          e: eventId,
          u: userIds.get(person.key) as string,
          name: person.name,
          org: person.organization,
          skills: JSON.stringify(person.skills),
          gh: `https://github.com/${person.email.split('@')[0]}`,
          pf: null,
          bio: person.bio,
          by: userIds.get('organizer') as string,
          at: at(6),
        },
      );
    }

    /* ----------------------------------------------------------- teams */
    for (const team of TEAMS) {
      const id = newId('team');
      teamIds.set(team.key, id);
      db.exec(
        `INSERT INTO teams (id, event_id, slug, name, description, captain_id, organization, track_id, created_at, updated_at)
         VALUES (:id, :e, :slug, :name, :desc, :captain, :org, :track, :at, :at)`,
        {
          id,
          e: eventId,
          slug: team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: team.name,
          desc: team.description,
          captain: userIds.get(team.captain) as string,
          org: team.organization,
          track: team.track ? (trackIds.get(team.track) as string) : null,
          at: at(20),
        },
      );
      for (const member of team.members) {
        db.exec(
          `INSERT INTO team_members (id, team_id, user_id, role, joined_at, created_at, updated_at)
           VALUES (:id, :t, :u, :role, :at, :at, :at)`,
          { id: newId('teamMember'), t: id, u: userIds.get(member) as string, role: member === team.captain ? 'CAPTAIN' : 'MEMBER', at: at(20) },
        );
      }
    }

    /* ----------------------------------------------------- submissions */
    for (const project of PROJECTS) {
      const id = newId('submission');
      projectIds.set(project.key, id);
      const team = TEAMS.find((t) => t.key === project.team) as TeamSpec;
      const submitted = at(project.submittedAtHours);
      db.exec(
        `INSERT INTO submissions (id, event_id, team_id, track_id, created_by, slug, project_name,
           short_description, full_description, problem, solution, technologies,
           repository_url, demo_url, video_url, documentation_url, cover_image_url,
           state, current_version, submitted_at, gallery_visible, eligible_for_prizes, created_at, updated_at)
         VALUES (:id, :e, :t, :track, :by, :slug, :name,
           :short, :full, :problem, :solution, :tech,
           :repo, :demo, NULL, :docs, NULL,
           'LOCKED', 3, :submitted, 1, 1, :created, :submitted)`,
        {
          id,
          e: eventId,
          t: teamIds.get(project.team) as string,
          track: trackIds.get(project.track) as string,
          by: userIds.get(team.captain) as string,
          slug: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: project.name,
          short: project.short,
          full: project.full,
          problem: project.problem,
          solution: project.solution,
          tech: JSON.stringify(project.technologies),
          repo: project.repository,
          demo: project.demo,
          docs: project.docs,
          submitted,
          created: at(14),
        },
      );
      // Three versions: draft, refinement, final. The final one is frozen.
      for (let version = 1; version <= 3; version += 1) {
        const snapshot = canonicalJson({
          projectName: project.name,
          shortDescription: project.short,
          fullDescription: version === 1 ? project.full.slice(0, Math.floor(project.full.length * 0.7)) : project.full,
          technologies: project.technologies,
          trackId: project.track,
          repositoryUrl: project.repository,
          demoUrl: version === 1 ? null : project.demo,
          state: version === 3 ? 'LOCKED' : version === 2 ? 'SUBMITTED' : 'DRAFT',
        });
        db.exec(
          `INSERT INTO submission_versions (id, submission_id, version, author_id, state, changed_fields, snapshot, checksum, is_final, note, created_at)
           VALUES (:id, :s, :v, :by, :state, :changed, :snapshot, :checksum, :final, :note, :at)`,
          {
            id: newId('submissionVersion'),
            s: id,
            v: version,
            by: userIds.get(team.captain) as string,
            state: version === 3 ? 'LOCKED' : version === 2 ? 'SUBMITTED' : 'DRAFT',
            changed: JSON.stringify(version === 1 ? ['created'] : version === 2 ? ['fullDescription', 'demoUrl'] : ['locked']),
            snapshot,
            checksum: sha256Hex(snapshot),
            final: version === 3 ? 1 : 0,
            note: version === 1 ? 'first draft' : version === 2 ? 'tightened the description after feedback' : 'final version at the deadline',
            at: at(project.submittedAtHours - (3 - version) * 3),
          },
        );
      }
    }

    /* ---------------------------------------------------------- rubric */
    const rubricId = 'rub_dogfood';
    db.exec(
      'INSERT INTO rubrics (id, event_id, name, description, created_by, created_at, updated_at) VALUES (:id, :e, :name, :desc, :by, :at, :at)',
      { id: rubricId, e: eventId, name: 'Dogfood 2026 standard rubric', desc: 'Four criteria, fixed weights, published before judging opens.', by: userIds.get('organizer') as string, at: at(-60) },
    );
    db.exec(
      `INSERT INTO rubric_versions (id, rubric_id, event_id, version, status, weights_must_sum_to_one, rounding_precision,
         rounding_mode, tie_break_priority, judge_guidance, notes, activated_at, locked_at, created_by, created_at, updated_at)
       VALUES (:id, :rubric, :e, 1, 'LOCKED', 1, 4, 'HALF_UP', :priority, :guidance, :notes, :activated, :locked, :by, :at, :at)`,
      {
        id: RUBRIC.id,
        rubric: rubricId,
        e: eventId,
        priority: JSON.stringify(['technical', 'innovation']),
        guidance:
          'Score what is in front of you, not what you wish the team had built. Technical Quality is about whether it works and whether it is well made — not about how large the codebase is. Innovation rewards a new idea or a notably competent execution of an old one; it does not reward novelty for its own sake. Impact asks who is helped and how much it matters to them. Experience covers usability, accessibility, and whether the interface is honest about its state. If a project is incomplete, say so in the comment and score what exists.',
        notes: 'Weights are fixed before judging opens and the version is locked once judging starts.',
        activated: at(-59),
        locked: at(72),
        by: userIds.get('organizer') as string,
        at: at(-60),
      },
    );
    for (const criterion of RUBRIC.criteria) {
      db.exec(
        `INSERT INTO rubric_criteria (id, rubric_version_id, field_key, name, description, weight, min_value, max_value,
           required, scoring_type, display_order, publish_breakdown, created_at, updated_at)
         VALUES (:id, :rv, :key, :name, :desc, :weight, :min, :max, :required, 'DECIMAL', :order, 1, :at, :at)`,
        {
          id: criterion.id,
          rv: RUBRIC.id,
          key: criterion.key,
          name: criterion.name,
          desc: criterion.description,
          weight: criterion.weight,
          min: criterion.min,
          max: criterion.max,
          required: criterion.required ? 1 : 0,
          order: criterion.order,
          at: at(-60),
        },
      );
    }

    /* ---------------------------------------------------------- judges */
    for (const spec of JUDGE_SPECS) {
      const person = PEOPLE.find((p) => p.key === spec.key) as PersonSpec;
      const id = newId('judge');
      judgeIds.set(spec.key, id);
      db.exec(
        `INSERT INTO judges (id, event_id, user_id, state, title, organization, expertise, capacity, bio, invited_by, invited_at, responded_at, activated_at, completed_at, created_at, updated_at)
         VALUES (:id, :e, :u, 'ACTIVE', :title, :org, :expertise, :capacity, :bio, :by, :invited, :responded, :activated, :completed, :invited, :completed)`,
        {
          id,
          e: eventId,
          u: userIds.get(spec.key) as string,
          title: 'Judging panel',
          org: person.organization,
          expertise: JSON.stringify(person.skills),
          capacity: spec.capacity,
          bio: person.bio,
          by: userIds.get('organizer') as string,
          invited: at(-50),
          responded: at(-46),
          activated: at(74),
          completed: at(121),
        },
      );
    }

    /* -------------------------------------------------------- conflict */
    // Amara mentored the Lattice team. Hard conflict, declared by the judge.
    db.exec(
      `INSERT INTO judge_conflicts (id, event_id, judge_id, project_id, subject_kind, subject_id, kind, severity, note, declared_by, created_at, updated_at)
       VALUES (:id, :e, :judge, :project, 'MENTOR', NULL, 'MENTOR', 'HARD', :note, :by, :at, :at)`,
      {
        id: newId('judgeConflict'),
        e: eventId,
        judge: judgeIds.get('amara') as string,
        project: projectIds.get('p_lattice') as string,
        note: 'I supervised this team during the regional bootcamp last autumn. I should not score it.',
        by: userIds.get('amara') as string,
        at: at(-44),
      },
    );

    /* ----------------------------------------------------- assignments */
    // Build the assignment through the real engine so the seeded data is
    // provably what the engine produces for this seed.
    const conflicts: ConflictDeclaration[] = [
      { judgeId: judgeIds.get('amara') as string, projectId: projectIds.get('p_lattice') as string, kind: 'MENTOR', severity: 'HARD', subjectId: null, note: 'Mentored this team' },
    ];
    const preview = generateAssignmentPreview(
      {
        eventId,
        strategy: 'WORKLOAD_AWARE',
        judges: JUDGE_SPECS.map((spec) => ({
          judgeId: judgeIds.get(spec.key) as string,
          displayName: (PEOPLE.find((p) => p.key === spec.key) as PersonSpec).name,
          state: 'ACTIVE',
          capacity: spec.capacity,
          existingLoad: 0,
          expertise: [],
          excluded: false,
          exclusionReason: null,
        })),
        projects: PROJECTS.map((project) => ({
          projectId: projectIds.get(project.key) as string,
          trackId: trackIds.get(project.track) as string,
          teamId: teamIds.get(project.team) as string,
          organization: (TEAMS.find((t) => t.key === project.team) as TeamSpec).organization,
          existingJudges: [],
          hardConflicts: project.key === 'p_lattice' ? [judgeIds.get('amara') as string] : [],
          softConflicts: [],
          relatedJudges: [],
          reviewsNeeded: 3,
        })),
        conflicts,
        reviewsPerProject: 3,
        seed: 'dogfood-2026-panel',
      },
      at(73),
    );

    for (const pair of preview.pairs) {
      db.exec(
        `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, soft_conflict, assigned_at, created_at, updated_at)
         VALUES (:id, :e, :j, :s, 1, 'ASSIGNED', 'WORKLOAD_AWARE', :reason, :soft, :at, :at, :at)`,
        {
          id: newId('judgeAssignment'),
          e: eventId,
          j: pair.judgeId,
          s: pair.projectId,
          reason: pair.reason,
          soft: pair.softConflict ? 1 : 0,
          at: at(73),
        },
      );
    }

    /* --------------------------------------------------------- reviews */

    let skipped = 0;
    for (const assignment of db.all<{ judge_id: string; submission_id: string; id: string }>(
      "SELECT id, judge_id, submission_id FROM judge_assignments WHERE event_id = :e AND status <> 'REASSIGNED' ORDER BY judge_id, submission_id",
      { e: eventId },
    )) {
      const judgeKey = [...judgeIds.entries()].find(([, id]) => id === assignment.judge_id)?.[0] as string;
      const projectKey = [...projectIds.entries()].find(([, id]) => id === assignment.submission_id)?.[0] as string;
      // Keyed by a `const` table with a `Record` index, so TypeScript cannot
      // prove the lookup is total even though every judge key is present.
      // Failing loudly here beats emitting a score with `NaN` weights.
      const personality = JUDGE_PERSONALITY[judgeKey];
      if (personality === undefined) throw new Error(`seed: no judge personality for "${judgeKey}"`);
      const project = PROJECTS.find((p) => p.key === projectKey) as ProjectSpec;

      if (skipped < personality.skips) {
        // Yuki genuinely did not finish these; they stay DRAFT, and the
        // coverage report must show them.
        skipped += 1;
        db.exec(
          `INSERT INTO scores (id, event_id, assignment_id, judge_id, submission_id, rubric_version_id, state, summary, started_at, created_at, updated_at)
           VALUES (:id, :e, :a, :j, :s, :rv, 'DRAFT', '', :at, :at, :at)`,
          { id: newId('score'), e: eventId, a: assignment.id, j: assignment.judge_id, s: assignment.submission_id, rv: RUBRIC.id, at: at(100 + skipped) },
        );
        db.exec("UPDATE judge_assignments SET status = 'IN_PROGRESS', updated_at = :at WHERE id = :id", { at: at(100 + skipped), id: assignment.id });
        continue;
      }

      // Deterministic per-judge, per-project variation: no Math.random anywhere,
      // so re-seeding produces byte-identical scores.
      const variation = (((judgeKey.length * 31 + projectKey.length * 17 + project.quality) % 13) - 6) / 6;
      const criteria = RUBRIC.criteria.map((criterion) => {
        const tilt = personality.tilt[criterion.key] ?? 0;
        const base = (project.quality + tilt) / 10;
        const value = clampToScale(base + personality.offset / 100 + personality.spread * variation * 0.12, criterion.min, criterion.max);
        return { criterionId: criterion.id, value: round2(value), comment: commentFor(project, criterion.key, value) };
      });

      const evaluation = evaluateReview(RUBRIC, criteria.map((c) => ({ criterionId: c.criterionId, value: c.value, comment: c.comment })));
      const startedAt = at(74 + (reviewCount % 40) * 0.4);
      const submittedAt = at(75 + (reviewCount % 40) * 0.4 + 0.05 + personality.spread * 0.1);
      const scoreId = newId('score');

      db.exec(
        `INSERT INTO scores (id, event_id, assignment_id, judge_id, submission_id, rubric_version_id, state, total_score, raw_score, summary, started_at, submitted_at, duration_ms, created_at, updated_at)
         VALUES (:id, :e, :a, :j, :s, :rv, 'SUBMITTED', :total, :raw, :summary, :started, :submitted, :duration, :started, :submitted)`,
        {
          id: scoreId,
          e: eventId,
          a: assignment.id,
          j: assignment.judge_id,
          s: assignment.submission_id,
          rv: RUBRIC.id,
          total: evaluation.total,
          raw: evaluation.score100,
          summary: '',
          started: startedAt,
          submitted: submittedAt,
          duration: Math.round(120_000 + personality.spread * 240_000 + variation * 60_000),
        },
      );
      for (const scored of evaluation.criteria) {
        db.exec(
          `INSERT INTO criterion_scores (id, score_id, criterion_id, rubric_version_id, value, normalized, points, comment, created_at, updated_at)
           VALUES (:id, :score, :criterion, :rv, :value, :normalized, :points, :comment, :at, :at)`,
          {
            id: newId('criterionScore'),
            score: scoreId,
            criterion: scored.criterionId,
            rv: RUBRIC.id,
            value: scored.rawValue,
            normalized: scored.normalised,
            points: scored.pointsOutOf100,
            comment: scored.comment ?? '',
            at: submittedAt,
          },
        );
      }
      db.exec("UPDATE judge_assignments SET status = 'SUBMITTED', completed_at = :at, updated_at = :at WHERE id = :id", { at: submittedAt, id: assignment.id });
      reviewCount += 1;
    }

    /* -------------------------------------------------------- pairwise */
    // A deliberate non-transitive triple: Ember beats Lattice, Lattice beats
    // Ember's runner-up, and the reverse on one comparison. Bradley-Terry must
    // report this rather than hide it.
    const pairOrder = ['p_ember', 'p_lattice', 'p_halide', 'p_terrace', 'p_beacon', 'p_vellum', 'p_prism', 'p_quill'];
    let pairIndex = 0;
    for (const judgeKey of ['amara', 'ben', 'priya']) {
      const judgeId = judgeIds.get(judgeKey) as string;
      const available = pairOrder.filter((key) => {
        const projectId = projectIds.get(key) as string;
        if (judgeKey === 'amara' && key === 'p_lattice') return false;
        const assigned = db.value<number>(
          "SELECT COUNT(*) AS c FROM judge_assignments WHERE event_id = :e AND judge_id = :j AND submission_id = :s AND status <> 'REASSIGNED'",
          { e: eventId, j: judgeId, s: projectId },
        );
        return (assigned ?? 0) > 0;
      });
      for (let i = 0; i < Math.min(6, available.length - 1); i += 1) {
        const left = available[i] as string;
        const right = available[(i + 1) % available.length] as string;
        // Rotate outcomes so most comparisons agree and exactly one is a cycle.
        const outcome: 'LEFT' | 'RIGHT' = pairIndex % 11 === 5 ? 'RIGHT' : 'LEFT';
        db.exec(
          `INSERT INTO pairwise_comparisons (id, event_id, judge_id, left_submission_id, right_submission_id, outcome, duration_ms, created_at, updated_at)
           VALUES (:id, :e, :j, :l, :r, :outcome, :duration, :at, :at)`,
          {
            id: newId('pairwiseComparison'),
            e: eventId,
            j: judgeId,
            l: projectIds.get(left) as string,
            r: projectIds.get(right) as string,
            outcome,
            duration: 9_000 + ((pairIndex * 7_919) % 40_000),
            at: at(100 + pairIndex * 0.2),
          },
        );
        pairIndex += 1;
      }
    }

    /* ----------------------------------------------------------- votes */
    const voterKeys = PEOPLE.filter((p) => p.roles.includes('PARTICIPANT')).map((p) => p.key);

    for (const voterKey of voterKeys) {
      for (const project of PROJECTS) {
        // Deterministic participation: roughly 55% of voters pick each project.
        const roll = (voterKey.length * 31 + project.key.length * 13 + project.quality) % 100;
        if (roll > 55) continue;
        const teamKey = project.team;
        const team = TEAMS.find((t) => t.key === teamKey) as TeamSpec;
        if (team.members.includes(voterKey)) continue;
        db.exec(
          `INSERT INTO community_votes (id, event_id, submission_id, user_id, weight, ip_hash, user_agent, created_at, updated_at)
           VALUES (:id, :e, :s, :u, 1, :ip, :ua, :at, :at)`,
          {
            id: newId('communityVote'),
            e: eventId,
            s: projectIds.get(project.key) as string,
            u: userIds.get(voterKey) as string,
            ip: sha256Hex(`seed:${voterKey}`).slice(0, 32),
            ua: 'seeded demo client',
            at: at(80 + (voteCount % 30) * 0.5),
          },
        );
        voteCount += 1;
      }
    }

    /* -------------------------------------------------------- comments */
    const commentPairs: [string, string, string][] = [
      ['p_halide', 'p_aiko', 'Watched this run on a Pi 3 as well — 2.4s per frame here. Genuinely useful in the field.'],
      ['p_ember', 'p_dev', 'The single-file artefact is the right call. I lost two runs to a dead laptop last year and this would not have happened.'],
      ['p_terrace', 'p_greta', 'The text mode carried more information than most dashboards I have used with a full connection.'],
      ['p_lattice', 'p_iris', 'Refusing the query with a reason is worth more than a fast answer. We lost a week to a unit bug.'],
      ['p_beacon', 'p_omar', 'Deploy correlation is the feature I did not know I needed until I saw it.'],
      ['p_vellum', 'p_sofia', 'Contrast as a build constraint changed how our team argues about colour. In a good way.'],
    ];
    for (const [projectKey, authorKey, body] of commentPairs) {
      db.exec(
        `INSERT INTO comments (id, event_id, submission_id, user_id, body, state, created_at, updated_at)
         VALUES (:id, :e, :s, :u, :body, 'VISIBLE', :at, :at)`,
        { id: newId('comment'), e: eventId, s: projectIds.get(projectKey) as string, u: userIds.get(authorKey) as string, body, at: at(84 + commentPairs.findIndex((p) => p[0] === projectKey)) },
      );
    }

    /* ---------------------------------------------------------- webhooks */
    db.exec(
      `INSERT INTO webhooks (id, event_id, url, description, secret, subscriptions, state, created_by, created_at, updated_at)
       VALUES (:id, :e, 'https://hooks.hackathonraptors.dev/verdict', 'Results and judging events to the Raptors status page.', :secret, :subs, 'ACTIVE', :by, :at, :at)`,
      {
        id: newId('webhook'),
        e: eventId,
        secret: sha256Hex('dogfood-2026-webhook-secret'),
        subs: JSON.stringify(['results.published', 'results.finalized', 'score.submitted', 'judging.completed']),
        by: userIds.get('organizer') as string,
        at: at(-40),
      },
    );
  });

  /* ------------------------------------- results, via the real pipeline */
  const organizerCtx = actorContext({
    actor: {
      id: userIds.get('organizer') as string,
      roles: ['ORGANIZER', 'PARTICIPANT'],
      roleEventIds: { ORGANIZER: [eventId], PARTICIPANT: [eventId], JUDGE: [], ADMIN: [] },
      eventIds: [eventId],
      state: 'ACTIVE',
    },
    requestId: 'seed',
    ipAddress: '127.0.0.1',
    userAgent: 'seed',
    at: at(122),
  });

  const diagnostics = services.results.recordDiagnostics(eventId, organizerCtx);

  // The published snapshot uses RAW scoring, so the raw ranking is what the
  // public sees and the normalized ranking is available as a comparison.
  const run = services.results.compute(eventId, { normalization: configForMethod('RAW'), aggregation: DEFAULT_AGGREGATION_CONFIG, enablePairwise: true, notes: 'Dogfood 2026 — published ranking, raw scores with a full audit trail.' }, organizerCtx);
  services.results.finalize(eventId, run, { persistNormalization: true }, organizerCtx);
  const snapshot = services.results.createSnapshot(eventId, run.id, {}, organizerCtx);
  services.results.publish(eventId, snapshot.id, organizerCtx);

  services.results.recordDiagnostics(eventId, organizerCtx);
  services.certificates.issueForEvent(eventId, { includeJudges: true, snapshotId: snapshot.id }, organizerCtx);

  // A normalization comparison run, stored so the organizer screen has data.
  services.results.normalizationComparison(eventId, 'ROBUST_MAD', organizerCtx);

  logger.info('seed complete', {
    eventId,
    users: PEOPLE.length,
    projects: PROJECTS.length,
    reviews: reviewCount,
    signals: diagnostics.signals.length,
  });

  return {
    users: PEOPLE.length,
    teams: TEAMS.length,
    submissions: PROJECTS.length,
    judges: JUDGE_SPECS.length,
    reviews: reviewCount,
    votes: voteCount,
    signals: diagnostics.signals.length,
    snapshots: 1,
    certificates: db.value<number>('SELECT COUNT(*) AS c FROM certificates') ?? 0,
    credentials: [
      { role: 'ADMIN', email: 'admin@hackathonraptors.dev', password: DEMO_PASSWORD },
      { role: 'ORGANIZER', email: 'organizer@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'JUDGE (generous)', email: 'amara@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'JUDGE (harsh)', email: 'ben@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'JUDGE (low variance)', email: 'priya@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'JUDGE (broad spread)', email: 'tomas@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'JUDGE (2 unfinished)', email: 'yuki@dogfood.dev', password: DEMO_PASSWORD },
      { role: 'PARTICIPANT', email: 'iris@dogfood.dev', password: DEMO_PASSWORD },
    ],
  };
}

/* ------------------------------------------------------------- helpers */

function clampToScale(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function commentFor(project: ProjectSpec, criterionKey: string, value: number): string {
  const strong = value >= 7.5;
  const weak = value < 5;
  const notes: Record<string, string[]> = {
    technical: [
      `Ran it locally. The ${project.technologies[0] ?? 'main'} path is clean and the error handling is better than most production code I review.`,
      `The core algorithm is right. The build is missing a lockfile, which will bite whoever deploys this next.`,
      `Works, but the failure modes are undocumented and I had to read the source to find out what happens on a bad input.`,
    ],
    innovation: [
      `Not a new idea, but an unusually well-judged execution of it. The team clearly knew what to cut.`,
      `I have not seen this framing before. The insight is doing real work, not decorating an obvious implementation.`,
      `Competent, and comparable to things that already exist. Nothing here surprised me.`,
    ],
    impact: [
      `I would actually use this. The problem is narrow and real, and the team is honest about its limits.`,
      `Useful, assuming the team it is for exists in numbers. The README should say who that is.`,
      `Hard to judge impact from a weekend. The direction looks sensible; the reach is unclear.`,
    ],
    experience: [
      `Empty states, error copy, keyboard navigation: all handled. Rare, and it shows.`,
      `The interface is calm and the loading states are honest. Small thing: the contrast on the secondary text is low.`,
      `Functional, and a little rough. I could not tell whether a save had succeeded without reloading.`,
    ],
  };
  const pool = notes[criterionKey] ?? ['No comment.'];
  if (weak) return pool[2] as string;
  if (strong) return pool[strong ? 0 : 1] as string;
  return pool[1] as string;
}

export { addSeconds };

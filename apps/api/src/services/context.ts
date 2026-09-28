/**
 * The service container.
 *
 * Services are constructed once at boot in dependency order and reach each
 * other through this object rather than through constructor arguments. That
 * keeps the wiring in one readable place, avoids a combinatorial explosion of
 * constructor signatures, and makes the dependency graph obvious to the next
 * maintainer: the `createServices` function below *is* the graph.
 */

import type { AppConfig } from '../config.ts';
import { Database } from '../db/database.ts';
import { AuditLedger } from '../lib/audit.ts';
import { createLogger, type Logger } from '../lib/logger.ts';
import { AuthService } from '../lib/auth.ts';
import { now, type Instant } from '@verdict/core/time';
import type { Actor } from '../lib/rbac.ts';
import { errors } from '../lib/errors.ts';

import { EventService } from './event-service.ts';
import { RegistrationService } from './registration-service.ts';
import { TeamService } from './team-service.ts';
import { UploadService } from './upload-service.ts';
import { SubmissionService } from './submission-service.ts';
import { GalleryService } from './gallery-service.ts';
import { JudgeService } from './judge-service.ts';
import { AssignmentService } from './assignment-service.ts';
import { RubricService } from './rubric-service.ts';
import { ScoringService } from './scoring-service.ts';
import { ResultService } from './result-service.ts';
import { CommunityService } from './community-service.ts';
import { CertificateService } from './certificate-service.ts';
import { WebhookService } from './webhook-service.ts';
import { TransferService } from './transfer-service.ts';

export type ActorContext = {
  actor: Actor | null;
  requestId: string;
  ipAddress: string;
  userAgent: string;
  at: Instant;
};

export function actorContext(input: {
  actor: Actor | null;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
  at?: Instant;
}): ActorContext {
  return {
    actor: input.actor,
    requestId: input.requestId,
    ipAddress: input.ipAddress ?? '',
    userAgent: input.userAgent ?? '',
    at: input.at ?? now(),
  };
}

/**
 * The signed-in actor, or a 401.
 *
 * This threw a plain `Error` before, which no branch of `toApiError` maps, so it
 * surfaced as `INTERNAL_ERROR` / 500. Three operations - a judge accepting an
 * invitation, an organizer's judge transition, and declaring a conflict - reach
 * `requireActor` as their first line, so an anonymous caller got a 500 from all
 * three. A 500 says "this deployment is broken" and trips alerting; the truth is
 * that the caller is not signed in, which is a 401 and a client's job to handle.
 */
export function requireActor(ctx: ActorContext): Actor {
  if (ctx.actor === null) {
    throw errors.unauthenticated('Sign in to continue.');
  }
  return ctx.actor;
}

/** Standard list-query shape, shared by every paginated endpoint. */
export type ListQuery = {
  page: number;
  perPage: number;
  limit: number;
  offset: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
};

/** Escape LIKE wildcards so a search for "100%" does not match everything. */
export function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export const LIKE_ESCAPE = "ESCAPE '\\'";

/* ------------------------------------------------------------ container */

/** The collaborators every service receives: infrastructure, no siblings. */
export type ServiceBase = {
  config: AppConfig;
  db: Database;
  logger: Logger;
  audit: AuditLedger;
  auth: AuthService;
};

export type Services = ServiceBase & {
  events: EventService;
  registrations: RegistrationService;
  teams: TeamService;
  uploads: UploadService;
  submissions: SubmissionService;
  gallery: GalleryService;
  judges: JudgeService;
  assignments: AssignmentService;
  rubrics: RubricService;
  scoring: ScoringService;
  results: ResultService;
  community: CommunityService;
  certificates: CertificateService;
  webhooks: WebhookService;
  transfer: TransferService;
};

export type ServiceOptions = {
  config: AppConfig;
  db: Database;
  logger?: Logger;
  /** Skip seeding the default rubric/track templates; used by tests. */
  minimal?: boolean;
};

export function createServices(options: ServiceOptions): Services {
  const { config, db } = options;
  const logger = options.logger ?? createLogger({ level: config.logging.level, pretty: config.logging.pretty });
  const audit = new AuditLedger(db, logger);
  const auth = new AuthService(
    db,
    audit,
    logger,
    { idleTimeoutDays: config.session.idleTimeoutDays, absoluteTimeoutDays: config.session.absoluteTimeoutDays },
  );

  const base = { config, db, logger, audit, auth };

  /**
   * Services receive the whole container so they can reach their siblings
   * without a combinatorial constructor explosion. `EventService` is the one
   * exception: it has no sibling dependencies, so it is built first from the
   * base and the container is then assembled around it. No service touches a
   * sibling at construction time, so the partially-populated object is never
   * observed.
   */
  const events = new EventService(base);
  const services = {
    ...base,
    events,
    registrations: undefined,
    teams: undefined,
    uploads: undefined,
    submissions: undefined,
    gallery: undefined,
    judges: undefined,
    assignments: undefined,
    rubrics: undefined,
    scoring: undefined,
    results: undefined,
    community: undefined,
    certificates: undefined,
    webhooks: undefined,
    transfer: undefined,
  } as unknown as Services;

  /*
   * Order matters. A service that takes `services` in its constructor captures
   * its collaborators *at that moment*, so anything it reads during
   * construction is frozen. `GalleryService` reads `community.tally()` to show
   * vote counts on a card, and `ResultService` publishes through
   * `webhooks` — so both of those have to exist before them.
   *
   * Getting this wrong is silent: the container type-checks, every unit test
   * passes, and the gallery throws a TypeError on the first real request
   * because it is holding `undefined`.
   */
  services.registrations = new RegistrationService(services);
  services.teams = new TeamService(services);
  services.uploads = new UploadService(services);
  services.submissions = new SubmissionService(services);
  // Community first: the gallery reads vote tallies when it builds a card.
  services.community = new CommunityService(services);
  // Webhooks before results and certificates: both publish through them.
  services.webhooks = new WebhookService(services);
  services.gallery = new GalleryService(services);
  services.judges = new JudgeService(services);
  services.assignments = new AssignmentService(services);
  services.rubrics = new RubricService(services);
  services.scoring = new ScoringService(services);
  services.results = new ResultService(services);
  services.certificates = new CertificateService(services);
  services.transfer = new TransferService(services);

  // Wire the optional collaborators now that both sides exist.
  services.certificates.attachWebhooks(services.webhooks);
  services.gallery.setPublicUrl(config.publicUrl);
  services.community.setIpSalt(config.session.secret);

  void options.minimal;
  return services;
}

/**
 * Public gallery.
 *
 * Read-only and heavily cached in intent: this is the page that gets scraped,
 * shared and hit hardest, so it does no joins it does not need and never
 * exposes anything the event has not published.
 *
 * Vote totals are shown only when the event says they may be. When totals are
 * hidden, the endpoint returns a *count-free* shape rather than a count the
 * client is trusted not to display — otherwise "hidden" is a CSS decision
 * someone can trivially bypass with devtools.
 */

import { NORMALIZATION_METHODS, AGGREGATION_METHODS } from '@verdict/core/types';
import type { NormalizationMethod, AggregationMethod } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';

export type GalleryQuery = {
  search?: string;
  trackId?: string;
  technology?: string;
  teamId?: string;
  limit: number;
  offset: number;
  sort?: 'GALLERY' | 'NAME' | 'SUBMISSION' | 'VOTES';
};

export class GalleryService {
  private readonly db: Services['db'];
  private readonly events: Services['events'];
  private readonly submissions: Services['submissions'];
  private readonly community: Services['community'];

  constructor(services: Services) {
    this.db = services.db;
    this.events = services.events;
    this.submissions = services.submissions;
    this.community = services.community;
  }

  /** Every technology in use, for the filter UI. */
  technologies(eventId: string): { technology: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const row of this.db.all<{ technologies: string }>(
      "SELECT technologies FROM submissions WHERE event_id = :e AND state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED') AND withdrawn = 0",
      { e: eventId },
    )) {
      for (const technology of safeArray(row.technologies)) {
        counts.set(technology, (counts.get(technology) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([technology, count]) => ({ technology, count }))
      .sort((a, b) => b.count - a.count || a.technology.localeCompare(b.technology));
  }

  list(eventId: string, query: GalleryQuery, ctx: ActorContext) {
    const event = this.events.require(eventId);

    // Unlisted events are reachable by direct link; private ones are not.
    if (event.gallery_visibility === 'PRIVATE' && !this.mayViewPrivate(ctx, eventId)) {
      throw errors.notFound('Event gallery', eventId);
    }

    const conditions = [
      's.event_id = :e',
      's.withdrawn = 0',
      's.gallery_visible = 1',
      "s.state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')",
    ];
    const params: Record<string, string | number> = { e: eventId, limit: query.limit, offset: query.offset };

    if (query.search) {
      conditions.push(
        "(LOWER(s.project_name) LIKE :search ESCAPE '\\' OR LOWER(s.short_description) LIKE :search ESCAPE '\\' OR LOWER(s.full_description) LIKE :search ESCAPE '\\' OR LOWER(s.technologies) LIKE :search ESCAPE '\\')",
      );
      params.search = `%${query.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    if (query.trackId) {
      conditions.push('s.track_id = :track');
      params.track = query.trackId;
    }
    if (query.teamId) {
      conditions.push('s.team_id = :team');
      params.team = query.teamId;
    }
    if (query.technology) {
      // technologies is a JSON array of strings; match the quoted element so
      // "Go" does not match "Google Cloud".
      conditions.push("LOWER(s.technologies) LIKE :tech ESCAPE '\\'");
      params.tech = `%"${query.technology.toLowerCase().replace(/[%_\\"]/g, '')}"%`;
    }

    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM submissions s ${clause}`, params) ?? 0;

    const rows = this.db.all<{
      id: string; slug: string; project_name: string; short_description: string; full_description: string;
      problem: string; solution: string; technologies: string; repository_url: string | null; demo_url: string | null;
      video_url: string | null; documentation_url: string | null; cover_image_url: string | null;
      team_id: string | null; track_id: string | null; submitted_at: string; created_at: string;
    }>(`SELECT s.* FROM submissions s ${clause}`, params);

    const ordered = this.order(rows, event, query, eventId, ctx.at);
    const page = ordered.slice(query.offset, query.offset + query.limit);
    const voteCounts = this.community.tally(eventId);

    return {
      data: page.map((row) => this.toCard(eventId, row, voteCounts, event.voting_reveal_totals === 1, event.voting_enabled === 1)),
      pagination: {
        page: Math.floor(query.offset / query.limit) + 1,
        perPage: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
        hasMore: query.offset + query.limit < total,
      },
      ordering: {
        mode: query.sort ?? event.gallery_order,
        note: 'Randomized ordering is stable for the day: a shared link shows every visitor the same sequence.',
      },
    };
  }

  detail(eventId: string, slugOrId: string, ctx: ActorContext) {
    const event = this.events.require(eventId);
    if (event.gallery_visibility === 'PRIVATE' && !this.mayViewPrivate(ctx, eventId)) {
      throw errors.notFound('Project', slugOrId);
    }

    const row =
      this.submissions.findBySlug(eventId, slugOrId) ??
      (this.submissions.findById(slugOrId)?.event_id === eventId ? this.submissions.findById(slugOrId) : null);

    if (row === null || row.withdrawn === 1 || row.gallery_visible === 0) {
      // A hidden project is reported as missing rather than forbidden, so the
      // response does not confirm that a hidden slug exists.
      throw errors.notFound('Project', slugOrId);
    }
    if (!['SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'].includes(row.state)) {
      throw errors.notFound('Project', slugOrId);
    }

    const voteCounts = this.community.tally(eventId);
    const team = row.team_id
      ? this.db.get('SELECT id, name, slug, description, organization FROM teams WHERE id = :id', { id: row.team_id })
      : null;
    const members = row.team_id
      ? this.db.all('SELECT u.display_name AS displayName, u.username, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = :t', { t: row.team_id })
      : [];
    const track = row.track_id ? this.db.get('SELECT id, name, slug, color FROM event_tracks WHERE id = :id', { id: row.track_id }) : null;
    const screenshots = this.submissions.screenshots(row.id);

    return {
      id: row.id,
      slug: row.slug,
      projectName: row.project_name,
      shortDescription: row.short_description,
      fullDescription: row.full_description,
      problem: row.problem,
      solution: row.solution,
      technologies: safeArray(row.technologies),
      repositoryUrl: row.repository_url,
      demoUrl: row.demo_url,
      videoUrl: row.video_url,
      documentationUrl: row.documentation_url,
      coverImageUrl: row.cover_image_url,
      submittedAt: row.submitted_at,
      team,
      members,
      track,
      screenshots: screenshots.map((upload) => ({
        id: upload.id,
        url: `/api/uploads/${upload.id}`,
        width: upload.width,
        height: upload.height,
      })),
      votes: this.community.totalsVisible(eventId)
        ? { count: voteCounts.get(row.id) ?? 0, mine: false }
        : { hidden: true as const },
    };
  }

  /** Compact payload for the embeddable widget. */
  embedPayload(eventId: string, limit: number, ctx: ActorContext) {
    const event = this.events.require(eventId);
    if (event.gallery_visibility === 'PRIVATE') throw errors.notFound('Event gallery', eventId);
    const voteCounts = this.community.tally(eventId);
    const rows = this.db.all<{
      id: string; slug: string; project_name: string; short_description: string; technologies: string;
      repository_url: string | null; demo_url: string | null; cover_image_url: string | null; track_id: string | null;
    }>(
      `SELECT id, slug, project_name, short_description, technologies, repository_url, demo_url, cover_image_url, track_id
       FROM submissions
       WHERE event_id = :e AND withdrawn = 0 AND gallery_visible = 1
         AND state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
       ORDER BY submitted_at LIMIT :limit`,
      { e: eventId, limit: Math.min(200, Math.max(1, limit)) },
    );
    const tracks = new Map(this.events.listTracks(eventId).map((track) => [track.id, track]));

    return {
      event: { id: event.id, name: event.name, tagline: event.tagline, slug: event.slug },
      projects: rows.map((row) => ({
        id: row.id,
        name: row.project_name,
        summary: row.short_description,
        technologies: safeArray(row.technologies),
        url: `${this.config_publicUrl(ctx)}/events/${event.slug}/projects/${row.slug}`,
        repositoryUrl: row.repository_url,
        demoUrl: row.demo_url,
        imageUrl: row.cover_image_url ? `${this.config_publicUrl(ctx)}/api/uploads/${row.cover_image_url.replace(/^.*\//, '')}` : null,
        track: row.track_id ? (tracks.get(row.track_id)?.name ?? null) : null,
        votes: event.voting_reveal_totals === 1 ? (voteCounts.get(row.id) ?? 0) : undefined,
      })),
    };
  }

  private order<T extends { id: string; project_name: string; submitted_at: string; created_at: string }>(
    rows: T[],
    event: { gallery_order: string },
    query: GalleryQuery,
    eventId: string,
    at: string,
  ): T[] {
    const mode = query.sort ?? event.gallery_order;
    if (mode === 'VOTES') {
      const counts = this.community.tally(eventId);
      return [...rows].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.project_name.localeCompare(b.project_name));
    }
    return this.submissions.orderForGallery(
      rows as unknown as Parameters<Services['submissions']['orderForGallery']>[0],
      mode as 'RANDOMIZED' | 'ALPHABETICAL' | 'SUBMISSION' | 'VOTES',
      eventId,
      at,
    ) as unknown as T[];
  }

  private toCard(
    _eventId: string,
    row: {
      id: string; slug: string; project_name: string; short_description: string; technologies: string;
      repository_url: string | null; demo_url: string | null; video_url: string | null; cover_image_url: string | null;
      team_id: string | null; track_id: string | null; submitted_at: string;
    },
    voteCounts: Map<string, number>,
    revealVotes: boolean,
    votingEnabled: boolean,
  ) {
    const team = row.team_id ? this.db.get<{ name: string; slug: string }>('SELECT name, slug FROM teams WHERE id = :id', { id: row.team_id }) : null;
    const track = row.track_id ? this.db.get<{ name: string; color: string; slug: string }>('SELECT name, color, slug FROM event_tracks WHERE id = :id', { id: row.track_id }) : null;
    return {
      id: row.id,
      slug: row.slug,
      projectName: row.project_name,
      shortDescription: row.short_description,
      technologies: safeArray(row.technologies),
      repositoryUrl: row.repository_url,
      demoUrl: row.demo_url,
      videoUrl: row.video_url,
      coverImageUrl: row.cover_image_url,
      team,
      track,
      submittedAt: row.submitted_at,
      ...(votingEnabled && revealVotes ? { votes: voteCounts.get(row.id) ?? 0 } : {}),
    };
  }

  private mayViewPrivate(ctx: ActorContext, eventId: string): boolean {
    if (ctx.actor === null) return false;
    return ctx.actor.roles.includes('ADMIN') || ctx.actor.eventIds.includes(eventId);
  }

  private config_publicUrl(_ctx: ActorContext): string {
    return this.publicUrl;
  }

  private publicUrl = '';

  setPublicUrl(url: string): void {
    this.publicUrl = url.replace(/\/+$/, '');
  }
}

function safeArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export { NORMALIZATION_METHODS, AGGREGATION_METHODS };
export type { NormalizationMethod, AggregationMethod };

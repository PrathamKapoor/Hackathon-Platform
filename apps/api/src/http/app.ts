/**
 * Fastify application assembly.
 *
 * Order matters here and each step is deliberate:
 *
 *   1. logging + request ids      so every later line can be correlated
 *   2. security headers            before anything can produce a response
 *   3. body limits                 before a handler can read a huge body
 *   4. context hook                so CSRF and permissions can see the actor
 *   5. rate limiting               after identity, so it can key on the account
 *   6. CSRF + origin guard        globally, never per route
 *   7. routes
 *   8. error rendering            last, so it catches everything above
 *
 * `buildApp` returns a configured instance without listening, which is what
 * lets the test suite drive the whole API in-process.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { createServices, type Services } from '../services/context.ts';
import { loadConfig, type AppConfig } from '../config.ts';
import { Database } from '../db/database.ts';
import { createLogger } from '../lib/logger.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RateLimiter, buildContext, csrfGuard, installErrorHandler, installNotFoundHandler, newRequestId, notFoundBody, RouteRegistry } from './context.ts';
import { buildOpenApiDocument } from './openapi.ts';
import {
  registerAuthRoutes,
  registerEventRoutes,
  registerMetaRoutes,
  registerProfileRoutes,
  appVerdictVersion,
} from './routes.ts';
import {
  registerCertificateRoutes,
  registerCommunityRoutes,
  registerJudgingRoutes,
  registerOpsRoutes,
  registerRegistrationRoutes,
  registerResultRoutes,
  registerSubmissionRoutes,
  registerTeamRoutes,
  registerTransferRoutes,
  registerUploadRoutes,
  registerGalleryRoutes,
  registerWebhookRoutes,
} from './routes-operations.ts';

export type BuiltApp = {
  app: FastifyInstance;
  services: Services;
  db: Database;
  config: AppConfig;
  registry: RouteRegistry;
  close: () => Promise<void>;
};

export type BuildOptions = {
  config?: AppConfig;
  db?: Database;
  /** Skip migrations (the caller already applied them). */
  skipMigrate?: boolean;
};

export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? new Database(config.databaseFile);

  if (!options.skipMigrate) db.migrate();

  const logger = createLogger({ level: config.logging.level, pretty: config.logging.pretty });
  const services = createServices({ config, db, logger });
  const registry = new RouteRegistry();

  const app: FastifyInstance = Fastify({
    // Fastify's own logger is off entirely: the access-log hook below writes
    // every request through our logger, where it can be correlated with the
    // audit ledger by request id. Because there is no logger, there are also no
    // per-request log lines to suppress, so `disableRequestLogging` — which
    // Fastify 5 has deprecated in favour of `logController` — is not needed.
    logger: false,
    bodyLimit: config.security.maxJsonBodyBytes,
    trustProxy: config.trustProxy,
    /*
     * Explicit, rather than relying on Node's header size cap, so an oversized
     * request is refused by us with a clear message.
     *
     * `maxParamLength` is a `find-my-way` router option, and Fastify 5 wants it
     * nested under `routerOptions`. Passing it at the top level still works but
     * emits FSTDEP022 on every boot and will be removed in Fastify 6.
     */
    routerOptions: { maxParamLength: 256 },
    genReqId: () => newRequestId(),
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false, allErrors: true } },
  });

  app.decorate('services', { ...services, services } as never);

  /* ------------------------------------------------------------- plugins */

  await app.register(cookie, { secret: config.session.secret });

  await app.register(helmet, {
    // The API serves JSON; the SPA is same-origin. A strict CSP here would be
    // correct but the static handler below sets the real policy.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // Allow the embeddable widget to be framed by external event sites.
    frameguard: { action: 'sameorigin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.env === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.security.maxUploadBytes,
      files: 1,
      fields: 20,
      // Parts are streamed and discarded past the limit rather than buffered.
      parts: 25,
    },
  });


  /* ------------------------------------------------- request context hook */

  app.addHook('onRequest', (request, _reply, done) => {
    request.ctx = buildContext(request, { config, db, auth: services.auth, audit: services.audit, logger, services: services as never });
    done();
  });

  /* --------------------------------------------------------- rate limiting */

  /**
   * Rate limiting is implemented here rather than with `@fastify/rate-limit`
   * for two reasons.
   *
   * The key must be the *account* once one is identified. A per-IP limit is
   * trivially evaded with a rotating address, and it punishes shared NAT
   * (universities, mobile carriers) where a whole cohort of legitimate judges
   * sits behind one address.
   *
   * And the plugin's default rejection path throws, which the error handler
   * then renders as a 500. A rate-limited request is the server working
   * correctly, and reporting it as a server fault sends operators hunting for
   * a bug that does not exist.
   *
   * Budgets, in order of precedence:
   *   - `config.rateLimit: false` opts a route out entirely, so a liveness
   *     probe still answers while the process is shedding load;
   *   - `config.rateLimit: { max, timeWindow }` gives a route its own budget,
   *     which is how password reset gets a much tighter limit than sign-in;
   *   - otherwise the category default for auth and vote routes, and the
   *     global budget for everything else.
   */
  const defaultLimiters = {
    global: new RateLimiter(config.security.rateLimitMax, config.security.rateLimitWindowMs),
    auth: new RateLimiter(config.security.authRateLimitMax, config.security.authRateLimitWindowMs),
    vote: new RateLimiter(config.security.voteRateLimitMax, config.security.voteRateLimitWindowMs),
  } as const;

  // Per-route limiters are built once and reused: allocating one per request
  // would hand every client a fresh budget, which is worse than no limit at all.
  const routeLimiters = new Map<string, RateLimiter>();
  const limiterFor = (key: string, max: number, windowMs: number): RateLimiter => {
    const cacheKey = `${key}:${String(max)}:${String(windowMs)}`;
    let limiter = routeLimiters.get(cacheKey);
    if (limiter === undefined) {
      limiter = new RateLimiter(max, windowMs);
      routeLimiters.set(cacheKey, limiter);
    }
    return limiter;
  };

  app.addHook('onRequest', (request, reply, done) => {
    const override = (request.routeOptions.config as { rateLimit?: false | { max: number; timeWindow: number } }).rateLimit;
    if (override === false) {
      done();
      return;
    }

    let limiter: RateLimiter;
    if (override !== undefined && override !== null && typeof override === 'object') {
      // Keyed on the request path plus the budget itself, so two routes that
      // happen to name the same numbers share a limiter and two routes that
      // differ never do. `request.routeOptions.url` is typed as possibly
      // undefined (it is absent on a 404), and `request.url` is not.
      limiter = limiterFor(request.url, override.max, override.timeWindow);
    } else if (request.url.startsWith('/api/auth/')) {
      limiter = defaultLimiters.auth;
    } else if (request.method === 'POST' && /\/votes?\b|\/pairwise\b/.test(request.url)) {
      limiter = defaultLimiters.vote;
    } else {
      limiter = defaultLimiters.global;
    }

    const actorId = request.ctx.actor?.id;
    const key = actorId === undefined ? `ip:${request.ctx.ipAddress}` : `user:${actorId}`;
    const verdict = limiter.check(key, Date.now());

    reply.header('x-ratelimit-limit', String(limiter.max));
    reply.header('x-ratelimit-remaining', String(verdict.remaining));
    if (!verdict.allowed) {
      reply.header('retry-after', String(Math.max(1, verdict.retryAfterSeconds)));
      reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Try again in about ${String(verdict.retryAfterSeconds)} second(s).`,
          requestId: request.id,
        },
      });
      return;
    }
    done();
  });

  /* ----------------------------------------------- CSRF + origin, globally */

  app.addHook('preHandler', csrfGuard);

  /* ------------------------------------------------------------- routes */

  registerMetaRoutes(app, services, registry);
  registerAuthRoutes(app, services, registry);
  registerProfileRoutes(app, services, registry);
  registerEventRoutes(app, services, registry);
  registerRegistrationRoutes(app, services, registry);
  registerTeamRoutes(app, services, registry);
  registerSubmissionRoutes(app, services, registry);
  registerGalleryRoutes(app, services, registry);
  registerUploadRoutes(app, services, registry);
  registerJudgingRoutes(app, services, registry);
  registerResultRoutes(app, services, registry);
  registerCommunityRoutes(app, services, registry);
  registerCertificateRoutes(app, services, registry);
  registerWebhookRoutes(app, services, registry);
  registerTransferRoutes(app, services, registry);
  registerOpsRoutes(app, services, registry);

  /* ------------------------------------------------------------ OpenAPI */

  const openApiDocument = buildOpenApiDocument({
    registry,
    version: appVerdictVersion,
    serverUrl: config.publicUrl,
  });

  app.get('/api/openapi.json', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(openApiDocument),
  );
  registry.register({
    method: 'GET', path: '/api/openapi.json', tags: ['meta'], auth: 'none',
    summary: 'OpenAPI 3.1 document, generated from the same Zod schemas that validate requests.',
  });

  app.get('/api/docs', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(renderDocs(openApiDocument)),
  );
  registry.register({
    method: 'GET', path: '/api/docs', tags: ['meta'], auth: 'none',
    summary: 'Human-browsable API reference, rendered from the OpenAPI document with no external assets.',
  });

  /* ------------------------------------------------ static SPA (optional) */

  // Exactly one error handler and one not-found handler, always. Which 404
  // handler gets installed depends on whether a web build is present, and the
  // SPA branch owns its own so a mistyped API path can still answer with JSON.
  installErrorHandler(app);

  const webBuild = await hasWebBuild(config);
  if (webBuild) {
    /*
     * The static plugin is scoped to /assets and given a one-year immutable
     * cache, because everything Vite emits there is content-hashed and a
     * self-hosted instance is often on a slow link.
     *
     * index.html is deliberately NOT served by the plugin. The plugin applies
     * its own cache headers *after* any setHeaders callback, so a per-file
     * exception is not expressible — and a long-lived index.html is precisely
     * the bug that makes a deploy look like it did not happen. It is read once
     * at boot and served below with an explicit no-cache instead.
     */
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: join(config.webDistDir, 'assets'),
      prefix: '/assets/',
      maxAge: '1y',
      immutable: true,
      decorateReply: false,
      setHeaders: (res) => {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
      },
    });

    const shell = await readFile(join(config.webDistDir, 'index.html'), 'utf8');

    /*
     * Serve the shell for any GET that is not an API path, so client-side
     * routing survives a reload or a shared link. Without this, a bookmarked
     * /e/slug/results 404s on first request and the product looks broken to
     * anyone who was sent a link.
     */
    app.get('/*', async (request, reply) => {
      // An unmatched /api or /assets path is a real 404. Answering it with the
      // shell would hand a client HTML where it expected JSON, which is far
      // harder to debug than a clean error.
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
        void reply.status(404).send(notFoundBody(request.method, request.url, request.id));
        return;
      }
      void reply
        .header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'strict-origin-when-cross-origin')
        .type('text/html; charset=utf-8')
        .send(shell);
    });
  } else {
    installNotFoundHandler(app);
  }

  /* ------------------------------------------------------------- logging */

  app.addHook('onResponse', (request, reply, done) => {
    const durationMs = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 500) {
      logger.error('request completed with a server error', {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs,
      });
    } else if (reply.statusCode >= 400) {
      logger.info('request rejected', {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs,
      });
    } else {
      logger.debug('request completed', {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs,
        actorId: request.ctx.actor?.id ?? null,
      });
    }
    done();
  });

  return {
    app,
    services,
    db,
    config,
    registry,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}



async function hasWebBuild(config: AppConfig): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  try {
    await access(`${config.webDistDir}/index.html`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A dependency-free API reference page.
 *
 * Deliberately hand-rolled rather than pulling a Swagger UI bundle: it keeps
 * the offline promise (no CDN), and it is small enough to read in one sitting.
 */
function renderDocs(document: Record<string, unknown>): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

  const paths = (document.paths ?? {}) as Record<string, Record<string, { summary?: string; tags?: string[]; description?: string; 'x-verdict-auth'?: string; 'x-verdict-permission'?: { resource: string; action: string } }>>;
  const byTag = new Map<string, { method: string; path: string; op: { summary?: string; description?: string; 'x-verdict-auth'?: string; 'x-verdict-permission'?: { resource: string; action: string } } }[]>();

  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const tag = (op.tags ?? ['other'])[0] as string;
      const list = byTag.get(tag) ?? [];
      list.push({ method: method.toUpperCase(), path, op });
      byTag.set(tag, list);
    }
  }

  const sections = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([tag, ops]) => `
    <section>
      <h2>${escape(tag)}</h2>
      ${ops
        .map(
          ({ method, path, op }) => `<div class="op">
        <div class="line"><span class="m m-${method.toLowerCase()}">${escape(method)}</span><code>${escape(path)}</code><span class="auth">${escape(op['x-verdict-auth'] ?? 'none')}</span>${op['x-verdict-permission'] ? `<span class="perm">${escape(op['x-verdict-permission'].resource)}:${escape(op['x-verdict-permission'].action)}</span>` : ''}</div>
        <p class="sum">${escape(op.summary ?? '')}</p>
        ${op.description ? `<p class="desc">${escape(op.description)}</p>` : ''}
      </div>`,
        )
        .join('\n      ')}
    </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verdict API reference</title>
<style>
  :root { color-scheme: dark; --bg:#0B0A12; --panel:#141126; --line:#2A2440; --text:#E9E6F5; --dim:#9A93B5; --accent:#B497CF; --purple:#5227FF; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing:-0.02em; }
  .lede { color: var(--dim); max-width: 62ch; margin: 0 0 32px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent); margin: 40px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .op { padding: 12px 14px; border:1px solid var(--line); border-radius: 10px; background: var(--panel); margin-bottom: 8px; }
  .line { display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
  .m { font: 600 11px/1 ui-monospace, monospace; letter-spacing: 0.06em; padding: 5px 7px; border-radius: 5px; }
  .m-get{background:#12304a;color:#7cc4ff} .m-post{background:#123a24;color:#63d68a} .m-patch{background:#3a2f10;color:#e0b64a}
  .m-put{background:#123a3a;color:#57d3c9} .m-delete{background:#3d1620;color:#ff8a9b}
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .auth, .perm { font: 11px ui-monospace, monospace; color: var(--dim); border:1px solid var(--line); border-radius:999px; padding: 3px 8px; }
  .perm { color: var(--accent); }
  .sum { margin: 8px 0 0; }
  .desc { margin: 6px 0 0; color: var(--dim); font-size: 13.5px; }
  a { color: var(--accent); }
</style>
</head><body><div class="wrap">
  <h1>Verdict API</h1>
  <p class="lede">Every UI action is available here. This document is generated from the same schemas that validate requests at runtime, so it cannot drift from the implementation. Machine-readable form: <a href="/api/openapi.json">/api/openapi.json</a>.</p>
  ${sections}
</div></body></html>`;
}

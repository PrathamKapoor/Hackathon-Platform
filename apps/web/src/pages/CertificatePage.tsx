import { Link, useParams } from 'react-router-dom';
import { useApi } from '../ui.tsx';
import { ErrorNotice, Loading, formatInstant, stateLabel } from '../ui.tsx';

/**
 * Public certificate verification.
 *
 * The API hands out `${PUBLIC_URL}/certificates/${reference}` when a
 * certificate is issued, but no route matched it, so every certificate link an
 * organizer shared with a team 404'd. Verification is the entire point of a
 * certificate — a recipient forwards the link to a prospective employer, and
 * they get the app's 404 page.
 *
 * The page shows what the server recomputed, not what the certificate claims.
 * `CertificateService.verify` re-derives the SHA-256 over the stored payload
 * and compares it to the recorded hash, so VALID means "the contents still
 * match what was issued", and TAMPERED is detectable by anyone holding the URL.
 */
export function CertificatePage() {
  const { reference } = useParams<{ reference: string }>();
  const path = reference === undefined ? null : `/api/certificates/${encodeURIComponent(reference)}`;

  const { data, error, loading } = useApi<{
    valid: boolean;
    status: 'VALID' | 'REVOKED' | 'TAMPERED' | 'NOT_FOUND';
    reference: string;
    kind: string;
    title: string;
    body: string;
    recipientName: string | null;
    event: { name: string; slug: string } | null;
    issuedAt: string;
    awardedAt: string | null;
    revokedAt: string | null;
    integrityHash: string;
    message: string;
  }>(path);

  if (loading) return <Loading label="Verifying certificate" />;

  if (error !== null) {
    return (
      <div className="page">
        <ErrorNotice error={error} />
      </div>
    );
  }
  if (data === null) return <Loading />;

  if (data.status === 'NOT_FOUND') {
    return (
      <div className="page">
        <h1>Certificate not found</h1>
        <div className="empty" style={{ marginTop: 16 }}>
          <div className="strong">No certificate matches that reference</div>
          <div className="small" style={{ marginTop: 6 }}>
            Check the code for typos. A certificate reference looks like <span className="mono">CRT-XXXXX-YYYYY</span>.
          </div>
        </div>
      </div>
    );
  }

  const tone =
    data.status === 'VALID' ? 'notice--ok' : data.status === 'REVOKED' ? 'notice--warn' : 'notice--error';

  return (
    <div className="page">
      <h1>Certificate</h1>

      <div className={`notice ${tone}`} style={{ marginTop: 16 }} role="status">
        <div className="row row--wrap" style={{ gap: 8 }}>
          <span className="strong">{data.status === 'VALID' ? 'Valid' : stateLabel(data.status)}</span>
          <span className="badge">{stateLabel(data.kind)}</span>
        </div>
        <p className="small" style={{ marginTop: 6 }}>
          {data.message}
        </p>
      </div>

      <section className="card card--pad" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: '1.15rem' }}>{data.title}</h2>
        {data.recipientName !== null ? (
          <p className="muted" style={{ marginTop: 6 }}>
            Awarded to <strong>{data.recipientName}</strong>
          </p>
        ) : null}
        {data.body.trim() !== '' ? (
          <p className="small" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
            {data.body}
          </p>
        ) : null}

        <dl className="small" style={{ marginTop: 18 }}>
          <Row label="Reference" value={data.reference} mono />
          <Row label="Event" value={data.event?.name ?? '—'} />
          <Row label="Issued" value={formatInstant(data.issuedAt)} />
          {data.awardedAt !== null ? <Row label="Awarded" value={formatInstant(data.awardedAt)} /> : null}
          {data.revokedAt !== null ? <Row label="Revoked" value={formatInstant(data.revokedAt)} /> : null}
          <Row label="Integrity hash" value={data.integrityHash} mono wrap />
        </dl>

        <p className="tiny dim" style={{ marginTop: 14 }}>
          The hash above is a SHA-256 over the certificate's stored contents. It is recomputed on every visit, which is why
          a certificate edited after issue reports as tampered rather than as valid.
        </p>
      </section>

      <div className="row row--wrap" style={{ gap: 8, marginTop: 20 }}>
        <a className="button button--primary" href={`/api/certificates/${encodeURIComponent(data.reference)}.svg`} target="_blank" rel="noreferrer noopener">
          View printable certificate
        </a>
        {data.event !== null ? (
          <Link className="button" to={`/e/${encodeURIComponent(data.event.slug)}`}>
            {data.event.name}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value, mono, wrap }: { label: string; value: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div
      className="row row--between"
      style={{ padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', alignItems: 'baseline' }}
    >
      <dt className="muted" style={{ margin: 0 }}>
        {label}
      </dt>
      <dd
        className={mono ? 'mono' : ''}
        style={{ margin: 0, textAlign: 'right', wordBreak: wrap === true ? 'break-all' : 'normal' }}
      >
        {value}
      </dd>
    </div>
  );
}

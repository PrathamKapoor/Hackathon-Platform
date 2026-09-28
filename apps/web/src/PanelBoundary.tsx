import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Without it, a single render error anywhere took down the entire application:
 * React unmounts the whole tree when no boundary catches, so one panel with a
 * bad data shape left the user staring at a blank page with no navigation, no
 * explanation, and no way back except a reload.
 *
 * That is not hypothetical. A mistyped `useApi` generic — declaring
 * `{ data: [...] }` as a bare array — made the organizer console's Results panel
 * throw `?.find is not a function`, and the consequence was that *every*
 * section of the console became unreachable, including the ones that were
 * working. A bug in one panel was a denial of service on the whole product.
 *
 * The boundary is placed per console panel rather than once around the app, so
 * the failure is contained to the section that broke: the navigation survives,
 * the other panels stay usable, and the organizer is told which section failed
 * and that it is safe to move away from it.
 */
type Props = { children: ReactNode; label: string };
type State = { error: Error | null };

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than swallowed: this is a programming error,
    // and the component stack is what makes it findable. There is no analytics
    // endpoint to report it to, by design.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <section className="card card--pad">
        <div className="notice notice--error" role="alert">
          <div className="strong">This section could not be displayed</div>
          <p className="small" style={{ marginTop: 6 }}>
            The <strong>{this.props.label}</strong> panel hit an error while rendering. The rest of the console is
            unaffected — use the navigation above to move to another section. The detail below is useful to whoever
            maintains this deployment.
          </p>
          <pre className="import-result">{error.message}</pre>
        </div>
        <button
          type="button"
          className="button"
          style={{ marginTop: 14 }}
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </section>
    );
  }
}

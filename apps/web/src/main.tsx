import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

/*
 * The provider order matters. `App` renders the navigation bar, and the bar
 * reads the session to decide whether to show "Sign in" or the user's name, so
 * `SessionProvider` has to sit above it. Without it the whole application throws
 * on first render and the page stays blank — which is exactly what happened,
 * and exactly what a browser test catches and an HTTP test cannot.
 */
createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
);

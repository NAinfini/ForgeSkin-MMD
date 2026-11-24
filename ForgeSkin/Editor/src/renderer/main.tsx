import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useCharacter } from './character/state';
import { useStore } from './store';
import { theme } from './theme';
import './styles.css';

// Dev only: lets the running app be driven from DevTools.
if (import.meta.env.DEV) Object.assign(window, { sf: useStore, sfCharacter: useCharacter });

// Renderer errors go to GTFO_UserData/logs/app.log with their stack. One that repeats (thrown every frame) is written the
// first time and then at 10, 100, 1000 … repeats with its count.
const stackOf = (e: unknown) =>
  e instanceof Error
    ? `${e.message}
${e.stack}`
    : String(e);
const seen = new Map<string, number>();
const log = (kind: string, text: string) => {
  const n = (seen.get(text) ?? 0) + 1;
  seen.set(text, n);
  if (n === 1) window.forge.appLog(kind, text);
  else if (/^10+$/.test(String(n))) window.forge.appLog(kind, `(repeated ${n} times) ${text}`);
};
window.addEventListener('error', (e) =>
  log(
    'renderer error',
    `${e.message} at ${e.filename}:${e.lineno}
${stackOf(e.error)}`,
  ),
);
window.addEventListener('unhandledrejection', (e) => log('renderer unhandledrejection', stackOf(e.reason)));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Notifications position="bottom-right" limit={4} className="toasts" />
      <App />
    </MantineProvider>
  </StrictMode>,
);
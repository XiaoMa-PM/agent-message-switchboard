// INPUT: The browser's document, fetch, setInterval and clock.
// OUTPUT: Starts the status page (app.js start); nothing exported.
// POS: Browser entry of the status page, kept apart so the tests can load app.js without starting it.
import { start } from './app.js';

start({ document, fetch: (url, init) => window.fetch(url, init), setInterval: (fn, ms) => window.setInterval(fn, ms), now: () => Date.now() });

/*
 * To Are.na · demo loader. Takes the real page's markup from ../index.html, so the demo always
 * shows the current tool, then loads its scripts with the simulations in between.
 */
(async () => {
  'use strict';
  /* Bumped with each release, so browsers fetch the new scripts instead of cached ones. */
  const VERSION = '2.0.1';
  const app = document.getElementById('app');
  const load = (src) =>
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${src}?v=${VERSION}`;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Couldn’t load ${src}`));
      document.body.appendChild(script);
    });
  try {
    const html = await (await fetch(`../index.html?v=${VERSION}`, { cache: 'no-cache' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const script of doc.querySelectorAll('script')) script.remove();
    app.replaceChildren(...[...doc.body.childNodes].map((node) => document.importNode(node, true)));
    for (const src of ['../export-kit.js', '../cosmos-export.js', '../pinterest-export.js', '../arena.js', 'mock-sources.js', 'demo.js', '../app.js']) {
      await load(src);
    }
  } catch {
    app.textContent = 'The demo needs a web address: open it from tanguycaruel.github.io/to-arena/demo/ rather than from a file.';
  }
})();

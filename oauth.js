/*
 * To Are.na · OAuth return page. Are.na redirects the popup here with `code` and `state`; this
 * hands them to the To Are.na tab that opened the popup (same address only), then closes. The
 * code is useless without the secret verifier kept by that tab.
 */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const message = { type: 'to-arena/oauth', code: params.get('code'), state: params.get('state'), error: params.get('error') };
  history.replaceState(null, '', location.pathname);
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(message, location.origin);
    window.close();
  }
  document.getElementById('message').textContent = 'You can close this window and go back to To Are.na.';
})();

/* 199X public site behavior. Loaded by every public page.
 *
 * The ONLY job here is the dev-gated "Enter Game" link. The public must not see
 * a way into the game yet, but devs testing on the prod server need one. So the
 * link ships hidden in the markup and we reveal it only when this looks like a
 * dev:
 *   - running on localhost / 127.0.0.1 (local dev), OR
 *   - the browser carries the dev flag in localStorage.
 * A dev arms a browser once by visiting any page with `?dev=1` (persisted);
 * `?dev=0` disarms it. No secret in the bundle, nothing the public stumbles into.
 */
(function () {
  try {
    var params = new URLSearchParams(location.search);
    if (params.get('dev') === '1') localStorage.setItem('eb_dev', '1');
    if (params.get('dev') === '0') localStorage.removeItem('eb_dev');

    var host = location.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    var armed = localStorage.getItem('eb_dev') === '1';

    if (isLocal || armed) {
      var link = document.getElementById('nav-game');
      if (link) link.hidden = false;
    }
  } catch (e) {
    /* private-mode / storage-blocked: just leave the game link hidden */
  }
})();

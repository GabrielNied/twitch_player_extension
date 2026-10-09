// Content script for twitch.tv. Twitch is a single-page app, so we watch for
// URL changes and let the background worker decide whether to redirect.
(() => {
  let last = '';

  function check() {
    if (location.href === last) return;
    last = location.href;
    chrome.runtime.sendMessage({ type: 'navigated', url: location.href }).catch(() => {});
  }

  check();
  addEventListener('popstate', check);
  setInterval(check, 500);
})();

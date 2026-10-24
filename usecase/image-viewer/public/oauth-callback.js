/*
 * The page ArcGIS sends the sign-in popup back to (the redirect URI of the
 * app registered in the portal). It hands the authorization code and state to
 * the viewer, which checks the state and exchanges the code (src/auth.ts):
 * over a BroadcastChannel of this origin (the opener may be in another
 * browsing context group when the viewer is cross-origin isolated), and with
 * postMessage to the opener, restricted to this origin. Then it removes the
 * code from its address and closes.
 */
/* global location, history, URLSearchParams, BroadcastChannel, window, document, addEventListener, setTimeout */
(function () {
  var params = new URLSearchParams(location.search);
  var message = {
    type: 'arcgis-oauth',
    state: params.get('state') || '',
    code: params.get('code') || undefined,
    error: params.get('error_description') || params.get('error') || undefined,
  };
  history.replaceState(null, '', location.pathname);
  if (message.state) {
    try {
      var channel = new BroadcastChannel('image-viewer-oauth');
      channel.postMessage(message);
      channel.close();
    } catch {
      // No BroadcastChannel: the opener below.
    }
    try {
      if (window.opener) window.opener.postMessage(message, location.origin);
    } catch {
      // The opener is gone.
    }
  }
  addEventListener('DOMContentLoaded', function () {
    document.getElementById('message').textContent = message.code ? 'サインイン完了。このウィンドウは閉じて問題なし。' : 'サインイン失敗。このウィンドウは閉じて問題なし。';
  });
  setTimeout(function () {
    window.close();
  }, 300);
})();

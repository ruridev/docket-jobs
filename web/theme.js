// Loaded before the stylesheet so the saved theme is applied before the first paint.
// The theme is kept in this browser only (like docket); none = follow the OS light/dark setting.
(function () {
  var THEMES = ['light', 'dark', 'green', 'g6'];
  var KEY = 'docket-jobs-theme';

  function apply(t) {
    var root = document.documentElement;
    if (THEMES.indexOf(t) >= 0) root.dataset.theme = t;
    else delete root.dataset.theme;
    // Only the green theme uses Google Fonts; load them the first time it is picked.
    if (t === 'green' && !document.getElementById('theme-fonts')) {
      var link = document.createElement('link');
      link.id = 'theme-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@200;300;500&family=IBM+Plex+Sans+KR:wght@400;600&family=Space+Mono&display=swap';
      document.head.appendChild(link);
    }
    try {
      if (THEMES.indexOf(t) >= 0) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the theme still applies until the page closes */ }
  }

  var saved = '';
  try {
    // Carry over a theme saved before the rename from b_jobs.
    var old = localStorage.getItem('bjobs-theme');
    if (old !== null) {
      if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, old);
      localStorage.removeItem('bjobs-theme');
    }
    saved = localStorage.getItem(KEY) || '';
  } catch (e) { /* ignore */ }
  apply(saved);
  window.docketJobsTheme = { THEMES: THEMES, apply: apply };
})();

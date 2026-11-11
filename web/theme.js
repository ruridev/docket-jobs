// Loaded before the stylesheet so the saved theme is applied before the first paint.
// The theme is kept in this browser only (like docket); none = follow the OS light/dark setting.
(function () {
  var THEMES = ['light', 'dark', 'green', 'g6'];
  var KEY = 'docket-jobs-theme';

  function apply(t) {
    var root = document.documentElement;
    if (THEMES.indexOf(t) >= 0) root.dataset.theme = t;
    else delete root.dataset.theme;
    try {
      if (THEMES.indexOf(t) >= 0) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the theme still applies until the page closes */ }
  }

  var saved = '';
  try {
    saved = localStorage.getItem(KEY) || '';
  } catch (e) { /* ignore */ }
  apply(saved);
  window.docketJobsTheme = { THEMES: THEMES, apply: apply };
})();

/* Theme switch.
 *
 * Loaded synchronously in <head> so the saved (or system) theme is applied
 * before the first paint. CSP only allows same-origin scripts, so this lives
 * in its own file rather than an inline snippet.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "unimatch-theme";
  var root = document.documentElement;
  var media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? "dark" : "light";
  }

  function themeColor(theme) {
    return theme === "dark" ? "#0d1512" : "#173e35";
  }

  function syncControls(theme) {
    var dark = theme === "dark";
    var hint = dark ? "Switch to light mode" : "Switch to dark mode";
    document.querySelectorAll('[data-action="toggle-theme"]').forEach(function (button) {
      button.setAttribute("aria-pressed", dark ? "true" : "false");
      button.setAttribute("aria-label", "Dark mode");
      button.setAttribute("title", hint);
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", themeColor(theme));
    }
  }

  function apply(theme, persist) {
    root.setAttribute("data-theme", theme);
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        /* Private browsing can block storage; the theme still applies. */
      }
    }
    syncControls(theme);
  }

  apply(storedTheme() || systemTheme(), false);

  document.addEventListener("DOMContentLoaded", function () {
    syncControls(root.getAttribute("data-theme") || "light");

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") {
        return;
      }
      var button = target.closest('[data-action="toggle-theme"]');
      if (!button) {
        return;
      }
      event.preventDefault();
      apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
    });

    if (media) {
      var followSystem = function (event) {
        if (!storedTheme()) {
          apply(event.matches ? "dark" : "light", false);
        }
      };
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", followSystem);
      } else if (typeof media.addListener === "function") {
        media.addListener(followSystem);
      }
    }
  });
})();

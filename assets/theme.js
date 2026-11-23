// Theme: dark by default, light on request. Load in <head> (not deferred) so the
// theme is set before first paint and the page never flashes white.
// The choice is saved under fde:theme. Printing always uses the light (paper) theme.
(function () {
  const KEY = "fde:theme";
  const root = document.documentElement;
  const saved = localStorage.getItem(KEY);
  root.dataset.theme = saved === "light" || saved === "dark" ? saved : "dark";

  function addToggle() {
    const nav = document.querySelector("nav.course");
    if (!nav || nav.querySelector(".theme-toggle")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme-toggle";
    const sync = () => {
      const dark = root.dataset.theme === "dark";
      b.textContent = dark ? "Light theme" : "Dark theme";
      b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    };
    b.addEventListener("click", () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem(KEY, root.dataset.theme);
      sync();
    });
    sync();
    nav.appendChild(b);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addToggle);
  else addToggle();
})();

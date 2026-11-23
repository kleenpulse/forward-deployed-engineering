// Scroll ring: a progress ring around a "Scroll" hint that doubles as a back-to-top button.
// It re-measures when the document's height changes, so the ring stays true as
// widgets render. It is also the way back up: a click scrolls to the top, and on
// hover or focus the label turns to "Top". At the top there is nowhere to go, so
// it stays a plain "Scroll" hint.
(function () {
  // Scroll (px) past which the page counts as away from the top.
  const AWAY_PX = 8;
  const SVG = "http://www.w3.org/2000/svg";

  function mount() {
    if (document.querySelector(".scroll-ring")) return;

    const frame = document.createElement("div");
    frame.className = "scroll-ring-frame";
    frame.innerHTML = `
      <button type="button" class="scroll-ring" aria-label="Scroll to top" aria-disabled="true">
        <svg aria-hidden="true" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="31" fill="none" stroke="currentColor" stroke-width="1" class="track"></circle>
          <circle cx="32" cy="32" r="31" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" pathLength="1" class="fill"></circle>
        </svg>
        <span class="label label-scroll">Scroll</span>
        <span class="label label-top">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>
          Top
        </span>
      </button>`;
    document.body.appendChild(frame);

    const button = frame.querySelector(".scroll-ring");
    const fill = frame.querySelector(".fill");
    const root = document.documentElement;

    const update = () => {
      const end = root.scrollHeight - innerHeight;
      const p = end > 0 ? Math.min(1, Math.max(0, scrollY / end)) : 0;
      // Nothing to scroll (short page, or a filtered table): fade the ring out.
      if (end > 0) delete frame.dataset.still;
      else frame.dataset.still = "";
      fill.style.strokeDasharray = `${p} 1`;
      // Round caps close the seam at 100%; hidden at 0 so they leave no dot.
      fill.style.opacity = p > 0 ? "1" : "0";
      const away = scrollY > AWAY_PX;
      button.setAttribute("aria-disabled", String(!away));
      if (away) button.dataset.away = "";
      else delete button.dataset.away;
    };

    button.addEventListener("click", () => {
      // Under reduced motion the jump is instant.
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });

    update();
    new ResizeObserver(update).observe(root);
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

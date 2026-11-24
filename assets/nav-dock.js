// Nav dock: once the course nav scrolls out of view, it moves into the left gutter as a
// stacked list, and moves back when its place in the column scrolls into view again.
// It docks only when the gutter is wide enough to hold the stacked list. The same <nav>
// element moves (no copy), so links, focus and landmarks stay single. Each link animates
// from where it was to where it lands (FLIP); under reduced motion it fades out and in.
(function () {
  // Room kept clear on the gutter's left (the scroll ring's 72px column) and right.
  const RAIL_PX = 72;
  const GAP_PX = 32;
  const DURATION = 600;
  const STAGGER = 35;
  const EASE = "cubic-bezier(.22, 1, .36, 1)";
  // Reduced motion: a quick fade out, then a slightly slower fade in.
  const FADE_OUT = 150;
  const FADE_IN = 250;

  function mount() {
    const nav = document.querySelector("nav.course");
    const main = document.querySelector("main");
    if (!nav || !main || nav.parentElement.classList.contains("nav-slot")) return;

    // The slot keeps the nav's place in the column (and is what we watch) while it is docked.
    const slot = document.createElement("div");
    slot.className = "nav-slot";
    nav.before(slot);
    slot.appendChild(nav);

    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let dockedWidth = 0;
    let offscreen = false;

    // Width of the stacked list, measured on a hidden copy so the real nav never flickers.
    const measure = () => {
      const probe = nav.cloneNode(true);
      probe.querySelector(".theme-toggle")?.remove();
      probe.dataset.docked = "";
      probe.dataset.probe = "";
      probe.setAttribute("aria-hidden", "true");
      document.body.appendChild(probe);
      dockedWidth = probe.offsetWidth;
      probe.remove();
    };

    const fits = () => main.getBoundingClientRect().left >= RAIL_PX + dockedWidth + GAP_PX;

    const links = () => [...nav.querySelectorAll("a")];

    const stop = (items) => items.forEach((a) => a.getAnimations().forEach((x) => x.cancel()));

    let labelOut = null;

    const apply = (dock) => {
      labelOut?.cancel();
      labelOut = null;
      if (dock === nav.hasAttribute("data-docked")) return;
      if (dock) {
        // Hold the column's height so the page below does not jump up.
        const cs = getComputedStyle(nav);
        slot.style.height = `${nav.getBoundingClientRect().height}px`;
        slot.style.marginBottom = cs.marginBottom;
        nav.dataset.docked = "";
      } else {
        delete nav.dataset.docked;
        slot.style.height = "";
        slot.style.marginBottom = "";
      }
    };

    // The state asked for last, and a counter so a stale fade never applies an old request.
    let want = false;
    let run = 0;

    const setDocked = (dock, animate) => {
      if (dock === want) return;
      want = dock;
      const id = ++run;
      const items = links();

      if (!animate) {
        stop(items);
        apply(dock);
        return;
      }

      // Reduced motion: no travel. The links fade out where they are, swap places while
      // hidden, then fade in where they land.
      if (reduce.matches) {
        const from = items.map((a) => getComputedStyle(a).opacity);
        stop(items);
        const out = items.map((a, i) =>
          a.animate([{ opacity: from[i] }, { opacity: 0 }], { duration: FADE_OUT, easing: "ease-in", fill: "forwards" }),
        );
        if (nav.hasAttribute("data-docked")) {
          labelOut?.cancel();
          labelOut = nav.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT, easing: "ease-in", fill: "forwards", pseudoElement: "::before" });
        }
        Promise.all(out.map((x) => x.finished))
          .then(() => {
            if (id !== run) return;
            stop(items);
            apply(dock);
            items.forEach((a) => a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN, easing: "ease-out" }));
          })
          .catch(() => {}); // Cancelled by a newer request.
        return;
      }

      const first = items.map((a) => a.getBoundingClientRect());
      stop(items);
      apply(dock);
      items.forEach((a, i) => {
        const last = a.getBoundingClientRect();
        if (!last.height) return;
        const s = first[i].height / last.height;
        const dx = first[i].left - last.left;
        const dy = first[i].top - last.top;
        a.animate(
          [
            { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${s})` },
            { transformOrigin: "0 0", transform: "none" },
          ],
          { duration: DURATION, delay: i * STAGGER, easing: EASE, fill: "backwards" },
        );
      });
    };

    const sync = (animate) => setDocked(offscreen && fits(), animate);

    // Docked only once the slot has left the top of the window, not while it is below it.
    // The first report is the page's starting state (e.g. a restored scroll): no animation.
    let seen = false;
    new IntersectionObserver(([entry]) => {
      offscreen = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sync(seen);
      seen = true;
    }).observe(slot);

    addEventListener("resize", () => sync(false));
    measure();
    // The stacked width depends on the web font; measure again once it has loaded.
    document.fonts?.ready.then(() => {
      measure();
      sync(false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

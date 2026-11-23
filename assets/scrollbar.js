// Scrollbar: a thin overlay thumb on the right edge, shown while the page scrolls.
// The native page scrollbar is hidden in course.css, so there is no gutter and the
// layout never shifts. The thumb is position: fixed and moves only with transform.
// It fades in on scroll, on hover near the edge and while dragged, and fades out
// IDLE_MS after the last of those. Mouse users can drag the thumb or click the track;
// on touch screens it only shows where you are. Keyboard and wheel scrolling are the
// browser's own, so it is hidden from assistive tech.
(function () {
  const IDLE_MS = 900; // how long it stays after scrolling stops
  const MIN_THUMB = 32; // px, so very long pages still get a grabbable thumb
  const INSET = 2; // px gap at the top and bottom of the window

  function mount() {
    if (document.querySelector(".scrollbar")) return;

    const bar = document.createElement("div");
    bar.className = "scrollbar";
    bar.setAttribute("aria-hidden", "true");
    bar.innerHTML = '<div class="scrollbar-thumb"></div>';
    document.body.appendChild(bar);

    const thumb = bar.firstElementChild;
    const root = document.documentElement;
    let thumbH = 0;
    let travel = 0; // px the thumb can move
    let end = 0; // px the page can scroll
    let hideTimer = 0;
    let frame = 0;
    let drag = null; // { startY, startScroll } while dragging

    const measure = () => {
      end = root.scrollHeight - innerHeight;
      const trackH = innerHeight - INSET * 2;
      if (end <= 0) {
        bar.dataset.still = "";
        return;
      }
      delete bar.dataset.still;
      thumbH = Math.max(MIN_THUMB, Math.round((trackH * innerHeight) / root.scrollHeight));
      travel = trackH - thumbH;
      thumb.style.height = `${thumbH}px`;
      place();
    };

    const place = () => {
      frame = 0;
      const p = end > 0 ? Math.min(1, Math.max(0, scrollY / end)) : 0;
      thumb.style.transform = `translateY(${INSET + p * travel}px)`;
    };

    const show = () => {
      bar.dataset.active = "";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!drag && !bar.matches(":hover")) delete bar.dataset.active;
      }, IDLE_MS);
    };

    addEventListener("scroll", () => {
      if (!frame) frame = requestAnimationFrame(place);
      show();
    }, { passive: true });
    addEventListener("resize", measure);
    new ResizeObserver(measure).observe(root);

    bar.addEventListener("pointerenter", show);
    bar.addEventListener("pointerleave", show); // restarts the idle timer, then hides

    // Drag the thumb: the page moves by the same share of its length.
    thumb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { startY: e.clientY, startScroll: scrollY };
      thumb.setPointerCapture(e.pointerId);
      bar.dataset.dragging = "";
      show();
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!drag || travel <= 0) return;
      scrollTo({ top: drag.startScroll + ((e.clientY - drag.startY) * end) / travel, behavior: "instant" });
    });
    const stop = () => {
      drag = null;
      delete bar.dataset.dragging;
      show();
    };
    thumb.addEventListener("pointerup", stop);
    thumb.addEventListener("pointercancel", stop);

    // Click the track: centre the thumb on that spot.
    bar.addEventListener("pointerdown", (e) => {
      if (e.target !== bar || e.button !== 0 || travel <= 0) return;
      const p = Math.min(1, Math.max(0, (e.clientY - INSET - thumbH / 2) / travel));
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollTo({ top: p * end, behavior: reduce ? "instant" : "smooth" });
    });

    measure();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

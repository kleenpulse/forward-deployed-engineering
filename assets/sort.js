// Sorting widget: put each item into one of a few buckets, with instant feedback.
// Usage: <script type="application/json" data-sort="unique-id">
//   { "buckets": ["A", "B"], "items": [{ "label": "...", "detail": "...", "bucket": 0, "why": "html" }] }
// </script>
// First-try results are saved to localStorage under fde:sort:<id>.
(function () {
  function render(script) {
    const id = script.dataset.sort;
    const data = JSON.parse(script.textContent);
    const host = document.createElement("div");
    host.className = "widget sort";
    const results = data.items.map(() => null);
    const score = document.createElement("div");
    score.className = "score";
    score.innerHTML = `<span class="tally"></span>`;

    data.items.forEach((item, ii) => {
      const wrap = document.createElement("div");
      wrap.className = "item";
      wrap.innerHTML = `<p class="prompt"><span class="n">${ii + 1}/${data.items.length}</span><strong>${item.label}</strong>${
        item.detail ? `<br><span class="small">${item.detail}</span>` : ""
      }</p>`;
      const choices = document.createElement("div");
      choices.className = "choices row";
      const fb = document.createElement("p");
      fb.className = "feedback";
      fb.setAttribute("aria-live", "polite");

      data.buckets.forEach((bucket, bi) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = bucket;
        b.addEventListener("click", () => {
          const right = bi === item.bucket;
          if (results[ii] === null) results[ii] = right;
          choices.querySelectorAll("button").forEach((x, xi) => {
            x.disabled = true;
            if (xi === item.bucket) x.classList.add("right");
          });
          if (!right) b.classList.add("wrong");
          fb.innerHTML = `<span class="verdict ${right ? "right" : "wrong"}">${right ? "Right" : "Not quite"}</span>${item.why}`;
          fb.classList.add("show");
          update();
        });
        choices.appendChild(b);
      });

      wrap.append(choices, fb);
      host.appendChild(wrap);
    });

    function update() {
      const done = results.filter((r) => r !== null).length;
      const right = results.filter((r) => r === true).length;
      score.querySelector(".tally").textContent =
        done < results.length ? `${done} of ${results.length} sorted` : `${right} of ${results.length} right on the first try`;
      if (done === results.length) {
        localStorage.setItem("fde:sort:" + id, JSON.stringify({ date: new Date().toISOString(), firstTry: right, total: results.length }));
      }
    }

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "tool";
    reset.textContent = "Reset";
    reset.addEventListener("click", () => {
      host.replaceWith(script);
      render(script);
    });
    score.appendChild(reset);
    host.appendChild(score);
    script.after(host);
    update();
  }

  document.querySelectorAll("script[data-sort]").forEach(render);
})();

// Multiple-choice quiz widget.
// Usage: <script type="application/json" data-quiz="unique-id">{ "questions": [...] }</script>
// Each question: { "q": "...", "options": ["...", ...], "answer": 0, "why": "html allowed" }
// Feedback is immediate. First-try results are saved to localStorage under fde:quiz:<id>
// so later lessons can resurface missed questions (spaced retrieval).
(function () {
  const KEY = (id) => "fde:quiz:" + id;

  function save(id, total, results) {
    const firstTry = results.filter((r) => r === true).length;
    const missed = results.map((r, i) => (r === false ? i : null)).filter((i) => i !== null);
    localStorage.setItem(KEY(id), JSON.stringify({ date: new Date().toISOString(), firstTry, total, missed }));
  }

  function render(script) {
    const id = script.dataset.quiz;
    const data = JSON.parse(script.textContent);
    const host = document.createElement("div");
    host.className = "widget quiz";
    const results = data.questions.map(() => null);
    const score = document.createElement("div");
    score.className = "score";

    data.questions.forEach((item, qi) => {
      const wrap = document.createElement("div");
      wrap.className = "item";
      wrap.innerHTML = `<p class="prompt"><span class="n">${qi + 1}/${data.questions.length}</span>${item.q}</p>`;
      const choices = document.createElement("div");
      choices.className = "choices";
      const fb = document.createElement("p");
      fb.className = "feedback";
      fb.setAttribute("aria-live", "polite");

      item.options.forEach((opt, oi) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = opt;
        b.addEventListener("click", () => {
          const right = oi === item.answer;
          if (results[qi] === null) results[qi] = right;
          choices.querySelectorAll("button").forEach((x, xi) => {
            x.disabled = true;
            if (xi === item.answer) x.classList.add("right");
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
        done < results.length ? `${done} of ${results.length} answered` : `${right} of ${results.length} right on the first try`;
      if (done === results.length) save(id, results.length, results);
    }

    score.innerHTML = `<span class="tally"></span>`;
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

  document.querySelectorAll("script[data-quiz]").forEach(render);
})();

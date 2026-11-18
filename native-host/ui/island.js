// ============================================================
// tutut island — page logic
// ------------------------------------------------------------
// Python → page:  tutut.show(req), tutut.hide(), tutut.setCharacter(cfg)
// Page → Python:  window.webkit.messageHandlers.tutut.postMessage(JSON)
//                 {type:"decision", dialogId, decision}  |  {type:"hidden"}
// ============================================================
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const island = $("island");
  const stage = $("stage");
  const actions = document.querySelector(".actions");
  const btn = { no: $("btnNo"), always: $("btnAlways"), yes: $("btnYes") };

  let current = null;       // request on screen
  let hideTimer = null;
  let reactingUntil = 0;    // let the yes/no reaction play before closing
  let character = { states: {} };

  function post(msg) {
    const json = JSON.stringify(msg);
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tutut;
    if (h) h.postMessage(json);
    else console.log("tutut→host", json); // opened in a normal browser
  }

  // ---------- character ----------
  function setCharacter(cfg) {
    character = Object.assign({ states: {} }, cfg || {});
    stage.querySelectorAll(".char").forEach((n) => n.remove());
    let el;
    if (character.svg) {
      const wrap = document.createElement("div");
      wrap.innerHTML = character.svg.trim();
      el = wrap.firstElementChild;
    } else if (character.image) {
      el = document.createElement("img");
      el.src = character.image;
      el.alt = "tutut";
      if (character.masked) el.classList.add("masked");
    }
    if (!el) return;
    el.classList.add("char");
    stage.insertBefore(el, stage.firstChild);
  }

  function setMood(mood) {
    stage.classList.remove("alert", "waiting", "yes", "no");
    void stage.offsetWidth; // restart CSS animations
    stage.classList.add(mood);
    const img = stage.querySelector("img.char");
    if (img && character.image) img.src = character.states[mood] || character.image;
  }

  // ---------- text helpers ----------
  function splitTool(tool) {
    // "Search files (Google Drive)" → ["Search files", "Google Drive"]
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(tool || "");
    return m ? [m[1], m[2]] : [tool || "a tool", ""];
  }

  function cleanDetail(text, tool, connector) {
    let t = (text || "").replace(/\s+/g, " ").trim();
    // drop the "Claude wants to use X from Y" heading we already show
    t = t.replace(/^.*?wants?\s+to\s+use\s+.*?\s+from\s+\S+(\s+\S+)?\s*/i, (s) =>
      connector && s.includes(connector) ? "" : s
    );
    return t.length > 170 ? t.slice(0, 167) + "…" : t;
  }

  function setButton(b, label, decision, visible = true) {
    b.textContent = label;
    b.dataset.decision = decision;
    b.hidden = !visible;
  }

  // ---------- show / hide ----------
  function show(req) {
    clearTimeout(hideTimer);
    // let the hop/shake for the previous answer finish first
    const wait = reactingUntil - Date.now();
    if (wait > 0) {
      current = null;
      hideTimer = setTimeout(() => show(req), wait);
      return;
    }
    current = req;
    actions.classList.remove("locked");
    island.classList.remove("closing");
    island.dataset.kind = req.kind === "input" ? "input" : "permission";

    if (req.kind === "input") {
      $("lead").textContent = "Claude needs your input in";
      $("tool").textContent = req.tool || "a chat";
      $("fromWrap").hidden = true;
      $("detail").textContent = "It's waiting for your answer — jump back to the chat.";
      $("badge").textContent = "?";
      setButton(btn.no, "Dismiss", "dismiss");
      setButton(btn.always, "", "", false);
      setButton(btn.yes, "Open chat", "open");
      setMood("waiting");
    } else {
      const [tool, connector] = splitTool(req.tool);
      $("lead").textContent = "Claude wants to use";
      $("tool").textContent = tool;
      $("connector").textContent = connector;
      $("fromWrap").hidden = !connector;
      $("detail").textContent = cleanDetail(req.fullText, tool, connector);
      $("badge").textContent = "!";
      const once = req.hasAllowOnce !== false;
      setButton(btn.no, "Deny", "deny");
      setButton(btn.always, "Always allow", "always", once && !!req.hasAlways);
      setButton(btn.yes, once ? "Allow once" : "Always allow", "allow");
      setMood("alert");
    }

    queueCount(req.queued || 0);
    requestAnimationFrame(() => {
      island.classList.add("open");
      reportSize();
    });
  }

  function hide() {
    clearTimeout(hideTimer);
    const wait = Math.max(0, reactingUntil - Date.now());
    hideTimer = setTimeout(() => {
      current = null;
      island.classList.remove("open");
      island.classList.add("closing");
      hideTimer = setTimeout(() => post({ type: "hidden" }), 360);
    }, wait);
  }

  // Only the card itself should catch clicks; the transparent rest of the
  // window is made click-through by the host.
  function reportSize() {
    const r = island.getBoundingClientRect();
    const shadow = 20;
    post({
      type: "size",
      x: Math.max(0, Math.floor(r.left)),
      y: 0,
      w: Math.ceil(r.width),
      h: Math.ceil(island.offsetHeight + shadow),
    });
  }

  function queueCount(n) {
    $("more").textContent = n > 0 ? `+${n} more` : "";
  }

  // ---------- clicks ----------
  actions.addEventListener("click", (e) => {
    const b = e.target.closest(".btn");
    if (!b || !current || actions.classList.contains("locked")) return;
    const decision = b.dataset.decision;
    actions.classList.add("locked");
    const positive = decision === "allow" || decision === "always" || decision === "open";
    setMood(positive ? "yes" : "no");
    reactingUntil = Date.now() + 480;
    post({ type: "decision", dialogId: current.dialogId, decision });
  });

  window.tutut = { show, hide, queueCount, setCharacter };
  post({ type: "ready" });
})();

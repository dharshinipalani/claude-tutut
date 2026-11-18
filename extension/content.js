// ============================================================
// Claude Permission Watcher — Content Script
// ============================================================
// Injected into claude.ai pages.
// Watches for permission dialogs using MutationObserver.
// When detected, sends details to background script → popup.
// ============================================================

(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------
  const CONFIG = {
    // Text that indicates a permission prompt
    permissionKeywords: [
      "wants to use",
      "wants to access",
      "would like to use",
      "requesting access",
      "permission",
      "allow",
    ],

    // Button labels (matched on whole words, case-insensitive).
    // Deny is checked first so "Don't allow" counts as deny.
    // "Allowed"/"Denied" are NOT matched on purpose — those are status labels.
    denyButton: /\b(deny|decline|reject|block|cancel|dismiss|skip|not now|don['’]?t allow|do not allow)\b/i,
    allowButton: /\b(allow|approve|accept|grant|permit)\b/i,
    // An allow button that grants permanent / broader permission
    alwaysButton: /\b(always|for this (chat|conversation|session)|for all|remember|every ?time)\b/i,

    fallbackPollInterval: 2000, // ms
    dedupeMs: 3000, // ignore the same prompt text re-rendered within this window
    debug: true,
  };

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  const processedDialogs = new WeakSet(); // containers already reported
  const activeDialogs = new Map(); // dialogId → { container, allow, deny }
  const recentTexts = new Map(); // text → timestamp

  // ----------------------------------------------------------
  // LOGGING
  // ----------------------------------------------------------
  function log(...args) {
    if (CONFIG.debug) {
      console.log("%c[Claude Permission Watcher]", "color:#f97316;font-weight:bold", ...args);
    }
  }

  // ----------------------------------------------------------
  // DETECTION
  // ----------------------------------------------------------
  const BUTTON_SELECTOR = 'button, [role="button"]';

  // textContent glues nested elements together ("Decline"+"Esc" → "DeclineEsc"),
  // which breaks word matching. Join text nodes with spaces instead.
  function spacedText(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = clean(n.textContent);
      if (t) parts.push(t);
    }
    return parts.join(" ");
  }

  // drop zero-width characters claude.ai puts between inline chips
  function clean(s) {
    return s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  }

  function classifyButton(btn) {
    const text = (spacedText(btn) || btn.getAttribute("aria-label") || "").trim();
    if (!text || text.length > 40) return null;
    if (CONFIG.denyButton.test(text)) return "deny";
    if (CONFIG.allowButton.test(text)) {
      return CONFIG.alwaysButton.test(text) ? "allowAlways" : "allow";
    }
    return null;
  }

  // allow  = the one-time allow button ("Allow once", "Allow"); never "Always allow"
  // always = the permanent allow button, if the prompt offers one
  function findActionButtons(container) {
    const found = { allow: null, allowAlways: null, deny: null };
    for (const btn of container.querySelectorAll(BUTTON_SELECTOR)) {
      const kind = classifyButton(btn);
      if (kind && !found[kind]) found[kind] = btn;
    }
    return { allow: found.allow, always: found.allowAlways, deny: found.deny };
  }

  // Walk up from an Allow button to the smallest ancestor that also
  // contains a Deny button and some descriptive text.
  function findDialogContainer(element) {
    let current = element.parentElement;
    for (let depth = 0; current && depth < 10; depth++) {
      const role = current.getAttribute("role");
      const tag = current.tagName.toLowerCase();
      const buttons = findActionButtons(current);
      const isDialog =
        role === "dialog" || role === "alertdialog" || tag === "dialog";

      if ((buttons.allow || buttons.always) && buttons.deny) {
        const text = extractDescriptionText(current, buttons);
        if (isDialog || text.length > 10) return { container: current, buttons, text };
      }
      if (current === document.body) break;
      current = current.parentElement;
    }
    return null;
  }

  // Text of the prompt minus the Allow/Deny buttons themselves.
  // Other buttons are kept: on claude.ai the heading "Claude wants to use X
  // from Y" is itself a (collapse) button.
  function extractDescriptionText(container, buttons) {
    const skip = [buttons.allow, buttons.always, buttons.deny].filter(Boolean);
    const parts = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (skip.some((b) => b.contains(n))) continue;
      const t = clean(n.textContent);
      if (t) parts.push(t);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function looksLikePermission(text) {
    const lower = text.toLowerCase();
    return CONFIG.permissionKeywords.some((kw) => lower.includes(kw));
  }

  function extractToolName(text) {
    // claude.ai: "Claude wants to use Search files from Google Drive Query …"
    const real = text.match(/wants?\s+to\s+use\s+(.{1,40}?)\s+from\s+(\S+(?:\s+\S+){0,2})/i);
    if (real) {
      const connector = real[2].replace(/\s+(Query|Input|Arguments|Parameters)\b.*$/i, "");
      return `${real[1].trim()} (${connector.trim()})`;
    }
    const patterns = [
      /wants?\s+to\s+(?:use|access)\s+["“']?([^"”'\n.?!]+)/i,
      /would\s+like\s+to\s+use\s+["“']?([^"”'\n.?!]+)/i,
      /access\s+(?:to\s+)?["“']?([^"”'\n.?!]+)/i,
      /permission.*?for\s+["“']?([^"”'\n.?!]+)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) return m[1].trim().slice(0, 60);
    }
    return text.split(/\s+/).slice(0, 6).join(" ") || "Unknown Tool";
  }

  function scan(root) {
    if (!(root instanceof Element)) return 0;
    const candidates = [];
    if (root.matches(BUTTON_SELECTOR)) candidates.push(root);
    candidates.push(...root.querySelectorAll(BUTTON_SELECTOR));

    let found = 0;
    for (const btn of candidates) {
      const kind = classifyButton(btn);
      if (kind !== "allow" && kind !== "allowAlways") continue;
      const hit = findDialogContainer(btn);
      if (!hit || processedDialogs.has(hit.container)) continue;
      if (!looksLikePermission(hit.text)) continue;
      processedDialogs.add(hit.container);
      report(hit);
      found++;
    }
    return found;
  }

  // ----------------------------------------------------------
  // REPORT to background
  // ----------------------------------------------------------
  function report({ container, buttons, text }) {
    const now = Date.now();
    const last = recentTexts.get(text);
    recentTexts.set(text, now);
    if (last && now - last < CONFIG.dedupeMs) {
      log("Duplicate prompt re-rendered — skipping");
      return;
    }

    const dialogId = `dialog_${now}_${Math.random().toString(36).slice(2, 7)}`;
    activeDialogs.set(dialogId, { container, ...buttons });

    const payload = {
      type: "PERMISSION_DETECTED",
      dialogId,
      hasAllowOnce: !!buttons.allow,
      hasAlways: !!buttons.always,
      tool: extractToolName(text),
      fullText: text.slice(0, 500),
      timestamp: new Date().toISOString(),
    };

    console.log(
      "%c[Claude Permission Watcher] 🚨 PERMISSION DETECTED",
      "color:#ef4444;font-weight:bold;font-size:14px",
      payload
    );

    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        log("Error sending to background:", chrome.runtime.lastError.message);
      } else {
        log("Background acknowledged:", response);
      }
    });
  }

  // Tell the background when a dialog disappears (answered on the page)
  function checkGoneDialogs() {
    for (const [dialogId, d] of activeDialogs) {
      if (!d.container.isConnected) {
        activeDialogs.delete(dialogId);
        log("Dialog gone:", dialogId);
        chrome.runtime.sendMessage({ type: "DIALOG_GONE", dialogId }, () => void chrome.runtime.lastError);
      }
    }
  }

  // ----------------------------------------------------------
  // "NEEDS YOUR INPUT" — chats waiting on you, even ones not open
  // ----------------------------------------------------------
  // claude.ai marks waiting chats in the sidebar with aria-label="Awaiting input"
  // and shows a "Needs your input" status pill in the open chat.
  const awaiting = new Map(); // chat path → title
  const pendingAwait = new Map(); // chat path → timer

  function findAwaitingChats() {
    const found = new Map();
    for (const a of document.querySelectorAll('a[href*="/chat/"]')) {
      if (a.querySelector('[aria-label="Awaiting input" i]')) {
        const path = new URL(a.href, location.href).pathname;
        // the chat title is the longest text line in the link (not an icon letter)
        const lines = (a.innerText || "").split("\n").map(clean).filter(Boolean);
        const title = a.getAttribute("title") || lines.sort((x, y) => y.length - x.length)[0];
        found.set(path, title || "a chat");
      }
    }
    const main = document.querySelector("main") || document.body;
    const pill = [...main.querySelectorAll('[role="status"], span, bdi')].some(
      (e) => e.children.length === 0 && /^needs your input$/i.test(e.textContent.trim())
    );
    if (pill && location.pathname.includes("/chat/") && !found.has(location.pathname)) {
      found.set(location.pathname, document.title.replace(/\s*-\s*Claude$/, "") || "this chat");
    }
    return found;
  }

  function inputId(path) {
    return "input_" + path.replace(/[^a-z0-9]/gi, "_");
  }

  function scanAwaiting() {
    const now = findAwaitingChats();

    for (const [path, title] of now) {
      if (awaiting.has(path) || pendingAwait.has(path)) continue;
      // Wait a moment: if this is the open chat and a permission prompt with
      // Allow/Deny was detected, that richer alert already covers it.
      pendingAwait.set(
        path,
        setTimeout(() => {
          pendingAwait.delete(path);
          if (!findAwaitingChats().has(path)) return;
          awaiting.set(path, title);
          const coveredByPrompt = path === location.pathname && activeDialogs.size > 0;
          if (coveredByPrompt) return;
          log("Chat awaiting input:", title);
          chrome.runtime.sendMessage(
            {
              type: "INPUT_NEEDED",
              inputId: inputId(path),
              chatUrl: location.origin + path,
              title,
              timestamp: new Date().toISOString(),
            },
            () => void chrome.runtime.lastError
          );
        }, 1500)
      );
    }

    for (const path of [...awaiting.keys()]) {
      if (!now.has(path)) {
        awaiting.delete(path);
        log("Chat no longer awaiting input:", path);
        chrome.runtime.sendMessage(
          { type: "INPUT_DONE", inputId: inputId(path) },
          () => void chrome.runtime.lastError
        );
      }
    }
  }

  // ----------------------------------------------------------
  // DECISIONS from notification / desktop popup
  // ----------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "CLICK_DECISION") return;
    log("Received click decision:", message);

    const d = activeDialogs.get(message.dialogId);
    // "allow" only ever falls back to "always" if the prompt has no one-time option
    const btn =
      d &&
      { allow: d.allow || d.always, always: d.always, deny: d.deny }[message.decision];
    if (!btn || !btn.isConnected) {
      sendResponse({ status: "error", reason: "button_not_found" });
      return;
    }
    btn.click();
    activeDialogs.delete(message.dialogId);
    log(`Clicked ${message.decision}`);
    sendResponse({ status: "clicked", decision: message.decision });
  });

  // ----------------------------------------------------------
  // INIT
  // ----------------------------------------------------------
  function init() {
    log("Initializing on", location.href);

    let awaitQueued = false;
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node);
        }
        if (m.removedNodes.length && activeDialogs.size) checkGoneDialogs();
      }
      if (!awaitQueued) {
        awaitQueued = true;
        setTimeout(() => { awaitQueued = false; scanAwaiting(); }, 300);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });

    setInterval(() => {
      scan(document.body);
      checkGoneDialogs();
      scanAwaiting();
    }, CONFIG.fallbackPollInterval);

    scan(document.body);
    scanAwaiting();
    log("Ready. Watching for permission dialogs...");
  }

  if (document.readyState === "complete") init();
  else window.addEventListener("load", init);
})();

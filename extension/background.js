// ============================================================
// Claude Permission Watcher — Background Service Worker
// ============================================================
// Receives detections from the content script and forwards them to the
// tutut desktop island (native messaging host). Decisions made on the
// island come back here and are clicked on the claude.ai page.
//
// There are no Chrome notifications: the island is the only alert.
// If the desktop host isn't running, only the red badge shows.
// ============================================================

// ----------------------------------------------------------
// STATE — kept in storage.session because MV3 workers sleep
// ----------------------------------------------------------
const STORAGE_KEY = "pendingRequests";

async function getPending() {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function setPending(pending) {
  await chrome.storage.session.set({ [STORAGE_KEY]: pending });
  const count = Object.keys(pending).length;
  chrome.action.setBadgeText({ text: count ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
}

async function addPending(id, request) {
  const pending = await getPending();
  pending[id] = request;
  await setPending(pending);
}

async function takePending(id) {
  const pending = await getPending();
  const request = pending[id];
  if (request) {
    delete pending[id];
    await setPending(pending);
  }
  return request;
}

// ----------------------------------------------------------
// NATIVE HOST — the tutut island
// ----------------------------------------------------------
const NATIVE_HOST_NAME = "com.claude.permission_watcher";
let nativePort = null;

function connectToNativeHost() {
  if (nativePort) return nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener((message) => {
      if (message.type === "DECISION") {
        applyDecision(message.dialogId, message.decision);
      }
    });

    port.onDisconnect.addListener(() => {
      console.warn(
        "[Background] ⚠️ tutut desktop host is not running — you will NOT get popups.\n" +
          "Run ./setup.sh <extension-id> and restart Chrome.\nReason:",
        chrome.runtime.lastError?.message
      );
      if (nativePort === port) nativePort = null;
    });

    nativePort = port;
  } catch (err) {
    console.warn("[Background] tutut desktop host unavailable:", err.message);
    nativePort = null;
  }
  return nativePort;
}

function sendToNativeHost(payload) {
  const port = connectToNativeHost(); // reconnects if the host exited
  if (!port) return false;
  try {
    port.postMessage(payload);
    return true;
  } catch (err) {
    console.warn("[Background] Failed to reach tutut host:", err.message);
    nativePort = null;
    return false;
  }
}

// ----------------------------------------------------------
// DECISIONS from the island
// ----------------------------------------------------------

// Bring the Claude tab (and the waiting chat) to the front
async function openChat(request) {
  if (request?.tabId == null) return;
  try {
    const tab = await chrome.tabs.get(request.tabId);
    const update = { active: true };
    if (request.chatUrl && tab.url && !tab.url.startsWith(request.chatUrl)) update.url = request.chatUrl;
    await chrome.tabs.update(request.tabId, update);
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    // Tab was closed — open the chat in a new tab instead
    if (request.chatUrl) chrome.tabs.create({ url: request.chatUrl });
  }
}

async function applyDecision(dialogId, decision) {
  const request = await takePending(dialogId);
  if (!request) {
    console.log("[Background] No pending request for:", dialogId);
    return;
  }

  if (request.kind === "input") {
    if (decision === "open") openChat(request);
    return;
  }

  console.log(`[Background] ${decision} for ${dialogId}`);
  chrome.tabs.sendMessage(
    request.tabId,
    { type: "CLICK_DECISION", dialogId, decision },
    (resp) => {
      if (chrome.runtime.lastError) {
        console.log("[Background] Tab unreachable:", chrome.runtime.lastError.message);
      } else {
        console.log("[Background] Content script:", resp);
      }
    }
  );
}

// ----------------------------------------------------------
// MESSAGES FROM CONTENT SCRIPT
// ----------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Allow/Deny prompt on claude.ai
  if (message.type === "PERMISSION_DETECTED") {
    console.log("[Background] Permission detected:", message.tool);
    addPending(message.dialogId, {
      kind: "permission",
      tool: message.tool,
      tabId: sender.tab?.id,
      windowId: sender.tab?.windowId,
      receivedAt: Date.now(),
    });
    const sentToNative = sendToNativeHost({
      type: "PERMISSION_REQUEST",
      dialogId: message.dialogId,
      tool: message.tool,
      fullText: message.fullText,
      timestamp: message.timestamp,
      hasAllowOnce: message.hasAllowOnce,
      hasAlways: message.hasAlways,
    });
    sendResponse({ status: "received", sentToNative });
    return;
  }

  // A chat is waiting on you ("Needs your input" / sidebar "Awaiting input")
  if (message.type === "INPUT_NEEDED") {
    getPending().then((pending) => {
      if (pending[message.inputId]) return; // another claude.ai tab already reported it
      addPending(message.inputId, {
        kind: "input",
        title: message.title,
        chatUrl: message.chatUrl,
        tabId: sender.tab?.id,
        windowId: sender.tab?.windowId,
        receivedAt: Date.now(),
      });
      sendToNativeHost({
        type: "INPUT_NEEDED",
        dialogId: message.inputId,
        tool: message.title,
        fullText: "Claude is waiting for your input in this chat.",
        timestamp: message.timestamp,
      });
    });
    return;
  }

  // Answered on the page itself → close the island
  if (message.type === "INPUT_DONE" || message.type === "DIALOG_GONE") {
    const id = message.inputId || message.dialogId;
    takePending(id);
    if (nativePort) sendToNativeHost({ type: "DISMISS", dialogId: id });
  }
});

// ----------------------------------------------------------
// INIT
// ----------------------------------------------------------
connectToNativeHost();
console.log("[Background] Claude Permission Watcher loaded (tutut island mode)");

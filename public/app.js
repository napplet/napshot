"use strict";

/*
 * Live Napshot viewer. Everything from the network is untrusted: text goes through
 * textContent, and only validated https: image URLs and bech32 strings reach attributes.
 */

const $ = (selector, root = document) => root.querySelector(selector);
const HEX = /^[0-9a-f]{64}$/;
const BECH32 = /^(npub|nevent|naddr)1[02-9ac-hj-np-z]+$/;
const KIND_NAMES = { 15129: "Root napplet", 35129: "Named napplet", 1985: "NIP-32 label" };

const state = {
  captures: [],
  cards: new Map(),
  seen: null,
  selected: null,
  detailKey: "",
  events: new Map(),
  status: null,
};

/** Small element builder; strings become text nodes, never markup. */
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) element.append(child);
  }
  return element;
}

function safeImage(url) {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function bech32(value) {
  return typeof value === "string" && BECH32.test(value) ? value : null;
}

function shorten(value, head = 12, tail = 6) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function ago(seconds) {
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function bytes(size) {
  if (!Number.isFinite(size) || size <= 0) return null;
  return size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`;
}

/* ---------- Clipboard and toast ---------- */

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 2400);
}

async function copy(value, what) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`Copied ${what}.`);
  } catch {
    toast(`Couldn't copy ${what}; select it and copy manually.`);
  }
}

/* ---------- Images with mirror fallback ---------- */

function screenshotImage(capture, className) {
  const urls = (capture.screenshot?.urls ?? []).map(safeImage).filter(Boolean);
  const frame = h("span", { class: `shot-frame ${className}` });
  if (!urls.length) {
    frame.classList.add("missing");
    return frame;
  }
  let index = 0;
  const image = h("img", { alt: `Screenshot of ${capture.napplet.title}`, loading: "lazy", decoding: "async" });
  image.addEventListener("error", () => {
    index += 1;
    if (index < urls.length) image.src = urls[index];
    else frame.classList.add("missing");
  });
  image.src = urls[0];
  frame.append(image);
  return frame;
}

function avatar(author, large = false) {
  const element = h("span", { class: large ? "avatar large" : "avatar", "aria-hidden": "true" });
  fillAvatar(element, author);
  return element;
}

function fillAvatar(element, author) {
  const name = displayName(author);
  element.replaceChildren(name.replace(/^npub1/, "").slice(0, 1).toUpperCase());
  const picture = safeImage(author.profile?.picture);
  if (!picture) return;
  const image = h("img", { alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  image.addEventListener("error", () => image.remove());
  image.src = picture;
  element.append(image);
}

function displayName(author) {
  return author.profile?.name || shorten(author.npub, 10, 4);
}

/* ---------- Gallery ---------- */

function card(capture) {
  const fresh = state.seen && !state.seen.has(capture.id);
  const button = h(
    "button",
    { type: "button", class: "card-button", "aria-label": `${capture.napplet.title} by ${displayName(capture.author)}` },
    screenshotImage(capture, "thumb"),
    h(
      "span",
      { class: "card-body" },
      h("span", { class: "card-title", text: capture.napplet.title }),
      h(
        "span",
        { class: "card-meta" },
        avatar(capture.author),
        h("span", { class: "card-author", text: displayName(capture.author) }),
        h("time", { class: "card-time", "data-time": capture.capturedAt, text: ago(capture.capturedAt) }),
      ),
    ),
  );
  button.addEventListener("click", () => select(capture.id, true));
  const item = h("li", { class: fresh ? "card fresh" : "card", "data-id": capture.id }, button);
  item.dataset.key = JSON.stringify(capture);
  return item;
}

function renderGallery() {
  const gallery = $("#gallery");
  const items = state.captures.map((capture) => {
    const existing = state.cards.get(capture.id);
    if (existing && existing.dataset.key === JSON.stringify(capture)) return existing;
    const created = card(capture);
    state.cards.set(capture.id, created);
    return created;
  });
  const ids = new Set(state.captures.map((capture) => capture.id));
  for (const id of state.cards.keys()) if (!ids.has(id)) state.cards.delete(id);
  gallery.replaceChildren(...items);
  for (const item of items) item.classList.toggle("selected", item.dataset.id === state.selected);
  $("#empty").hidden = items.length > 0;
  $("#capture-meta").textContent = items.length ? `${items.length} latest` : "";
}

function announceFresh(previous) {
  if (!previous) return;
  const fresh = state.captures.filter((capture) => !previous.has(capture.id));
  if (fresh.length === 1) toast(`New capture: ${fresh[0].napplet.title}`);
  else if (fresh.length > 1) toast(`${fresh.length} new captures`);
}

function applyCaptures(captures) {
  if (!Array.isArray(captures)) return;
  const previous = state.seen;
  state.captures = captures.filter((capture) => HEX.test(capture?.id ?? "") && capture.napplet && capture.author);
  renderGallery();
  announceFresh(previous);
  state.seen = new Set(state.captures.map((capture) => capture.id));
  const wide = matchMedia("(min-width: 821px)").matches;
  if (!state.selected && wide && state.captures.length) select(state.captures[0].id, false);
  else renderDetail();
}

/* ---------- Detail ---------- */

function select(id, focus) {
  state.selected = id;
  for (const item of state.cards.values()) item.classList.toggle("selected", item.dataset.id === id);
  $("#app").classList.toggle("inspecting", !!id);
  renderDetail();
  if (focus && id) $("#detail .detail-title")?.focus();
}

function codeRow(label, value, what) {
  const code = bech32(value);
  if (!code) return null;
  return h(
    "div",
    { class: "code-row" },
    h("span", { class: "code-label", text: label }),
    h("code", { title: code, text: shorten(code, 16, 8) }),
    h("button", { type: "button", class: "chip", onclick: () => copy(code, what), text: "Copy" }),
  );
}

function eventBlock({ title, kind, id, rows, code, extra }) {
  return h(
    "section",
    { class: "event-block" },
    h(
      "header",
      {},
      h("h3", { text: title }),
      h("span", { class: "kind", text: `kind ${kind}` }),
    ),
    extra,
    rows,
    h(
      "button",
      { type: "button", class: "chip wide", onclick: () => openJson({ id, kind, title, code }), text: "View event JSON" },
    ),
  );
}

function authorButton(capture) {
  const author = capture.author;
  return h(
    "button",
    { type: "button", class: "author-card", onclick: () => openProfile(capture) },
    avatar(author, true),
    h(
      "span",
      { class: "author-text" },
      h("strong", { text: displayName(author) }),
      h("code", { text: shorten(author.npub, 14, 6) }),
    ),
    h("span", { class: "author-open", "aria-hidden": "true", text: "›" }),
  );
}

function shotCaption(capture) {
  const shot = capture.screenshot;
  const parts = [
    shot.width && shot.height ? `${shot.width}×${shot.height}` : null,
    bytes(shot.size),
    `captured ${ago(capture.capturedAt)}`,
  ].filter(Boolean);
  return h("figcaption", {}, h("span", { text: parts.join(" · ") }), h("code", { title: shot.hash, text: shorten(shot.hash, 8, 8) }));
}

function detailView(capture) {
  const napplet = capture.napplet;
  return h(
    "div",
    { class: "detail-scroll" },
    h("button", { type: "button", class: "back", onclick: () => select(null, false), text: "← All captures" }),
    h("figure", { class: "shot" }, screenshotImage(capture, "large"), shotCaption(capture)),
    h("h2", { class: "detail-title", tabindex: "-1", text: napplet.title }),
    napplet.summary ? h("p", { class: "summary", text: napplet.summary }) : null,
    authorButton(capture),
    eventBlock({
      title: KIND_NAMES[napplet.kind] ?? "Napplet",
      kind: napplet.kind,
      id: napplet.id,
      code: { value: napplet.nevent, what: "napplet nevent" },
      extra: h("p", { class: "address" }, h("code", { title: napplet.address, text: shorten(napplet.address, 22, 12) })),
      rows: [codeRow("nevent", napplet.nevent, "napplet nevent"), codeRow("naddr", napplet.naddr, "napplet naddr")],
    }),
    eventBlock({
      title: "Screenshot label",
      kind: 1985,
      id: capture.label.id,
      code: { value: capture.label.nevent, what: "label nevent" },
      rows: [codeRow("nevent", capture.label.nevent, "label nevent")],
    }),
  );
}

function renderDetail() {
  const detail = $("#detail");
  const capture = state.captures.find((item) => item.id === state.selected);
  const key = capture ? JSON.stringify(capture) : "";
  if (key === state.detailKey && detail.firstElementChild) return;
  state.detailKey = key;
  if (!capture) {
    detail.replaceChildren(
      h("div", { class: "detail-placeholder" }, h("p", { text: "Select a capture to inspect its screenshot, napplet and label events." })),
    );
    $("#app").classList.remove("inspecting");
    return;
  }
  detail.replaceChildren(detailView(capture));
}

/* ---------- Dialogs ---------- */

async function loadEvent(id) {
  if (state.events.has(id)) return state.events.get(id);
  const response = await fetch(`/api/event/${id}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Event unavailable");
  const event = await response.json();
  if (event?.id !== id) throw new Error("Unexpected event");
  state.events.set(id, event);
  return event;
}

async function openJson({ id, kind, title, code }) {
  const dialog = $("#json-dialog");
  $("#json-kind").textContent = `kind ${kind} · ${shorten(id, 10, 6)}`;
  $("#json-title").textContent = title;
  $("#json-body").textContent = "Loading…";
  const copyCode = $("#json-copy-code");
  copyCode.textContent = `Copy ${code.what.split(" ").pop()}`;
  copyCode.onclick = () => copy(code.value, code.what);
  $("#json-copy").onclick = null;
  dialog.showModal();
  try {
    const text = JSON.stringify(await loadEvent(id), null, 2);
    $("#json-body").textContent = text;
    $("#json-copy").onclick = () => copy(text, "event JSON");
  } catch {
    $("#json-body").textContent = "Couldn't load this event. Try again shortly.";
  }
}

function openProfile(capture) {
  const author = capture.author;
  const npub = bech32(author.npub);
  fillAvatar($("#profile-avatar"), author);
  $("#profile-name").textContent = displayName(author);
  $("#profile-nip05").textContent = author.profile?.nip05 ?? "";
  $("#profile-about").textContent = author.profile?.about ?? "No profile metadata found on the queried relays.";
  $("#profile-npub").textContent = npub ?? "";
  $("#profile-copy").onclick = () => npub && copy(npub, "npub");
  const count = state.captures.filter((item) => item.author.pubkey === author.pubkey).length;
  $("#profile-count").textContent = `${count} napplet${count === 1 ? "" : "s"} in the recent captures`;
  const open = $("#profile-open");
  open.href = npub ? `https://njump.me/${npub}` : "#";
  $("#profile-dialog").showModal();
}

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
  });
}

/* ---------- Status ---------- */

function applyStatus(status) {
  const counts = status?.counts;
  const valid = counts && ["pending", "done", "failed"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
  if (!valid) return;
  state.status = status;
  for (const key of ["pending", "done", "failed"]) $(`#${key}-count`).textContent = String(counts[key]);
  const pubkey = typeof status.pubkey === "string" && HEX.test(status.pubkey) ? status.pubkey : null;
  $("#signer-key").textContent = pubkey ?? "Not configured";
  $("#copy-signer").disabled = !pubkey;
  const scan = Number.isSafeInteger(status.lastScan) && status.lastScan > 0 ? new Date(status.lastScan * 1000) : null;
  $("#last-scan").textContent = `Last relay scan: ${scan ? scan.toLocaleString() : "not completed yet"}`;
  $("#empty-text").textContent = pubkey
    ? "Watching relays. New captures appear here automatically."
    : "This instance isn't capturing (preview mode or no signer configured).";
}

$("#copy-signer").addEventListener("click", () => {
  const pubkey = state.status?.pubkey;
  if (HEX.test(pubkey ?? "")) copy(pubkey, "signer key");
});

function setLive(mode, label) {
  $("#live").dataset.state = mode;
  $("#live-label").textContent = label;
}

/* ---------- Live connection ---------- */

function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function poll() {
  try {
    const response = await fetch("/api/captures", { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Feed unavailable");
    const snapshot = await response.json();
    applyStatus(snapshot.status);
    applyCaptures(snapshot.captures);
    setLive("polling", "Updating");
  } catch {
    setLive("offline", "Offline");
  }
}

function connect() {
  if (typeof EventSource !== "function") {
    void poll();
    setInterval(poll, 10000);
    return;
  }
  const source = new EventSource("/api/stream");
  source.addEventListener("open", () => setLive("live", "Live"));
  source.addEventListener("error", () => setLive("offline", "Reconnecting…"));
  source.addEventListener("status", (event) => applyStatus(parse(event.data)));
  source.addEventListener("captures", (event) => applyCaptures(parse(event.data)));
}

/* ---------- Tabs, install bar, clock ---------- */

function showTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const active = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#${tab.getAttribute("aria-controls")}`).hidden = !active;
  }
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => {
    const name = tab.id.slice(4);
    showTab(name);
    history.replaceState(null, "", name === "about" ? "#about" : location.pathname);
  });
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const other = tab.id === "tab-captures" ? $("#tab-about") : $("#tab-captures");
    other.click();
    other.focus();
  });
}

$("#copy-command").addEventListener("click", () => copy($("#install-command").textContent, "install command"));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]") && $("#app").classList.contains("inspecting")) {
    if (!matchMedia("(min-width: 821px)").matches) select(null, false);
  }
});

setInterval(() => {
  for (const time of document.querySelectorAll("time[data-time]")) time.textContent = ago(Number(time.dataset.time));
}, 30000);

showTab(location.hash === "#about" ? "about" : "captures");
connect();

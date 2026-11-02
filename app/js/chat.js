// AI chat panel: type, speak (voice notes) or scan a document photo. Used by the office and the customer portal.
import { sb, esc } from "./common.js";

const history = [];
let pendingImage = null;

// Light formatting for replies: **bold**, line breaks, simple tables kept as text
const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");

// Phone photos are large: shrink to 1600px JPEG before sending
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = img.width * s; c.height = img.height * s;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export function mountChat(greeting) {
  const box = document.createElement("div");
  box.innerHTML = `
    <button id="chatOpen" class="chat-fab" aria-label="Open assistant">AI</button>
    <section id="chat" class="chat" hidden>
      <header><b>Assistant</b><button class="ghost" id="chatClose" aria-label="Close">×</button></header>
      <div id="chatLog" class="chat-log"><p class="bot">${esc(greeting)}</p></div>
      <div id="chatPreview" class="chat-preview" hidden></div>
      <form id="chatForm" class="chat-form">
        <label class="icon" title="Scan a document or photo">📷<input id="chatFile" type="file" accept="image/*" capture="environment" hidden></label>
        <button type="button" class="icon" id="chatMic" title="Voice note">🎤</button>
        <input id="chatText" placeholder="Ask anything…" autocomplete="off">
        <button class="primary">Send</button>
      </form>
    </section>`;
  document.body.append(box);
  const log = box.querySelector("#chatLog"), text = box.querySelector("#chatText"), preview = box.querySelector("#chatPreview");
  const add = (cls, html) => { const p = document.createElement("p"); p.className = cls; p.innerHTML = html; log.append(p); log.scrollTop = log.scrollHeight; return p; };

  box.querySelector("#chatOpen").onclick = () => { box.querySelector("#chat").hidden = false; text.focus(); };
  box.querySelector("#chatClose").onclick = () => (box.querySelector("#chat").hidden = true);

  box.querySelector("#chatFile").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    pendingImage = await shrink(file);
    preview.hidden = false;
    preview.innerHTML = `<img src="data:image/jpeg;base64,${pendingImage}" alt="Scanned document"> <button type="button" class="ghost">Remove</button>`;
    preview.querySelector("button").onclick = () => { pendingImage = null; preview.hidden = true; };
    if (!text.value) text.value = "Read this and fill the booking details";
  };

  // Voice notes: the phone's own speech-to-text (free, works in Chrome / Android)
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = box.querySelector("#chatMic");
  if (!Rec) mic.hidden = true;
  else {
    let rec = null;
    mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new Rec(); rec.lang = localStorage.getItem("voiceLang") || "en-IN"; rec.interimResults = true;
      mic.classList.add("on");
      rec.onresult = (ev) => { text.value = [...ev.results].map((r) => r[0].transcript).join(" "); };
      rec.onend = () => { mic.classList.remove("on"); rec = null; if (text.value.trim()) box.querySelector("#chatForm").requestSubmit(); };
      rec.start();
    };
  }

  box.querySelector("#chatForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = text.value.trim(); if (!msg && !pendingImage) return;
    const content = [];
    if (pendingImage) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pendingImage } });
    content.push({ type: "text", text: msg || "Read this document" });
    add("me", (pendingImage ? "📷 " : "") + esc(msg));
    history.push({ role: "user", content });
    text.value = ""; pendingImage = null; preview.hidden = true;
    const wait = add("bot", "Thinking…");
    try {
      const { data, error } = await sb.functions.invoke("assistant", { body: { messages: history } });
      if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? error.message);
      wait.innerHTML = fmt(data.reply);
      history.push({ role: "assistant", content: data.reply });
      if (data.actions?.some((a) => /create_booking|request_booking/.test(a))) document.dispatchEvent(new Event("bookings-changed"));
    } catch (err) {
      wait.innerHTML = `<span class="error">${esc(err.message)}</span>`;
      history.pop();
    }
  };
}

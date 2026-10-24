"use strict";
const $ = (id) => document.getElementById(id);
const log = $("log");
let ws;
let inRoom = false;

function line(text, cls, ts) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  if (ts) {
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = new Date(ts).toLocaleTimeString();
    li.append(t);
  }
  // textContent only: never interpret message content as HTML.
  li.append(document.createTextNode(text));
  log.append(li);
  log.scrollTop = log.scrollHeight;
}

function setInRoom(value, users) {
  inRoom = value;
  $("text").disabled = $("send").disabled = $("leave").disabled = !value;
  $("join-form").querySelector("button").disabled = value;
  $("users").textContent = value ? "Online: " + users.join(", ") : "";
}

let users = [];
function onMessage(m) {
  switch (m.type) {
    case "joined":
      users = m.users;
      setInRoom(true, users);
      line("Joined #" + m.room + " as " + m.nick, "sys");
      m.history.forEach((h) => line(h.nick + ": " + h.text, "", h.ts));
      break;
    case "left":
      setInRoom(false);
      line("Left #" + m.room, "sys");
      break;
    case "user_joined":
      users.push(m.nick);
      setInRoom(true, users);
      line(m.nick + " joined", "sys");
      break;
    case "user_left":
      users = users.filter((u) => u !== m.nick);
      setInRoom(true, users);
      line(m.nick + " left", "sys");
      break;
    case "message":
      line(m.nick + ": " + m.text, "", m.ts);
      break;
    case "error":
      line("Error (" + m.code + "): " + m.message, "err");
      break;
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host);
  ws.onopen = () => { $("status").textContent = "Connected"; };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $("status").textContent = "Disconnected. Reconnecting in 2s...";
    setInRoom(false);
    setTimeout(connect, 2000);
  };
}

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  ws.send(JSON.stringify({ type: "join", room: $("room").value.trim(), nick: $("nick").value.trim() }));
};
$("msg-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!inRoom || !text) return;
  ws.send(JSON.stringify({ type: "message", text }));
  $("text").value = "";
};
$("leave").onclick = () => ws.send(JSON.stringify({ type: "leave" }));

connect();

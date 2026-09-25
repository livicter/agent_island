/* Agent Island — UI module
   Plain browser script. Load order: config.js → island.js → agents.js →
   api.js → ui.js → main.js. Exposes window.UI. */

(function () {
  "use strict";

  var cine = { t: 0, on: false };
  var toastTimer = null;
  var residentsTimer = null;
  var chatAgentId = null;

  // Panels hidden by the "hide UI" toolbar toggle. The toolbar itself and the
  // topnav stay visible so the user can always bring the panels back.
  var PANEL_IDS = [
    "island-card",
    "happening",
    "residents",
    "feed",
    "places",
    "viewtoggle",
  ];

  function has(mod) {
    return typeof mod !== "undefined" && mod !== null;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // hex number (e.g. 0xffd166) → css color string
  function cssColor(c) {
    if (typeof c === "string") return c;
    return "#" + ("000000" + (c >>> 0).toString(16)).slice(-6);
  }

  /* ---------------- toast ---------------- */

  function toast(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
      toastTimer = null;
    }, 2400);
  }

  /* ---------------- residents ---------------- */

  function refreshResidents() {
    var list = $("resident-list");
    if (!list) return;
    if (!has(window.Agents)) return;
    var agents = [];
    try {
      agents = window.Agents.list() || [];
    } catch (e) {
      return;
    }
    list.innerHTML = "";
    agents.forEach(function (a) {
      var row = el("div", "resident-row");
      row.setAttribute("data-agent", a.id);
      row.appendChild(el("span", "resident-dot")).style.background = cssColor(
        a.color
      );
      row.appendChild(el("span", "resident-name", a.name));
      row.appendChild(
        el("span", "resident-status", a.status || "wandering")
      );
      row.title = a.name + " — click to chat";
      row.addEventListener("click", function () {
        if (has(window.Island) && window.Island.focusAgent)
          window.Island.focusAgent(a.id);
        openChat(a.id);
      });
      list.appendChild(row);
    });
  }

  /* ---------------- places ---------------- */

  function refreshPlaces() {
    var list = $("place-list");
    if (!list) return;
    if (!has(window.ISLE) || !Array.isArray(window.ISLE.places)) return;
    list.innerHTML = "";
    window.ISLE.places.forEach(function (p) {
      var chip = el("button", "place-chip", p.name);
      chip.setAttribute("data-place", p.id);
      chip.addEventListener("click", function () {
        if (has(window.Island) && window.Island.focusPlace)
          window.Island.focusPlace(p.x, p.z);
        toast(p.name);
      });
      list.appendChild(chip);
    });
  }

  /* ---------------- feed ---------------- */

  function feedEvent(text, tag) {
    var moments = $("moments");
    if (!moments) return;
    var card = el("div", "moment");
    card.appendChild(el("span", "moment-tag", tag || "ISLAND"));
    card.appendChild(el("span", "moment-text", text));
    card.appendChild(el("span", "moment-time", "just now"));
    card.style.transition = "opacity 0.5s ease";
    moments.insertBefore(card, moments.firstChild);
    // cap at 4 cards; older ones fade out
    var kids = moments.children;
    for (var i = 0; i < kids.length; i++) {
      if (i > 3) {
        (function (gone) {
          gone.style.opacity = "0";
          setTimeout(function () {
            if (gone.parentNode) gone.parentNode.removeChild(gone);
          }, 500);
        })(kids[i]);
      } else {
        kids[i].style.opacity = String(1 - i * 0.18);
      }
    }
  }

  /* ---------------- clock / happening / recap / watchers ---------------- */

  function setClock(o) {
    o = o || {};
    var clock = $("clock");
    if (clock) clock.textContent = (o.time || "--:--") + " · Day " + (o.day || 1);
    var season = $("season");
    if (season)
      season.textContent =
        (o.season || "") + (o.weather ? " · " + o.weather : "");
  }

  function setHappening(t) {
    var h = $("happening-text");
    if (h) h.textContent = t || "";
  }

  function setRecap(t) {
    var r = $("recap-text");
    if (r) r.textContent = t || "";
  }

  function setWatchers(n) {
    var w = $("watchers");
    if (w) w.textContent = (n == null ? 0 : n) + " watching now";
  }

  /* ---------------- chat ---------------- */

  function openChat(id) {
    if (!has(window.Agents)) return;
    var agent = null;
    try {
      agent = window.Agents.get(id);
    } catch (e) {
      return;
    }
    if (!agent) return;
    chatAgentId = id;
    var chat = $("chat");
    var name = $("chat-name");
    var dot = $("chat-dot");
    var log = $("chatlog");
    var input = $("chatinput");
    if (name) name.textContent = agent.name;
    if (dot) dot.style.background = cssColor(agent.color);
    if (log) log.innerHTML = "";
    if (chat) chat.classList.add("open");
    if (log) {
      var g = el("div", "bubble bubble-agent");
      g.textContent =
        "Hi, I'm " +
        agent.name +
        "! " +
        (agent.personality
          ? "I'm " + agent.personality + "."
          : "Ask me anything about the island.");
      log.appendChild(g);
      log.scrollTop = log.scrollHeight;
    }
    if (input) input.focus();
  }

  function closeChat() {
    var chat = $("chat");
    if (chat) chat.classList.remove("open");
    chatAgentId = null;
  }

  function addBubble(cls, text) {
    var log = $("chatlog");
    if (!log) return;
    var b = el("div", "bubble " + cls, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
  }

  function submitChat() {
    var input = $("chatinput");
    if (!input) return;
    var text = input.value.trim();
    if (!text || chatAgentId === null) return;
    input.value = "";
    addBubble("bubble-user", text);
    if (!has(window.Agents)) return;
    var reply;
    try {
      reply = window.Agents.chat(chatAgentId, text);
    } catch (e) {
      reply = null;
    }
    function show(r) {
      if (r === undefined || r === null || r === "") return;
      addBubble("bubble-agent", String(r));
    }
    if (reply && typeof reply.then === "function") {
      reply.then(show);
    } else {
      show(reply);
    }
  }

  /* ---------------- photo mode ---------------- */

  function isPhotoMode() {
    return document.body.classList.contains("photo-mode");
  }

  function togglePhoto() {
    if (isPhotoMode()) {
      document.body.classList.remove("photo-mode");
    } else {
      if (isCinematic()) toggleCinematic();
      document.body.classList.add("photo-mode");
    }
  }

  function capturePhoto() {
    if (!has(window.Island) || !window.Island.renderer) {
      toast("Camera not ready");
      return;
    }
    try {
      var data = window.Island.renderer.domElement.toDataURL("image/png");
      var a = document.createElement("a");
      a.href = data;
      a.download = "dawnbreak-island.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast("Photo saved");
    } catch (e) {
      toast("Photo capture failed");
    }
  }

  /* ---------------- cinematic mode ---------------- */

  function isCinematic() {
    return document.body.classList.contains("cinematic");
  }

  function toggleCinematic() {
    if (isCinematic()) {
      document.body.classList.remove("cinematic");
      cine.on = false;
    } else {
      if (isPhotoMode()) togglePhoto();
      cine.t = 0;
      cine.on = true;
      document.body.classList.add("cinematic");
      toast("Cinematic camera — press Esc or M to exit");
    }
  }

  /* ---------------- hide UI ---------------- */

  function toggleHide() {
    var hidden = document.body.classList.toggle("ui-hidden");
    PANEL_IDS.forEach(function (id) {
      var p = $(id);
      if (p) p.style.display = hidden ? "none" : "";
    });
    return hidden;
  }

  /* ---------------- init ---------------- */

  function init() {
    // residents
    refreshResidents();
    if (residentsTimer) clearInterval(residentsTimer);
    residentsTimer = setInterval(refreshResidents, 5000);

    // places
    refreshPlaces();

    // topnav tabs
    var tabs = document.querySelectorAll("#topnav .tab");
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener("click", function () {
        var name = (tab.textContent || "").trim().toLowerCase();
        if (name === "island") {
          Array.prototype.forEach.call(tabs, function (t) {
            t.classList.remove("active");
          });
          tab.classList.add("active");
        } else {
          toast("Following/Journal are coming soon in this demo");
        }
      });
    });

    // bring a muse: modal -> AgentAPI.register
    var bring = $("bring");
    var bringModal = $("bring-modal");
    function closeBring() {
      if (bringModal) bringModal.classList.add("hidden");
    }
    function joinBring() {
      var nameInput = $("bring-name");
      var colorInput = $("bring-color");
      var name = nameInput ? String(nameInput.value).trim() : "";
      if (!name) {
        if (nameInput) nameInput.focus();
        return;
      }
      var color = colorInput ? colorInput.value : "#7c5cff";
      if (!has(window.AgentAPI)) {
        toast("Registration unavailable");
        closeBring();
        return;
      }
      try {
        window.AgentAPI.register(name, color);
      } catch (e) {
        toast("Could not register " + name);
        closeBring();
        return;
      }
      closeBring();
      toast("✨ " + name + " joined the island!");
      feedEvent(name + " arrived on Dawnbreak!", "ISLAND");
      refreshResidents();
    }
    if (bring) {
      bring.addEventListener("click", function () {
        if (!bringModal) return;
        var nameInput = $("bring-name");
        if (nameInput) nameInput.value = "";
        bringModal.classList.remove("hidden");
        if (nameInput) setTimeout(function () { nameInput.focus(); }, 50);
      });
    }
    var bringCancel = $("bring-cancel");
    if (bringCancel) bringCancel.addEventListener("click", closeBring);
    var bringJoin = $("bring-join");
    if (bringJoin) bringJoin.addEventListener("click", joinBring);
    if (bringModal) {
      bringModal.addEventListener("click", function (e) {
        if (e.target === bringModal) closeBring();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeBring();
    });

    // toolbar
    function bind(id, fn) {
      var b = $(id);
      if (b) b.addEventListener("click", fn);
    }
    bind("t-compass", function () {
      if (has(window.Island) && window.Island.resetView) window.Island.resetView();
    });
    bind("t-zin", function () {
      if (has(window.Island) && window.Island.zoom) window.Island.zoom(0.85);
    });
    bind("t-zout", function () {
      if (has(window.Island) && window.Island.zoom) window.Island.zoom(1.18);
    });
    bind("t-cine", toggleCinematic);
    bind("t-photo", togglePhoto);
    bind("t-hide", toggleHide);

    // view toggle
    var vv = $("v-village");
    var vw = $("v-whole");
    function setView(which) {
      if (has(window.Island) && window.Island.toggleOverview)
        window.Island.toggleOverview();
      if (vv) vv.classList.toggle("active", which === "village");
      if (vw) vw.classList.toggle("active", which === "whole");
    }
    if (vv) vv.addEventListener("click", function () { setView("village"); });
    if (vw) vw.addEventListener("click", function () { setView("whole"); });

    // chat
    var form = $("chatform");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        submitChat();
      });
    }
    var chatx = $("chat-x");
    if (chatx) chatx.addEventListener("click", closeChat);

    // photo bar
    var capture = $("capture");
    if (capture) capture.addEventListener("click", capturePhoto);
    var photoexit = $("photoexit");
    if (photoexit) photoexit.addEventListener("click", togglePhoto);

    // keyboard
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        if (isPhotoMode()) togglePhoto();
        if (isCinematic()) toggleCinematic();
        closeChat();
        return;
      }
      if (typing) return;
      if (e.key === "m" || e.key === "M") toggleCinematic();
      else if (e.key === "p" || e.key === "P") togglePhoto();
      else if (e.key === "h" || e.key === "H") toggleHide();
    });
  }

  /* ---------------- per-frame ---------------- */

  function tick(dt) {
    if (!cine.on) return;
    cine.t += dt;
    if (!has(window.Island) || !window.Island.setCam) return;
    var t = cine.t;
    window.Island.setCam(
      t * 0.12,
      0.55 + Math.sin(t * 0.3) * 0.1,
      70 + Math.sin(t * 0.2) * 12,
      0,
      2,
      0
    );
  }

  /* ---------------- export ---------------- */

  window.UI = {
    init: init,
    feedEvent: feedEvent,
    setClock: setClock,
    setHappening: setHappening,
    setRecap: setRecap,
    setWatchers: setWatchers,
    refreshResidents: refreshResidents,
    refreshPlaces: refreshPlaces,
    openChat: openChat,
    togglePhoto: togglePhoto,
    toggleCinematic: toggleCinematic,
    tick: tick,
    toast: toast,
  };
})();

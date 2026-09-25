/* Agent Island — bootstrap */
(function () {
  "use strict";

  // Game clock: 1 real second = 1 game minute; day starts at 07:15
  const state = {
    gameMinutes: 7 * 60 + 15,
    day: 33,
    season: "Dry season",
    weather: "Clear",
    watchers: 1,
  };

  function fmtClock() {
    const h = Math.floor(state.gameMinutes / 60) % 24;
    const m = Math.floor(state.gameMinutes % 60);
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  // URL params for demos / deep links: ?tod=22.5&weather=Rain
  const params = new URLSearchParams(location.search);
  const todParam = params.has("tod") ? parseFloat(params.get("tod")) : NaN;
  const todOverride = Number.isFinite(todParam) ? todParam : null;
  const weatherParam = params.get("weather");

  window.addEventListener("DOMContentLoaded", () => {
    if (!window.THREE) {
      document.getElementById("scene").innerHTML =
        '<div style="color:#fff;padding:40px;font-family:sans-serif">Could not load three.js.<br>Check your connection and reload.</div>';
      return;
    }

    Island.init(document.getElementById("scene"));
    Agents.init();
    AgentAPI.init();
    UI.init();

    // restore external agents registered earlier
    AgentAPI.restore(Agents);

    UI.setWatchers(18);
    UI.setHappening(ISLE.happenings[0]);
    UI.setRecap(
      "Wren followed a trail of glowing moths and returned with star sand."
    );
    UI.feedEvent(
      "Welcome to Dawnbreak. The residents are waking up — click anyone to say hello.",
      "ISLAND"
    );

    // day/night + weather drift
    if (weatherParam) {
      state.weather = weatherParam;
      Island.setWeather(weatherParam);
    }
    setInterval(() => {
      if (todOverride == null) {
        state.gameMinutes += 6; // 6 game-minutes per 6s tick
        if (state.gameMinutes >= 24 * 60) {
          state.gameMinutes -= 24 * 60;
          state.day += 1;
        }
      }
      const h = todOverride != null ? todOverride : state.gameMinutes / 60;
      Island.setTimeOfDay(h);
      UI.setClock({
        time: fmtClock(),
        day: state.day,
        season: state.season,
        weather: state.weather,
      });
    }, 6000);
    Island.setTimeOfDay(
      todOverride != null ? todOverride : state.gameMinutes / 60
    );
    if (todOverride != null) state.gameMinutes = todOverride * 60; // freeze clock at override
    UI.setClock({
      time: fmtClock(),
      day: state.day,
      season: state.season,
      weather: state.weather,
    });

    // occasionally change the happening
    setInterval(() => {
      const h =
        ISLE.happenings[Math.floor(Math.random() * ISLE.happenings.length)];
      UI.setHappening(h);
    }, 90000);

    // slow weather drift
    const WEATHERS = ["Clear", "Cloudy", "Rain"];
    setInterval(() => {
      const w = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
      state.weather = w;
      Island.setWeather(w);
      UI.setClock({
        time: fmtClock(),
        day: state.day,
        season: state.season,
        weather: state.weather,
      });
    }, 300000 + Math.random() * 240000);

    // animation loop
    let last = performance.now();
    function loop(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      Agents.tick(dt);
      Island.onTick(dt, now / 1000);
      UI.tick(dt);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
})();

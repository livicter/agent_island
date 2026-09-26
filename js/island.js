/* Agent Island — 3D world module (island.js)
 * Plain browser script. THREE r149 is loaded globally as window.THREE.
 * Depends on window.ISLE config (config.js). Exposes window.Island.
 */
(function () {
  'use strict';

  var THREE = window.THREE;
  if (!THREE) { throw new Error('island.js requires THREE r149 loaded globally'); }

  var CFG = window.ISLE || { name: 'Dawnbreak', radius: 40, places: [], roster: [] };
  var R = CFG.radius || 40;

  // ---------- analytic terrain ----------
  function groundHeight(x, z) {
    var h = 0.55 * Math.sin(x * 0.12) * Math.cos(z * 0.14)
          + 0.28 * Math.sin(x * 0.05 + 1.7) * Math.cos(z * 0.06 + 0.6)
          + 0.12 * Math.sin(x * 0.31 + 0.4) * Math.sin(z * 0.27 + 2.1);
    // falloff toward the sand rim so the disc edge dips down
    var d = Math.sqrt(x * x + z * z);
    var f = Math.min(1, Math.max(0, (R - 1.5 - d) / 9));
    f = f * f * (3 - 2 * f); // smoothstep
    return 0.1 + 0.9 * f * h + 0.35 * h * 0.25;
  }

  // ---------- internal state ----------
  var renderer, scene, camera, container;
  var sunLight, moonLight, hemiLight, ambLight;
  var skyMat, starMat, sunSprite, moonSprite;
  var waterMesh, waterGeo;
  var clouds = [];            // sprite group
  var rain = null;            // Points
  var fireflies = null;       // Points (night)
  var fireflyBase = null, fireflyPhase = null;
  var lamps = [];             // { meshMat, glowMat }
  var lampLights = [];        // real PointLights (first few lamps only)
  var windows = [];           // emissive window materials
  var cottageWindows = [];    // { mat, glowMat } — cottage window panes, glow at night
  var lanterns = [];          // { bulbMat, glowMat, bloomMat } — path lantern posts
  var shaftMat = null;        // golden-hour light shaft material (uIntensity animated)
  var waterUniforms = null;   // injected water shader uniforms (glints, fresnel)
  var bloomLampGlows = [];    // per-lamp glow-caster sprites in the bloom layer
  var bloomMoonGlow = null, bloomSunGlow = null, bloomFireflies = null, bloomGlint = null;
  var labelSprites = [];
  var agents = {};            // id -> { group, ringMat, nameSprite, phase, status, heading }
  var weatherMode = 'Clear';
  var nightF = 0;             // 0 = full day, 1 = full night (set by applyTimeOfDay)
  var sunF = 1;               // 0 = sun down, 1 = full day sun (set by applyTimeOfDay)
  var starBase = 0;           // base star opacity from palette (twinkle modulates it)
  var overview = false;
  var followId = null;        // agent id the camera is following, or null
  var speechLayer = null;     // DOM layer for floating speech bubbles

  var cam = { yaw: 0.85, pitch: 0.52, dist: 46, tx: 0, ty: 2, tz: 0 };
  var DEFAULT_VIEW = { yaw: 0.85, pitch: 0.52, dist: 46, tx: 0, ty: 2, tz: 0 };
  var OVERVIEW_VIEW = { yaw: 0.85, pitch: 0.95, dist: 155, tx: 0, ty: 0, tz: 0 };
  var tween = null;           // { t, dur, from, to }
  var curTOD = 12;            // hour 0..24

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function easeInOut(t) { return t * t * (3 - 2 * t); }
  // shortest signed angular difference, in (-PI, PI]
  function shortAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function hexLerp(c1, c2, t) {
    var a = new THREE.Color(c1), b = new THREE.Color(c2);
    return a.lerp(b, t);
  }

  // ---------- canvas texture helpers ----------
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function roundedPill(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function makeLabelSprite(text, scale, light) {
    var c = makeCanvas(256, 72);
    var ctx = c.getContext('2d');
    if (light) {
      // Moonwake-style: white pill, dark text (for character names / place pills)
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundedPill(ctx, 4, 10, 248, 52, 26);
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,35,50,0.14)';
      ctx.lineWidth = 2;
      roundedPill(ctx, 4, 10, 248, 52, 26);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(10,16,32,0.62)';
      roundedPill(ctx, 4, 10, 248, 52, 26);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 3;
      roundedPill(ctx, 4, 10, 248, 52, 26);
      ctx.stroke();
    }
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = light ? '#2a3040' : '#ffffff';
    ctx.fillText(text, 128, 38);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    var sp = new THREE.Sprite(mat);
    sp.scale.set(7.2 * (scale || 1), 2.0 * (scale || 1), 1);
    return sp;
  }

  function makeGlowTexture(inner, outer) {
    var c = makeCanvas(128, 128);
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  function makeMoonTexture() {
    var c = makeCanvas(256, 256);
    var ctx = c.getContext('2d');
    // soft halo
    var halo = ctx.createRadialGradient(128, 128, 40, 128, 128, 126);
    halo.addColorStop(0, 'rgba(190,210,245,0.35)');
    halo.addColorStop(1, 'rgba(150,170,220,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, 256, 256);
    // bright disc
    var disc = ctx.createRadialGradient(112, 108, 10, 128, 128, 62);
    disc.addColorStop(0, '#ffffff');
    disc.addColorStop(0.75, '#e8eefb');
    disc.addColorStop(1, '#c3cfe8');
    ctx.fillStyle = disc;
    ctx.beginPath(); ctx.arc(128, 128, 58, 0, 7); ctx.fill();
    // craters
    ctx.fillStyle = 'rgba(160,175,205,0.55)';
    [[108, 116, 11], [142, 140, 8], [126, 152, 6], [148, 108, 5], [114, 142, 4]].forEach(function (k) {
      ctx.beginPath(); ctx.arc(k[0], k[1], k[2], 0, 7); ctx.fill();
    });
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(104, 100, 16, 0, 7); ctx.fill();
    return new THREE.CanvasTexture(c);
  }

  function makeCloudTexture() {
    var c = makeCanvas(256, 128);
    var ctx = c.getContext('2d');
    function blob(x, y, r, a) {
      var g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    blob(90, 75, 55, 0.85); blob(130, 60, 62, 0.9); blob(170, 75, 50, 0.85); blob(128, 85, 60, 0.8);
    return new THREE.CanvasTexture(c);
  }

  // ---------- time-of-day palettes ----------
  // keyframes across the 24h cycle; interpolated with wrap-around.
  // sun: directional sun intensity factor, moon: cool moonlight factor,
  // sunColor: tint of the sun light (warm at dawn/dusk).
  var TOD_KEYS = [
    { h: 0.0,  skyTop: '#030509', skyBot: '#0b1226', fog: '#090e20', sun: 0.00, moon: 0.50, sunColor: '#fff2dd', hemi: 0.14, amb: 0.16, lamp: 1.0, star: 1.0, water: '#081426' },
    { h: 4.5,  skyTop: '#030509', skyBot: '#0b1226', fog: '#090e20', sun: 0.00, moon: 0.50, sunColor: '#fff2dd', hemi: 0.14, amb: 0.16, lamp: 1.0, star: 1.0, water: '#081426' },
    { h: 5.75, skyTop: '#27436f', skyBot: '#e88b52', fog: '#bd9077', sun: 0.35, moon: 0.22, sunColor: '#ff9e58', hemi: 0.26, amb: 0.24, lamp: 0.8, star: 0.15, water: '#1d4a72' },
    { h: 7.5,  skyTop: '#3f7fd4', skyBot: '#bfe0f2', fog: '#cfd9e2', sun: 1.00, moon: 0.00, sunColor: '#fff4e0', hemi: 0.22, amb: 0.18, lamp: 0.0, star: 0.0, water: '#2f7fc4' },
    { h: 16.5, skyTop: '#3a78d8', skyBot: '#b8dcf0', fog: '#ccd8e2', sun: 1.05, moon: 0.00, sunColor: '#fff6e8', hemi: 0.22, amb: 0.18, lamp: 0.0, star: 0.0, water: '#2f7fc4' },
    { h: 17.75, skyTop: '#4a5a9e', skyBot: '#f7a24e', fog: '#d99a6e', sun: 0.62, moon: 0.04, sunColor: '#ff9e58', hemi: 0.40, amb: 0.34, lamp: 0.45, star: 0.0, water: '#2a5a8c' },
    { h: 19.0, skyTop: '#1a2347', skyBot: '#6f5fa6', fog: '#4e5478', sun: 0.22, moon: 0.20, sunColor: '#d98a5a', hemi: 0.20, amb: 0.20, lamp: 0.8, star: 0.18, water: '#1a3a66' },
    { h: 20.0, skyTop: '#101a3a', skyBot: '#2c3a63', fog: '#232c4e', sun: 0.04, moon: 0.42, sunColor: '#c98d5f', hemi: 0.20, amb: 0.20, lamp: 1.0, star: 0.6, water: '#0f2447' },
    { h: 21.0, skyTop: '#030509', skyBot: '#0b1226', fog: '#090e20', sun: 0.00, moon: 0.55, sunColor: '#fff2dd', hemi: 0.14, amb: 0.16, lamp: 1.0, star: 1.0, water: '#081426' },
    { h: 24.0, skyTop: '#030509', skyBot: '#0b1226', fog: '#090e20', sun: 0.00, moon: 0.50, sunColor: '#fff2dd', hemi: 0.14, amb: 0.16, lamp: 1.0, star: 1.0, water: '#081426' }
  ];

  function todSample(h) {
    h = ((h % 24) + 24) % 24;
    var i = 0;
    while (i < TOD_KEYS.length - 2 && TOD_KEYS[i + 1].h <= h) i++;
    var a = TOD_KEYS[i], b = TOD_KEYS[i + 1];
    var t = (h - a.h) / Math.max(1e-5, b.h - a.h);
    t = clamp(t, 0, 1);
    t = t * t * (3 - 2 * t); // smoothstep: ease the handoff
    return {
      skyTop: hexLerp(a.skyTop, b.skyTop, t),
      skyBot: hexLerp(a.skyBot, b.skyBot, t),
      fog: hexLerp(a.fog, b.fog, t),
      sun: lerp(a.sun, b.sun, t),
      moon: lerp(a.moon, b.moon, t),
      sunColor: hexLerp(a.sunColor, b.sunColor, t),
      hemi: lerp(a.hemi, b.hemi, t),
      amb: lerp(a.amb, b.amb, t),
      lamp: lerp(a.lamp, b.lamp, t),
      star: lerp(a.star, b.star, t),
      water: hexLerp(a.water, b.water, t)
    };
  }

  function applyTimeOfDay(h) {
    curTOD = ((h % 24) + 24) % 24;
    var s = todSample(curTOD);

    // weather muting: desaturate + dim the palette, soften shadows
    var mute = 1, grayMix = 0;
    if (weatherMode === 'Cloudy') { mute = 0.62; grayMix = 0.45; }
    else if (weatherMode === 'Rain') { mute = 0.40; grayMix = 0.62; }
    var gray = new THREE.Color('#8f99a6');
    if (grayMix > 0) {
      s.skyTop.lerp(gray, grayMix); s.skyBot.lerp(gray, grayMix); s.fog.lerp(gray, grayMix * 0.8);
    }

    skyMat.uniforms.topColor.value.copy(s.skyTop);
    skyMat.uniforms.bottomColor.value.copy(s.skyBot);
    scene.fog.color.copy(s.fog);
    renderer.setClearColor(s.fog);

    nightF = clamp(1 - s.sun * 2.2, 0, 1); // 0 day -> 1 night
    sunF = clamp(s.sun * 1.6, 0, 1);

    // sun orbit: 6h -> east horizon, 12h -> zenith, 18h -> west
    var ang = (curTOD - 6) / 12 * Math.PI;
    var sx = Math.cos(ang) * 160, sy = Math.sin(ang) * 160, sz = 60;
    var sunI = s.sun * 0.45 * mute;
    sunLight.position.set(sx, sy, sz);
    sunLight.intensity = sunI;
    sunLight.color.copy(s.sunColor);
    // soften shadows under cloud cover
    sunLight.shadow.intensity = 0.55 + 0.45 * mute;
    hemiLight.intensity = s.hemi * (0.75 + 0.25 * mute);
    ambLight.intensity = s.amb;

    // moon: cool fill light, crossfades in as the sun hands off (twilight blend)
    var mang = ((curTOD + 12) % 24 - 6) / 12 * Math.PI;
    var mx = Math.cos(mang) * 160, my = Math.sin(mang) * 160;
    var moonI = s.moon * 0.55 * (0.6 + 0.4 * mute);
    moonLight.position.set(mx, Math.max(my, 30), -140);
    moonLight.intensity = moonI;

    sunSprite.material.color.copy(s.sunColor);
    // sun/moon billboards are positioned per-frame in onTick (camera-relative),
    // so they read as "sun in the sky" / "moon in the top-right" like the reference
    sunSprite.material.opacity = sunF;
    moonSprite.material.opacity = clamp(nightF * 1.2, 0, 1) * 0.98;

    starMat.opacity = s.star * mute;
    starBase = starMat.opacity;

    // lamps burn brighter in gloom
    var lampF = clamp(s.lamp + (1 - mute) * 0.5, 0, 1);
    var li = 0.15 + lampF * 2.4;
    lamps.forEach(function (L) {
      L.bulbMat.emissiveIntensity = 0.3 + lampF * 2.6;
      L.glowMat.opacity = 0.10 + lampF * 0.55;
    });
    lampLights.forEach(function (pl) { pl.intensity = lampF * 1.6; });
    windows.forEach(function (m) { m.emissiveIntensity = li; });

    // selective bloom: gentle by day, a touch stronger at night (never touches the main render)
    if (window.GlowBloom) {
      window.GlowBloom.setStrength((0.45 + nightF * 0.55) * (0.7 + 0.3 * mute));
    }
    // cottage windows glow warm at night
    cottageWindows.forEach(function (w) {
      w.mat.color.copy(cottageWinDay).lerp(cottageWinNight, nightF);
      if (w.glowMat) w.glowMat.opacity = 0.03 + nightF * 0.26;
    });
    // lantern posts burn with the lamps (main-scene glow only)
    lanterns.forEach(function (L) {
      L.bulbMat.emissiveIntensity = 0.4 + lampF * 2.4;
      L.glowMat.opacity = 0.08 + lampF * 0.5;
    });
    // golden-hour light shafts + a fatter sun glow
    var sunElev = Math.sin((curTOD - 6) / 12 * Math.PI); // 1 noon, 0 at 6h/18h
    var shaftF = clamp(1 - Math.abs(sunElev - 0.16) * 5.5, 0, 1) * (1 - nightF);
    if (shaftMat) {
      shaftMat.uniforms.uIntensity.value = shaftF * 0.05;
      shaftMat.uniforms.uColor.value.copy(s.sunColor);
    }
    var ss = 150 * (1 + shaftF * 0.45);
    sunSprite.scale.set(ss, ss, 1);
    if (bloomSunGlow) {
      bloomSunGlow.material.opacity = sunF * (0.30 + shaftF * 0.40);
      var bs = 150 * (1 + shaftF * 0.5);
      bloomSunGlow.scale.set(bs, bs, 1);
    }
    if (bloomMoonGlow) bloomMoonGlow.material.opacity = clamp(nightF * 1.2, 0, 1) * 0.55;
    // water shader: sun/moon glint paths + fresnel sky tint
    if (waterUniforms) {
      waterUniforms.uSunDir.value.set(sx, sy, 60).normalize();
      waterUniforms.uMoonDir.value.set(mx, Math.max(my, 30), -140).normalize();
      waterUniforms.uSunF.value = sunF;
      waterUniforms.uNightF.value = nightF;
      waterUniforms.uSunTint.value.copy(s.sunColor);
      waterUniforms.uSkyTint.value.copy(s.skyBot).lerp(s.water, 0.5);
    }
    // water glint streaks in the bloom layer track the sun/moon azimuth
    if (bloomGlint && bloomGlint.length === 2) {
      var glR = 58;
      var sdx = sx, sdz = 60, sl = Math.hypot(sdx, sdz) || 1;
      var g0 = bloomGlint[0];
      g0.mesh.position.set(sdx / sl * glR, -0.55, sdz / sl * glR);
      g0.mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-sdz / sl, sdx / sl));
      g0.mat.opacity = sunF * 0.5;
      var mdx = mx, mdz = -140, ml = Math.hypot(mdx, mdz) || 1;
      var g1 = bloomGlint[1];
      g1.mesh.position.set(mdx / ml * glR, -0.55, mdz / ml * glR);
      g1.mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-mdz / ml, mdx / ml));
      g1.mat.opacity = nightF * 0.38;
    }

    waterMesh.material.color.copy(s.water);
  }

  // ---------- builders ----------
  function buildSky() {
    var geo = new THREE.SphereGeometry(700, 24, 16);
    skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color('#3a78d8') },
        bottomColor: { value: new THREE.Color('#b8dcf0') }
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vP;' +
        'void main(){ float h = normalize(vP).y; float t = smoothstep(-0.08, 0.55, h);' +
        ' gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0); }'
    });
    scene.add(new THREE.Mesh(geo, skyMat));

    // stars
    var n = 420, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 0.95);
      var r = 640;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) + 20;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    scene.add(new THREE.Points(sg, starMat));

    // sun & moon billboards
    sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture('rgba(255,246,214,1)', 'rgba(255,180,60,0)'),
      transparent: true, fog: false, depthWrite: false
    }));
    sunSprite.scale.set(150, 150, 1);
    scene.add(sunSprite);
    moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeMoonTexture(),
      transparent: true, fog: false, depthWrite: false, opacity: 0
    }));
    moonSprite.scale.set(90, 90, 1);
    scene.add(moonSprite);
  }

  function buildFireflies() {
    var n = 70;
    var pos = new Float32Array(n * 3);
    fireflyBase = new Float32Array(n * 3);
    fireflyPhase = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var r = 6 + Math.random() * (R - 10);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      var y = 1.0 + groundHeight(x, z) + 1.2 + Math.random() * 2.4;
      fireflyBase[i * 3] = x; fireflyBase[i * 3 + 1] = y; fireflyBase[i * 3 + 2] = z;
      fireflyPhase[i] = Math.random() * 6.28;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fireflies = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xd8ff9e, size: 0.55, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    scene.add(fireflies);
  }

  function buildWater() {
    waterGeo = new THREE.PlaneGeometry(900, 900, 42, 42);
    waterGeo.rotateX(-Math.PI / 2);
    var mat = new THREE.MeshPhongMaterial({ color: '#2f7fc4', transparent: true, opacity: 0.92, shininess: 120, specular: 0x99ccee });
    // sun/moon glint paths + fresnel sheen, injected into the phong shader
    waterUniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunF: { value: 1 },
      uNightF: { value: 0 },
      uSunTint: { value: new THREE.Color('#fff2dd') },
      uMoonTint: { value: new THREE.Color('#bcd6ff') },
      uSkyTint: { value: new THREE.Color('#b8dcf0') }
    };
    mat.onBeforeCompile = function (shader) {
      Object.keys(waterUniforms).forEach(function (k) { shader.uniforms[k] = waterUniforms[k]; });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uTime;\nuniform vec3 uSunDir;\nuniform vec3 uMoonDir;\nuniform float uSunF;\nuniform float uNightF;\nuniform vec3 uSunTint;\nuniform vec3 uMoonTint;\nuniform vec3 uSkyTint;')
        .replace('#include <output_fragment>',
          '{\n' +
          ' vec3 Vv = normalize(cameraPosition - vWPos);\n' +
          ' vec3 Nn = normalize(vWNormal + vec3(sin(vWPos.x * 0.55 + uTime * 1.2) * 0.06, 0.0, cos(vWPos.z * 0.62 - uTime * 0.9) * 0.06));\n' +
          ' vec3 Rr = reflect(-Vv, Nn);\n' +
          ' float sd = max(dot(Rr, uSunDir), 0.0);\n' +
          ' float md = max(dot(Rr, uMoonDir), 0.0);\n' +
          ' float sunGlint = pow(sd, 220.0) * 2.2 + pow(sd, 18.0) * 0.16;\n' +
          ' float moonGlint = pow(md, 220.0) * 1.5 + pow(md, 18.0) * 0.10;\n' +
          ' outgoingLight += uSunTint * sunGlint * uSunF;\n' +
          ' outgoingLight += uMoonTint * moonGlint * uNightF;\n' +
          ' float fres = pow(1.0 - max(dot(Vv, Nn), 0.0), 3.0);\n' +
          ' outgoingLight = mix(outgoingLight, uSkyTint, fres * 0.40);\n' +
          '}\n' +
          '#include <output_fragment>');
    };
    waterMesh = new THREE.Mesh(waterGeo, mat);
    waterMesh.position.y = -0.8;
    waterMesh.receiveShadow = true;
    scene.add(waterMesh);
    waterGeo.userData.base = waterGeo.attributes.position.array.slice();
  }

  function buildIsland() {
    // sand rim disc
    var sandMat = new THREE.MeshLambertMaterial({ color: '#e8d29a' });
    var rim = new THREE.Mesh(new THREE.CylinderGeometry(R, R + 4, 5, 72), sandMat);
    rim.position.y = -1.5; // top at y=1.0
    rim.receiveShadow = true;
    scene.add(rim);

    // grass top with vertex noise from groundHeight
    var gg = new THREE.CircleGeometry(R - 0.6, 96, 0, Math.PI * 2);
    gg.rotateX(-Math.PI / 2);
    var p = gg.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      p.setY(i, groundHeight(x, z));
    }
    gg.computeVertexNormals();
    var grass = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ color: '#d9bd8a', vertexColors: false }));
    // Moonwake look: sandy base with subtle variation (olive grass comes as scattered blobs)
    var cols = new Float32Array(p.count * 3);
    var cA = new THREE.Color('#d9bd8a'), cB = new THREE.Color('#cfae7c');
    for (var j = 0; j < p.count; j++) {
      var gx = p.getX(j), gz = p.getZ(j);
      var t = 0.5 + 0.5 * Math.sin(gx * 0.35 + gz * 0.5);
      var cc = cA.clone().lerp(cB, t);
      cols[j * 3] = cc.r; cols[j * 3 + 1] = cc.g; cols[j * 3 + 2] = cc.b;
    }
    gg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    grass.material.vertexColors = true;
    grass.position.y = 1.0;
    grass.receiveShadow = true;
    scene.add(grass);

    // center plaza
    var plaza = new THREE.Mesh(new THREE.CircleGeometry(5.5, 40), new THREE.MeshLambertMaterial({ color: '#d9cfae' }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 1.0 + groundHeight(0, 0) + 0.06;
    plaza.receiveShadow = true;
    scene.add(plaza);
  }

  function buildPaths() {
    var places = CFG.places || [];
    places.forEach(function (pl) {
      var dx = pl.x, dz = pl.z;
      var len = Math.sqrt(dx * dx + dz * dz);
      if (len < 6) return;
      var geo = new THREE.PlaneGeometry(2.6, len - 6);
      geo.rotateX(-Math.PI / 2);
      var m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#c4a06e' }));
      var mx = dx / 2, mz = dz / 2;
      m.position.set(mx, 1.0 + groundHeight(mx, mz) + 0.09, mz);
      m.rotation.y = Math.atan2(dx, dz);
      m.receiveShadow = true;
      scene.add(m);
    });
  }

  // Moonwake-style place label: white pill, dark text, "» " prefix.
  // Like makeLabelSprite(light) but the canvas width is measured from the text,
  // since makeLabelSprite's fixed 256px canvas clips longer names such as
  // "» Delphine Roux's place" (~340px at 30px font).
  function makePlaceLabel(text) {
    var meas = makeCanvas(16, 72).getContext('2d');
    meas.font = '600 30px system-ui, sans-serif';
    var w = Math.ceil(meas.measureText(text).width) + 56;
    var c = makeCanvas(w, 72);
    var ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    roundedPill(ctx, 4, 10, w - 8, 52, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,35,50,0.14)';
    ctx.lineWidth = 2;
    roundedPill(ctx, 4, 10, w - 8, 52, 26);
    ctx.stroke();
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2a3040';
    ctx.fillText(text, w / 2, 38);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    var h = 2.0;
    sp.scale.set(h * (w / 72), h, 1);
    return sp;
  }

  // Moonwake-style: small outdoor plaza — round stone patio disc, café tables,
  // parasol umbrellas, benches, planters. No houses.
  function buildPatio(pl) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(pl.x, pl.z);
    var accent = new THREE.Color(pl.color != null ? pl.color : 0xffc46b);
    var cream = new THREE.Color('#f3e7c8');

    function shadowed(mesh) { mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }

    // round stone patio disc
    var disc = shadowed(new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.35, 0.3, 36),
      new THREE.MeshLambertMaterial({ color: '#ddd2b8' })
    ));
    disc.position.y = 0.02;
    g.add(disc);
    var topY = 0.17;

    // café tables: cylinder top + pole leg (2–3)
    var tableCount = 2 + (Math.random() < 0.5 ? 1 : 0);
    var tablePts = [];
    var tableAngles = [0.6, 2.7, 4.5];
    for (var ti = 0; ti < tableCount; ti++) {
      var ta = tableAngles[ti] + Math.random() * 0.3;
      var tr = 1.5 + Math.random() * 0.7;
      var tx = Math.cos(ta) * tr, tz = Math.sin(ta) * tr;
      tablePts.push({ x: tx, z: tz });
      var leg = shadowed(new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.08, 0.95, 8),
        new THREE.MeshLambertMaterial({ color: '#6b5a44' })
      ));
      leg.position.set(tx, topY + 0.475, tz);
      g.add(leg);
      var top = shadowed(new THREE.Mesh(
        new THREE.CylinderGeometry(0.68, 0.68, 0.08, 20),
        new THREE.MeshLambertMaterial({ color: '#efe6cf' })
      ));
      top.position.set(tx, topY + 0.99, tz);
      g.add(top);
    }

    // parasol umbrellas over 1–2 tables: thin pole + cone canopy (accent, alternating cream)
    var umbCount = Math.min(tablePts.length, 1 + (Math.random() < 0.5 ? 1 : 0));
    var strMat = new THREE.MeshLambertMaterial({
      color: '#fff2c8', emissive: new THREE.Color('#ffca7a'), emissiveIntensity: 0.15
    });
    windows.push(strMat); // brightens at night via the existing lamp code
    for (var ui = 0; ui < umbCount; ui++) {
      var tp = tablePts[ui];
      var ux = tp.x + 0.85, uz = tp.z + 0.35;
      var pole = shadowed(new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.06, 2.9, 8),
        new THREE.MeshLambertMaterial({ color: '#7a6248' })
      ));
      pole.position.set(ux, topY + 1.45, uz);
      g.add(pole);
      var canopy = shadowed(new THREE.Mesh(
        new THREE.ConeGeometry(1.55, 0.8, 10),
        new THREE.MeshLambertMaterial({ color: ui % 2 === 0 ? accent : cream })
      ));
      canopy.position.set(ux, topY + 3.05, uz);
      g.add(canopy);
      // string lights on the first umbrella pole: two tiny warm bulbs
      if (ui === 0) {
        [1.5, 2.15].forEach(function (by) {
          var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), strMat);
          bulb.position.set(ux + 0.12, topY + by, uz);
          g.add(bulb);
        });
      }
    }

    // benches: box seat + legs (1–2)
    var benchCount = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (var bi = 0; bi < benchCount; bi++) {
      var ba = 3.4 + bi * 2.2 + Math.random() * 0.4;
      var bench = new THREE.Group();
      var seat = shadowed(new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.14, 0.55),
        new THREE.MeshLambertMaterial({ color: '#a9805a' })
      ));
      seat.position.y = 0.55;
      bench.add(seat);
      [-0.75, 0.75].forEach(function (lx) {
        var legB = shadowed(new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 0.55, 0.5),
          new THREE.MeshLambertMaterial({ color: '#7a5a3c' })
        ));
        legB.position.set(lx, 0.275, 0);
        bench.add(legB);
      });
      bench.position.set(Math.cos(ba) * 3.0, topY, Math.sin(ba) * 3.0);
      bench.rotation.y = -ba + Math.PI / 2;
      g.add(bench);
    }

    // planters: terracotta pot + green blob (2–3)
    var potColors = [0xb5673f, 0xa85f3a, 0xc07a4a];
    var leafColors = [0x4a7d3a, 0x5c9148, 0x3f7d44];
    var planterCount = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (var pi = 0; pi < planterCount; pi++) {
      var pa = 1.2 + pi * 2.4 + Math.random() * 0.4;
      var px = Math.cos(pa) * 3.55, pz = Math.sin(pa) * 3.55;
      var pot = shadowed(new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.26, 0.5, 12),
        new THREE.MeshLambertMaterial({ color: potColors[pi % 3] })
      ));
      pot.position.set(px, topY + 0.25, pz);
      g.add(pot);
      var bush = shadowed(new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 10),
        new THREE.MeshLambertMaterial({ color: leafColors[pi % 3] })
      ));
      bush.scale.y = 0.75;
      bush.position.set(px, topY + 0.62, pz);
      g.add(bush);
    }

    g.position.set(pl.x, gy, pl.z);
    g.rotation.y = Math.atan2(-pl.x, -pl.z); // face plaza
    scene.add(g);

    // floating white pill label
    var label = makePlaceLabel('» ' + (pl.name || pl.id || 'Place'));
    label.position.set(pl.x, gy + 6, pl.z);
    scene.add(label);
    labelSprites.push(label);
  }

  function buildLamp(x, z) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(x, z);
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 3.4, 8), new THREE.MeshLambertMaterial({ color: '#2c2c34' }));
    pole.position.y = 1.7;
    pole.castShadow = true;
    g.add(pole);
    var bulbMat = new THREE.MeshLambertMaterial({ color: '#fff2c8', emissive: new THREE.Color('#ffcf7a'), emissiveIntensity: 1.0 });
    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), bulbMat);
    bulb.position.y = 3.6;
    g.add(bulb);
    var glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture('rgba(255,210,130,0.9)', 'rgba(255,170,60,0)'),
      transparent: true, opacity: 0.4, depthWrite: false
    });
    var glow = new THREE.Sprite(glowMat);
    glow.scale.set(3.2, 3.2, 1);
    glow.position.y = 3.6;
    g.add(glow);
    g.position.set(x, gy, z);
    scene.add(g);
    lamps.push({ bulbMat: bulbMat, glowMat: glowMat, glow: glow, phase: Math.random() * 6.28, x: x, y: gy + 3.6, z: z });
    // a few real point lights for warm pools of light at night (perf-capped)
    if (lampLights.length < 3) {
      var pl = new THREE.PointLight(0xffc37a, 0, 22, 2);
      pl.position.set(x, gy + 3.6, z);
      scene.add(pl);
      lampLights.push(pl);
    }
  }

  // ---------- cozy cottages (Moonwake night reference: warm glowing windows) ----------
  var cottageWinDay = new THREE.Color('#8d99a4');
  var cottageWinNight = new THREE.Color('#ffd98a');

  function buildCottage(x, z, rotY, bodyColor, roofColor) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(x, z);
    function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
    var body = shadowed(new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 2.3, 3.0),
      new THREE.MeshLambertMaterial({ color: bodyColor })
    ));
    body.position.y = 1.15;
    g.add(body);
    // pyramid roof with slight overhang
    var roof = shadowed(new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 2.55, 1.8, 4),
      new THREE.MeshLambertMaterial({ color: roofColor, flatShading: true })
    ));
    roof.position.y = 2.3 + 0.9;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 0.92);
    g.add(roof);
    // chimney
    var chim = shadowed(new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 1.3, 0.5),
      new THREE.MeshLambertMaterial({ color: '#8a6a52' })
    ));
    chim.position.set(0.95, 3.7, 0.3);
    g.add(chim);
    // door
    var door = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.45, 0.12),
      new THREE.MeshLambertMaterial({ color: '#6b4a33' })
    );
    door.position.set(0, 0.72, 1.51);
    g.add(door);
    // windows: warm panes, brighten at night via applyTimeOfDay
    var winMat = new THREE.MeshBasicMaterial({ color: cottageWinDay.clone(), toneMapped: false });
    [[-1.0, 1.45, 1.52, 0], [1.0, 1.45, 1.52, 0], [1.71, 1.45, 0, Math.PI / 2]].forEach(function (w) {
      var pane = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.72), winMat);
      pane.position.set(w[0], w[1], w[2]);
      pane.rotation.y = w[3];
      g.add(pane);
      // cross frame
      var frame = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.08, 0.04),
        new THREE.MeshLambertMaterial({ color: '#5a4632' })
      );
      frame.position.set(w[0], w[1], w[2] + (w[3] === 0 ? 0.02 : 0));
      frame.rotation.y = w[3];
      if (w[3] !== 0) frame.position.set(w[0] + 0.02, w[1], w[2]);
      g.add(frame);
    });
    g.position.set(x, gy, z);
    g.rotation.y = rotY;
    scene.add(g);
    // one shared window material per cottage; single bloom glow sprite
    cottageWindows.push({ mat: winMat });
    if (window.GlowBloom) {
      var gm = new THREE.SpriteMaterial({
        map: makeGlowTexture('rgba(255,205,120,0.95)', 'rgba(255,160,60,0)'),
        transparent: true, opacity: 0.05, depthWrite: false, toneMapped: false
      });
      var gs = new THREE.Sprite(gm);
      gs.position.set(x, gy + 1.9, z);
      gs.scale.set(5.5, 5.5, 1);
      window.GlowBloom.addCaster(gs);
      cottageWindows[cottageWindows.length - 1].glowMat = gm;
    }
  }

  function buildCottages() {
    // hand-placed: clear of patios and path strips (verified against config places)
    var defs = [
      { x: -26, z: 4, body: '#f2e3c2', roof: '#b3563f' },
      { x: 26, z: -12, body: '#dfe8d8', roof: '#5a6e8c' },
      { x: 10, z: 30, body: '#f6d9c4', roof: '#a34a3a' },
      { x: -30, z: -6, body: '#e3ddf0', roof: '#4e5e78' }
    ];
    defs.forEach(function (d) {
      // face the door/windows toward the village center
      buildCottage(d.x, d.z, Math.atan2(-d.x, -d.z), d.body, d.roof);
    });
  }

  // ---------- path lantern posts ----------
  function buildLantern(x, z) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(x, z);
    var pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.1, 2.6, 8),
      new THREE.MeshLambertMaterial({ color: '#2c2c34' })
    );
    pole.position.y = 1.3;
    pole.castShadow = true;
    g.add(pole);
    var cap = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.3, 8),
      new THREE.MeshLambertMaterial({ color: '#2c2c34' })
    );
    cap.position.y = 2.95;
    g.add(cap);
    var bulbMat = new THREE.MeshLambertMaterial({
      color: '#ffe9b8', emissive: new THREE.Color('#ffb45e'), emissiveIntensity: 1.0
    });
    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), bulbMat);
    bulb.position.y = 2.62;
    g.add(bulb);
    var glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture('rgba(255,200,120,0.9)', 'rgba(255,160,60,0)'),
      transparent: true, opacity: 0.35, depthWrite: false
    });
    var glow = new THREE.Sprite(glowMat);
    glow.scale.set(2.8, 2.8, 1);
    glow.position.y = 2.62;
    g.add(glow);
    g.position.set(x, gy, z);
    scene.add(g);
    // bloom-layer caster intentionally omitted: the main-scene glow sprite
    // above already gives the halo; a second caster stacked into white blobs.
    lanterns.push({ bulbMat: bulbMat, glowMat: glowMat });
  }

  // ---------- small props: planters, crates, pebbles, grass tufts ----------
  var propMats = null;
  function getPropMats() {
    if (!propMats) {
      propMats = {
        terra: new THREE.MeshLambertMaterial({ color: '#b06a45' }),
        bush: new THREE.MeshLambertMaterial({ color: '#5d8a48' }),
        wood: new THREE.MeshLambertMaterial({ color: '#a9805a' }),
        woodDark: new THREE.MeshLambertMaterial({ color: '#7a5a3c' }),
        pebble: new THREE.MeshLambertMaterial({ color: '#9a9a92' }),
        tuft: new THREE.MeshLambertMaterial({ color: '#7da05a' })
      };
    }
    return propMats;
  }

  function scatterProps() {
    var M = getPropMats();
    var places = CFG.places || [];
    function put(mesh, x, z, sink) {
      mesh.position.set(x, 1.0 + groundHeight(x, z) - (sink || 0), z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
    // lantern posts along the paths to a few places (offset from the path strip)
    [['tidework'], ['cafe'], ['workshop'], ['dock']].forEach(function (pick) {
      var pl = null;
      places.forEach(function (p) { if (p.id === pick[0]) pl = p; });
      if (!pl) return;
      var len = Math.hypot(pl.x, pl.z) || 1;
      var dx = pl.x / len, dz = pl.z / len;
      var nx = -dz, nz = dx;
      [[0.45, 1], [0.75, -1]].forEach(function (tt) {
        buildLantern(pl.x * tt[0] + nx * 2.6 * tt[1], pl.z * tt[0] + nz * 2.6 * tt[1]);
      });
    });
    // planters ringing patios
    places.forEach(function (pl, pi) {
      var a = 0.6 + pi * 1.7;
      var px = pl.x + Math.cos(a) * 5.2, pz = pl.z + Math.sin(a) * 5.2;
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.38, 0.62, 10), M.terra);
      put(pot, px, pz, -0.31);
      var bush = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), M.bush);
      put(bush, px, pz, -0.75);
    });
    // crates near two patios
    var crateSpots = [[4.5, 7.5, 0.3], [5.6, 6.8, 1.1], [5.1, 7.6, 0.7, true], [-11, -13.5, 0.9], [-10, -12.6, 0.2]];
    crateSpots.forEach(function (c) {
      var box = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), c[3] ? M.woodDark : M.wood);
      box.rotation.y = c[2];
      put(box, c[0], c[1], c[3] ? -1.35 : -0.48);
    });
    // pebbles + grass tufts scattered, kept off paths and patios
    var placed = 0, tries = 0;
    while (placed < 14 && tries < 300) {
      tries++;
      var a = Math.random() * Math.PI * 2, r = 8 + Math.random() * (R - 12);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!clearOfPlaces(x, z, 4)) continue;
      if (distToPaths(x, z) < 1.6) continue;
      var s = 0.16 + Math.random() * 0.22;
      var peb = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), M.pebble);
      peb.scale.y = 0.55;
      put(peb, x, z, -s * 0.25);
      placed++;
    }
    placed = 0; tries = 0;
    while (placed < 18 && tries < 400) {
      tries++;
      var a2 = Math.random() * Math.PI * 2, r2 = 8 + Math.random() * (R - 12);
      var x2 = Math.cos(a2) * r2, z2 = Math.sin(a2) * r2;
      if (Math.sqrt(x2 * x2 + z2 * z2) < 7) continue;
      if (!clearOfPlaces(x2, z2, 4)) continue;
      if (distToPaths(x2, z2) < 1.1) continue;
      var tuft = new THREE.Group();
      for (var k = 0; k < 3; k++) {
        var blade = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.75, 6), M.tuft);
        blade.position.set((Math.random() - 0.5) * 0.3, 0.32, (Math.random() - 0.5) * 0.3);
        blade.rotation.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
        blade.castShadow = true;
        tuft.add(blade);
      }
      put(tuft, x2, z2, -0.05);
      placed++;
    }
  }

  // ---------- golden-hour light shafts (cheap fake volumetrics) ----------
  function buildShafts() {
    shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color('#ffca7a') },
        uIntensity: { value: 0 }
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv;' +
        'void main(){' +
        ' float a = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));' +
        ' a *= smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));' +
        ' gl_FragColor = vec4(uColor, a * uIntensity); }'
    });
    [[-21, -3], [-15, 9], [-25, 7]].forEach(function (s, i) {
      var cone = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 5.0, 30, 12, 1, true), shaftMat);
      var gy = 1.0 + groundHeight(s[0], s[1]);
      cone.position.set(s[0], gy + 13, s[1]);
      cone.rotation.z = 0.42; // lean top toward the evening-sun side (-x)
      cone.rotation.y = i * 1.05;
      cone.renderOrder = 5;
      scene.add(cone);
    });
  }

  // ---------- bloom glow casters ----------
  function registerBloomCasters() {
    if (!window.GlowBloom) return;
    var GB = window.GlowBloom;
    // NOTE: lamp + lantern bulbs already carry soft glow sprites in the main
    // scene; giving them bloom-layer casters too stacked into white blobs.
    // The bloom layer is reserved for large soft halos (sun/moon), fireflies,
    // cottage windows, and water glints.
    // moon + sun halo followers (positions copied per-frame in onTick)
    function halo(inner, size) {
      var m = new THREE.SpriteMaterial({
        map: makeGlowTexture(inner, 'rgba(255,255,255,0)'),
        transparent: true, opacity: 0, depthWrite: false, toneMapped: false, fog: false
      });
      var sp = new THREE.Sprite(m);
      sp.scale.set(size, size, 1);
      GB.addCaster(sp);
      return sp;
    }
    bloomMoonGlow = halo('rgba(220,232,255,0.9)', 110);
    bloomSunGlow = halo('rgba(255,236,190,1)', 170);
    // fireflies: share the drift geometry, slightly larger/softer additive points
    if (fireflies) {
      var fm = new THREE.PointsMaterial({
        color: 0xeaffb0, size: 0.5, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
      });
      bloomFireflies = new THREE.Points(fireflies.geometry, fm);
      GB.addCaster(bloomFireflies);
    }
    // water glint streaks: sun (warm) + moon (cool), laid flat on the water
    function glintStreak(color) {
      var m = new THREE.MeshBasicMaterial({
        map: makeGlowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
        color: color, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
      });
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(36, 11), m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -0.55;
      GB.addCaster(mesh);
      return { mesh: mesh, mat: m };
    }
    bloomGlint = [glintStreak(0xffd9a0), glintStreak(0xbcd6ff)];
  }

  function buildPalm(x, z) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(x, z);
    var tilt = (Math.random() - 0.5) * 0.25;
    var trunkH = 4 + Math.random() * 2;
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, trunkH, 7), new THREE.MeshLambertMaterial({ color: '#8a6a44' }));
    trunk.position.y = trunkH / 2;
    trunk.rotation.z = tilt;
    trunk.castShadow = true;
    g.add(trunk);
    var topY = trunkH, topX = -Math.sin(tilt) * trunkH / 2;
    var frondMat = new THREE.MeshLambertMaterial({ color: '#3f9e4d', side: THREE.DoubleSide });
    for (var i = 0; i < 7; i++) {
      var fr = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 3.2), frondMat);
      var a = (i / 7) * Math.PI * 2 + Math.random() * 0.3;
      fr.position.set(topX + Math.cos(a) * 1.3, topY - 0.35, Math.sin(a) * 1.3);
      fr.rotation.y = -a + Math.PI / 2;
      fr.rotation.x = -0.5 - Math.random() * 0.25;
      fr.castShadow = true;
      g.add(fr);
    }
    // coconuts
    var nut = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshLambertMaterial({ color: '#6b4a2c' }));
    nut.position.set(topX + 0.3, topY - 0.5, 0.2);
    g.add(nut);
    g.position.set(x, gy, z);
    g.rotation.y = Math.random() * Math.PI * 2;
    scene.add(g);
  }

  // shared placement rule: keep clear of every place patio
  function clearOfPlaces(x, z, minD) {
    var places = CFG.places || [];
    for (var i = 0; i < places.length; i++) {
      var dx = x - places[i].x, dz = z - places[i].z;
      if (dx * dx + dz * dz < minD * minD) return false;
    }
    return true;
  }

  function scatterPalms() {
    var placed = 0, tries = 0;
    while (placed < 24 && tries < 400) {
      tries++;
      var a = Math.random() * Math.PI * 2;
      var r = 9 + Math.random() * (R - 13);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!clearOfPlaces(x, z, 6)) continue;
      buildPalm(x, z);
      placed++;
    }
  }

  // lollipop tree: thin brown trunk + 1–3 dark-green sphere canopy
  function buildLollipop(x, z) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(x, z);
    var s = 0.85 + Math.random() * 0.45;
    var trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.15, 2.5, 7),
      new THREE.MeshLambertMaterial({ color: '#7a5a38' })
    );
    trunk.position.y = 1.25;
    trunk.castShadow = true;
    g.add(trunk);
    var puffs = 1 + Math.floor(Math.random() * 3);
    var greens = [0x3f7d44, 0x478a4b, 0x39703d];
    for (var i = 0; i < puffs; i++) {
      var pr = 0.9 + Math.random() * 0.4;
      var puff = new THREE.Mesh(
        new THREE.SphereGeometry(pr, 14, 12),
        new THREE.MeshLambertMaterial({ color: greens[i % 3] })
      );
      puff.position.set((Math.random() - 0.5) * 1.2, 2.7 + Math.random() * 0.9, (Math.random() - 0.5) * 1.2);
      puff.castShadow = true; puff.receiveShadow = true;
      g.add(puff);
    }
    g.position.set(x, gy, z);
    g.scale.setScalar(s);
    g.rotation.y = Math.random() * Math.PI * 2;
    scene.add(g);
  }

  function scatterLollipops() {
    var placed = 0, tries = 0;
    while (placed < 14 && tries < 300) {
      tries++;
      var a = Math.random() * Math.PI * 2;
      var r = 9 + Math.random() * (R - 13);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!clearOfPlaces(x, z, 6)) continue;
      buildLollipop(x, z);
      placed++;
    }
  }

  // distance from (x,z) to the nearest place path strip (center -> place)
  function distToPaths(x, z) {
    var places = CFG.places || [];
    var best = 1e9;
    for (var i = 0; i < places.length; i++) {
      var px = places[i].x, pz = places[i].z;
      var len2 = px * px + pz * pz;
      var t = len2 > 0 ? (x * px + z * pz) / len2 : 0;
      t = clamp(t, 0, 1);
      var dx = x - px * t, dz = z - pz * t;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
    return best;
  }

  // Moonwake olive-grass: scattered soft flattened blobs, half-sunk in the sand
  function scatterGrassBlobs() {
    var blobCols = [0x7a9a4e, 0x86a854, 0x8fae5a];
    var placedPts = [];
    var placed = 0, tries = 0;
    while (placed < 26 && tries < 600) {
      tries++;
      var a = Math.random() * Math.PI * 2;
      var r = 8 + Math.random() * (R - 12);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      var br = 1.5 + Math.random() * 2.5; // scale 1.5–4
      if (Math.sqrt(x * x + z * z) < 7 + br) continue;   // keep the center plaza clear
      if (!clearOfPlaces(x, z, 6.5 + br)) continue;       // keep patios clear
      if (distToPaths(x, z) < 2.0 + br) continue;         // keep paths clear
      var ok = true;
      for (var i = 0; i < placedPts.length; i++) {
        var dx = x - placedPts[i].x, dz = z - placedPts[i].z;
        if (dx * dx + dz * dz < 6.25) { ok = false; break; }
      }
      if (!ok) continue;
      var blob = new THREE.Mesh(
        new THREE.SphereGeometry(br, 14, 10),
        new THREE.MeshLambertMaterial({ color: blobCols[placed % 3] })
      );
      blob.scale.y = 0.32;
      blob.rotation.y = Math.random() * Math.PI * 2;
      blob.position.set(x, 1.0 + groundHeight(x, z) - br * 0.05, z);
      blob.receiveShadow = true;
      scene.add(blob);
      placedPts.push({ x: x, z: z });
      placed++;
    }
  }

  // ---------- daytime sparkles ----------
  var sparkles = null, sparkBase = null, sparkPhase = null, sparkT = 0;
  function buildSparkles() {
    var n = 50;
    var pos = new Float32Array(n * 3);
    sparkBase = new Float32Array(n * 3);
    sparkPhase = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var r = 4 + Math.random() * (R - 8);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      var y = 1.0 + groundHeight(x, z) + 2.5 + Math.random() * 5;
      sparkBase[i * 3] = x; sparkBase[i * 3 + 1] = y; sparkBase[i * 3 + 2] = z;
      sparkPhase[i] = Math.random() * 6.28;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sparkles = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xfff3cf, size: 0.5, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    scene.add(sparkles);
    // onTick is owned by the main loop; drift on a lightweight timer instead
    setInterval(function () {
      if (!sparkles) return;
      sparkT += 0.09;
      var p = sparkles.geometry.attributes.position;
      for (var i = 0; i < p.count; i++) {
        var ph = sparkPhase[i];
        p.setX(i, sparkBase[i * 3] + Math.sin(sparkT * 0.45 + ph) * 2.2);
        p.setY(i, sparkBase[i * 3 + 1] + Math.sin(sparkT * 0.7 + ph * 1.7) * 0.9);
        p.setZ(i, sparkBase[i * 3 + 2] + Math.cos(sparkT * 0.35 + ph) * 2.2);
      }
      p.needsUpdate = true;
      // visible in day, fading out at night when the fireflies take over
      sparkles.material.opacity = (1 - nightF) * (0.4 + 0.25 * Math.sin(sparkT * 1.8));
    }, 90);
  }

  function buildClouds() {
    var tex = makeCloudTexture();
    for (var i = 0; i < 12; i++) {
      var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false });
      var sp = new THREE.Sprite(mat);
      var s = 26 + Math.random() * 30;
      sp.scale.set(s, s * 0.45, 1);
      sp.position.set((Math.random() - 0.5) * 260, 42 + Math.random() * 26, (Math.random() - 0.5) * 260);
      sp.userData.speed = 0.7 + Math.random() * 0.9;
      scene.add(sp);
      clouds.push(sp);
    }
  }

  function buildRain() {
    var n = 900;
    var pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 1] = Math.random() * 40 + 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var m = new THREE.PointsMaterial({ color: 0xaaccee, size: 0.55, transparent: true, opacity: 0.8 });
    rain = new THREE.Points(g, m);
    rain.visible = false;
    scene.add(rain);
  }

  // ---------- camera ----------
  function applyCamera() {
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    camera.position.set(
      cam.tx + cam.dist * cp * Math.cos(cam.yaw),
      cam.ty + cam.dist * sp,
      cam.tz + cam.dist * cp * Math.sin(cam.yaw)
    );
    camera.lookAt(cam.tx, cam.ty, cam.tz);
  }

  function startTween(to, dur) {
    tween = {
      t: 0,
      dur: dur || 1.4,
      from: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, tz: cam.tz },
      to: to
    };
  }

  function updateTween(dt) {
    if (!tween) return;
    tween.t += dt;
    var k = easeInOut(clamp(tween.t / tween.dur, 0, 1));
    var f = tween.from, to = tween.to;
    cam.yaw = lerp(f.yaw, to.yaw, k);
    cam.pitch = lerp(f.pitch, to.pitch, k);
    cam.dist = lerp(f.dist, to.dist, k);
    cam.tx = lerp(f.tx, to.tx, k);
    cam.ty = lerp(f.ty, to.ty, k);
    cam.tz = lerp(f.tz, to.tz, k);
    if (tween.t >= tween.dur) tween = null;
  }

  // ---------- input ----------
  var dragState = null;

  function setupInput() {
    var el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', function (e) {
      tween = null; // user takes over
      dragState = { x: e.clientX, y: e.clientY, moved: 0 };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.x, dy = e.clientY - dragState.y;
      dragState.x = e.clientX; dragState.y = e.clientY;
      dragState.moved += Math.abs(dx) + Math.abs(dy);
      cam.yaw -= dx * 0.0052;
      cam.pitch = clamp(cam.pitch + dy * 0.0042, 0.15, 1.2);
    });
    el.addEventListener('pointerup', function (e) {
      var wasClick = dragState && dragState.moved < 6;
      dragState = null;
      if (wasClick) handleClick(e);
    });
    el.addEventListener('pointercancel', function () { dragState = null; });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      tween = null;
      cam.dist = clamp(cam.dist * (1 + e.deltaY * 0.0011), 10, 170);
    }, { passive: false });
  }

  var raycaster = null;
  function handleClick(e) {
    if (!raycaster) raycaster = new THREE.Raycaster();
    var rect = renderer.domElement.getBoundingClientRect();
    var nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({ x: nx, y: ny }, camera);
    var targets = [];
    Object.keys(agents).forEach(function (id) { targets.push(agents[id].group); });
    if (!targets.length) return;
    var hits = raycaster.intersectObjects(targets, true);
    if (hits.length) {
      var o = hits[0].object;
      while (o && !o.userData.agentId) o = o.parent;
      if (o && window.UI && typeof window.UI.openChat === 'function') {
        window.UI.openChat(o.userData.agentId);
      }
    } else {
      // empty ground click: drop any follow and close an open chat
      if (window.Island && typeof window.Island.unfollow === 'function') window.Island.unfollow();
      if (window.UI && typeof window.UI.closeChat === 'function') window.UI.closeChat();
    }
  }

  // ---------- agent figures ----------
  // Legacy capsule figure kept as a fallback when window.Chibi is unavailable.
  function buildLegacyAgentMesh(colorHex) {
    var g = new THREE.Group();
    var col = new THREE.Color(colorHex || '#66aaff');
    var body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.5, 0.85, 4, 12),
      new THREE.MeshLambertMaterial({ color: col })
    );
    body.position.y = 1.15;
    body.castShadow = true;
    g.add(body);
    var head = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 14, 12),
      new THREE.MeshLambertMaterial({ color: 0xf2c89b })
    );
    head.position.y = 2.15;
    head.castShadow = true;
    g.add(head);
    var eyeMat = new THREE.MeshBasicMaterial({ color: 0x1c1c22 });
    [-0.13, 0.13].forEach(function (ex) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), eyeMat);
      eye.position.set(ex, 2.2, 0.32);
      g.add(eye);
    });
    var ringMat = new THREE.MeshBasicMaterial({ color: 0x7fe07f, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.92, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    g.add(ring);
    g.userData.body = body;
    g.userData.head = head;
    g.userData.ringMat = ringMat;
    return g;
  }

  function addAgentMesh(id, colorHex, name) {
    if (agents[id]) removeAgentMesh(id);
    var g;
    if (window.Chibi && window.Chibi.defFor && window.Chibi.build) {
      try {
        g = window.Chibi.build(window.Chibi.defFor(name || id, colorHex));
      } catch (e) { g = null; }
    }
    if (!g) g = buildLegacyAgentMesh(colorHex);

    // Moonwake-style white name pill floating above the head
    var label = makeLabelSprite(name || id, 0.72, true);
    label.position.y = 2.9;
    g.add(label);
    g.userData.agentId = id;
    // record rest heights so the per-frame bobbing matches this figure type
    if (g.userData.body) g.userData.baseBodyY = g.userData.body.position.y;
    if (g.userData.head) g.userData.baseHeadY = g.userData.head.position.y;
    var sx = 0, sz = 0;
    g.position.set(sx, 1.0 + groundHeight(sx, sz), sz);
    scene.add(g);
    agents[id] = {
      group: g,
      ringMat: g.userData.ringMat || null,
      phase: Math.random() * 6.28,
      status: 'idle',
      heading: 0,
      targetHeading: 0,
      lastX: sx,
      lastZ: sz,
      walkPhase: Math.random() * 6.28,
      speedSm: 0,
      blinkT: 1 + Math.random() * 3,
      blinkOn: 0,
      lookT: 4 + Math.random() * 6,
      lookYaw: 0,
      lookHold: 0,
      talkT: 0,
      waveT: 0,
      waveCd: 6 + Math.random() * 8,
      lean: 0,
      label: label,
      labelBaseX: label.scale.x,
      labelBaseY: label.scale.y
    };
    return g;
  }

  function moveAgentMesh(id, x, z, heading) {
    var a = agents[id];
    if (!a) return;
    // Only steer the facing when the agent actually moved: agents.js calls this
    // every tick even while idle, and it must not stomp face-camera / face-event
    // headings set by agentSpeak() / faceToward().
    var moved = Math.abs(x - a.group.position.x) + Math.abs(z - a.group.position.z) > 1e-4;
    a.group.position.x = x;
    a.group.position.z = z;
    a.group.position.y = 1.0 + groundHeight(x, z);
    if (moved && typeof heading === 'number') {
      a.targetHeading = heading; // heading eases toward this in the animation pass
    }
  }

  function setAgentStatus(id, status) {
    var a = agents[id];
    if (!a) return;
    a.status = status;
    if (a.ringMat) a.ringMat.color.set(status === 'working' ? 0xffb347 : 0x7fe07f);
  }

  function removeAgentMesh(id) {
    var a = agents[id];
    if (!a) return;
    scene.remove(a.group);
    delete agents[id];
  }

  // point an agent's heading target toward a world position
  function faceToward(id, x, z) {
    var a = agents[id];
    if (!a) return;
    var p = a.group.position;
    a.targetHeading = Math.atan2(x - p.x, z - p.z);
  }

  // ---------- speech bubbles ----------
  function getBubbleDiv(id) {
    if (!speechLayer) return null;
    for (var i = 0; i < speechLayer.children.length; i++) {
      var d = speechLayer.children[i];
      if (d.getAttribute('data-agent') === id) return d;
    }
    var div = document.createElement('div');
    div.className = 'speech-bubble';
    div.setAttribute('data-agent', id);
    speechLayer.appendChild(div);
    return div;
  }

  // floating speech bubble over an agent's head; also makes the agent talk + face the camera
  function agentSpeak(id, text, durMs) {
    var a = agents[id];
    if (!a) return;
    var d = durMs || 3500;
    a.talkT = d / 1000;
    // face the camera while speaking
    if (camera) {
      var p = a.group.position;
      a.targetHeading = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
    }
    var div = getBubbleDiv(id);
    if (!div) return;
    div.textContent = String(text).slice(0, 140);
    div.style.display = '';
    div.style.visibility = '';
    div.style.opacity = '1';
    if (div._t) { clearTimeout(div._t); div._t = null; }
    div._t = setTimeout(function () {
      div.style.opacity = '0';
      div._t = setTimeout(function () {
        div.style.display = 'none';
        div.style.opacity = '';
        div._t = null;
      }, 400);
    }, d);
  }

  var _bubbleV = null;
  // per-frame: pin each visible bubble above its agent's head
  function updateSpeechBubbles() {
    if (!speechLayer || !camera || !container) return;
    if (!_bubbleV) _bubbleV = new THREE.Vector3();
    var rect = container.getBoundingClientRect();
    var w = rect.width, h = rect.height;
    if (w <= 0 || h <= 0) return;
    for (var i = speechLayer.children.length - 1; i >= 0; i--) {
      var div = speechLayer.children[i];
      var id = div.getAttribute('data-agent');
      var a = agents[id];
      if (!a) { div.style.display = 'none'; continue; }
      if (div.style.display === 'none') continue;
      var ud = a.group.userData;
      _bubbleV.set(0, 0, 0);
      if (ud.headGroup) ud.headGroup.getWorldPosition(_bubbleV);
      else _bubbleV.copy(a.group.position);
      _bubbleV.y += 1.2;
      _bubbleV.project(camera);
      if (_bubbleV.z > 1) { div.style.visibility = 'hidden'; continue; } // behind camera
      div.style.visibility = '';
      var sx = (_bubbleV.x * 0.5 + 0.5) * w;
      var sy = (-_bubbleV.y * 0.5 + 0.5) * h;
      div.style.transform = 'translate(-50%, -100%) translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
    }
  }

  // ---------- weather ----------
  function setWeather(mode) {
    weatherMode = mode;
    var dens = 0.0016, cloudOp = 0.28, cloudCount = 5;
    if (mode === 'Cloudy') { dens = 0.0032; cloudOp = 0.7; cloudCount = 12; }
    else if (mode === 'Rain') { dens = 0.0058; cloudOp = 0.85; cloudCount = 12; }
    scene.fog.density = dens;
    clouds.forEach(function (c, i) {
      c.visible = i < cloudCount;
      c.material.opacity = cloudOp;
      c.userData.baseOp = cloudOp;
    });
    if (rain) rain.visible = (mode === 'Rain');
    // re-apply the palette so weather muting (desaturation/dimming) takes effect
    if (typeof applyTimeOfDay === 'function' && typeof curTOD === 'number') applyTimeOfDay(curTOD);
  }

  // ---------- per-frame ----------
  var wobT = 0;
  function onTick(dt, t) {
    wobT += dt;
    updateTween(dt);
    // follow-cam: ease the camera target onto the followed agent
    // (user drag still adjusts yaw/pitch; wheel zoom still works)
    if (followId && agents[followId]) {
      var fp = agents[followId].group.position;
      var fk = 1 - Math.exp(-4 * dt);
      cam.tx += (fp.x - cam.tx) * fk;
      cam.tz += (fp.z - cam.tz) * fk;
      cam.ty += ((fp.y + 2) - cam.ty) * fk;
    }
    applyCamera();

    // keep the sun/moon billboards in frame (camera-relative sky anchors)
    var _f = new THREE.Vector3(); camera.getWorldDirection(_f);
    var _r = new THREE.Vector3().crossVectors(_f, camera.up).normalize();
    var _u = new THREE.Vector3().crossVectors(_r, _f).normalize();
    sunSprite.position.copy(camera.position)
      .addScaledVector(_f, 500).addScaledVector(_u, 150).addScaledVector(_r, -190);
    moonSprite.position.copy(camera.position)
      .addScaledVector(_f, 500).addScaledVector(_u, 170).addScaledVector(_r, 210);
    // bloom halo followers track the billboards
    if (bloomSunGlow) bloomSunGlow.position.copy(sunSprite.position);
    if (bloomMoonGlow) bloomMoonGlow.position.copy(moonSprite.position);

    // water shimmer: gentle vertex waves + subtle opacity pulse
    if (waterUniforms) waterUniforms.uTime.value = wobT;
    if (waterGeo) {
      var p = waterGeo.attributes.position, base = waterGeo.userData.base;
      for (var i = 0; i < p.count; i += 2) { // stride 2 keeps it cheap
        var bx = base[i * 3], bz = base[i * 3 + 2];
        p.setY(i, Math.sin(bx * 0.06 + wobT * 1.4) * 0.35 + Math.cos(bz * 0.08 + wobT * 1.1) * 0.3);
      }
      p.needsUpdate = true;
      waterGeo.computeVertexNormals();
      waterMesh.material.opacity = 0.90 + Math.sin(wobT * 0.9) * 0.03;
    }

    // star twinkle + firefly drift at night
    if (starMat) starMat.opacity = starBase * (0.9 + 0.1 * Math.sin(wobT * 3.1));
    if (fireflies) {
      var fp = fireflies.geometry.attributes.position;
      for (var fi = 0; fi < fp.count; fi++) {
        var ph = fireflyPhase[fi];
        fp.setX(fi, fireflyBase[fi * 3] + Math.sin(wobT * 0.7 + ph) * 1.6);
        fp.setY(fi, fireflyBase[fi * 3 + 1] + Math.sin(wobT * 1.1 + ph * 2) * 0.7);
        fp.setZ(fi, fireflyBase[fi * 3 + 2] + Math.cos(wobT * 0.5 + ph) * 1.6);
      }
      fp.needsUpdate = true;
      fireflies.material.opacity = nightF * (0.55 + 0.35 * Math.sin(wobT * 2.3));
      if (bloomFireflies) bloomFireflies.material.opacity = nightF * 0.3;
    }

    // cloud drift
    clouds.forEach(function (c) {
      c.position.x += c.userData.speed * dt * 3;
      if (c.position.x > 160) c.position.x = -160;
    });

    // rain fall
    if (rain && rain.visible) {
      var rp = rain.geometry.attributes.position;
      for (var j = 0; j < rp.count; j++) {
        var y = rp.getY(j) - dt * 26;
        if (y < 0) y = 42;
        rp.setY(j, y);
      }
      rp.needsUpdate = true;
    }

    // lamp flicker (subtle)
    lamps.forEach(function (L) {
      var f = 1 + Math.sin(wobT * 9 + L.phase) * 0.04 + Math.sin(wobT * 23 + L.phase * 2) * 0.02;
      L.glow.scale.set(3.2 * f, 3.2 * f, 1);
    });

    // agent animation: walk cycle, idle life (breath/blink/look/wave), talk
    // new-rig pivots come from group.userData (guarded: legacy fallback lacks them)
    var aidList = Object.keys(agents);
    for (var ai = 0; ai < aidList.length; ai++) {
      (function (id) {
        var a = agents[id];
        var g = a.group;
        var ud = g.userData;
        var px = g.position.x, pz = g.position.z;

        // speed from position delta / dt, smoothed
        var rawSpeed = 0;
        if (dt > 0) {
          var ddx = px - a.lastX, ddz = pz - a.lastZ;
          rawSpeed = Math.sqrt(ddx * ddx + ddz * ddz) / dt;
        }
        a.lastX = px; a.lastZ = pz;
        a.speedSm += (rawSpeed - a.speedSm) * Math.min(1, dt * 6);
        var moving = a.speedSm > 0.25;
        var wamp = Math.min(1, a.speedSm / 2);

        // heading: ease toward target heading via shortest arc
        var dh = shortAngle(a.targetHeading - a.heading);
        a.heading += dh * Math.min(1, dt * 10);
        g.rotation.y = a.heading;

        var baseBodyY = (ud.baseBodyY !== undefined) ? ud.baseBodyY : 0.78;

        if (moving) {
          a.walkPhase += dt * (5 + a.speedSm * 2.2);
          var s = Math.sin(a.walkPhase);
          if (ud.legL) ud.legL.rotation.x = s * 0.6 * wamp;
          if (ud.legR) ud.legR.rotation.x = -s * 0.6 * wamp;
          if (ud.armL) ud.armL.rotation.x = -s * 0.5 * wamp;
          if (ud.armR) ud.armR.rotation.x = s * 0.5 * wamp;
          var bob = Math.abs(Math.cos(a.walkPhase)) * 0.09 * wamp;
          if (ud.body) ud.body.position.y = baseBodyY + bob;
          if (ud.headGroup) ud.headGroup.position.y = 1.32 + bob * 1.2;
          g.rotation.z = s * 0.03 * wamp;
          // lean into turns + slight forward lean with speed
          a.lean += (clamp(-dh * 2, -0.08, 0.08) - a.lean) * Math.min(1, dt * 8);
          g.rotation.x = a.lean + a.speedSm * 0.008;
          // don't freeze mid-blink when a walk starts
          if (a.blinkOn > 0) {
            a.blinkOn = 0;
            if (ud.eyeL) ud.eyeL.scale.y = 1;
            if (ud.eyeR) ud.eyeR.scale.y = 1;
          }
        } else {
          // ease limbs and body tilt back to rest
          var restK = Math.min(1, dt * 6);
          if (ud.legL) ud.legL.rotation.x += (0 - ud.legL.rotation.x) * restK;
          if (ud.legR) ud.legR.rotation.x += (0 - ud.legR.rotation.x) * restK;
          if (ud.armL) { ud.armL.rotation.x += (0 - ud.armL.rotation.x) * restK; ud.armL.rotation.z += (0 - ud.armL.rotation.z) * restK; }
          if (ud.armR && a.waveT <= 0) { ud.armR.rotation.x += (0 - ud.armR.rotation.x) * restK; ud.armR.rotation.z += (0 - ud.armR.rotation.z) * restK; }
          g.rotation.x += (0 - g.rotation.x) * restK;
          g.rotation.z += (0 - g.rotation.z) * restK;
          a.lean += (0 - a.lean) * restK;

          // breathing
          var br = Math.sin(t * 2.2 + a.phase) * 0.02;
          if (ud.body) ud.body.position.y = baseBodyY + br;
          if (ud.headGroup) ud.headGroup.position.y = 1.32 + br * 1.3;

          // blink
          if (ud.eyeL || ud.eyeR) {
            a.blinkT -= dt;
            if (a.blinkT <= 0) { a.blinkOn = 0.12; a.blinkT = 1 + Math.random() * 3; }
            if (a.blinkOn > 0) a.blinkOn -= dt;
            var eyeSY = a.blinkOn > 0 ? 0.12 : 1;
            if (ud.eyeL) ud.eyeL.scale.y = eyeSY;
            if (ud.eyeR) ud.eyeR.scale.y = eyeSY;
          }

          // look around (headGroup.rotation.y; rotation.x belongs to the talk nod)
          if (ud.headGroup) {
            a.lookT -= dt;
            if (a.lookHold > 0) a.lookHold -= dt;
            if (a.lookT <= 0) {
              a.lookYaw = (Math.random() - 0.5) * 1.0;
              a.lookHold = 1.2 + Math.random();
              a.lookT = 4 + Math.random() * 6;
            }
            var wantYaw = a.lookHold > 0 ? a.lookYaw : 0;
            var hg = ud.headGroup;
            hg.rotation.y += (wantYaw - hg.rotation.y) * Math.min(1, dt * 5);
            if (a.talkT <= 0) hg.rotation.x += (0 - hg.rotation.x) * Math.min(1, dt * 5);
          }

          // wave at a nearby agent now and then
          a.waveCd -= dt;
          if (a.waveCd <= 0) {
            var near = false;
            for (var m = 0; m < aidList.length; m++) {
              if (aidList[m] === id) continue;
              var op = agents[aidList[m]].group.position;
              var ox = op.x - px, oz = op.z - pz;
              if (ox * ox + oz * oz < 9) { near = true; break; }
            }
            if (near) a.waveT = 1.1;
            a.waveCd = 8 + Math.random() * 10;
          }
        }

        // wave pose (takes priority over walk/idle armR pose while active)
        if (a.waveT > 0 && ud.armR) {
          a.waveT -= dt;
          ud.armR.rotation.z = -2.4 + Math.sin(t * 14) * 0.25;
          ud.armR.rotation.x = 0;
          if (a.waveT <= 0) ud.armR.rotation.z = 0;
        }

        // talk: flapping mouth + head nod + slight lean toward the listener
        if (a.talkT > 0) {
          a.talkT -= dt;
          if (ud.mouth) {
            if (ud.mouthBaseY === undefined) ud.mouthBaseY = ud.mouth.scale.y || 0.5;
            ud.mouth.scale.y = ud.mouthBaseY * 0.5 * (0.4 + Math.abs(Math.sin(t * 16)) * 0.9);
          }
          if (ud.headGroup) ud.headGroup.rotation.x = Math.sin(t * 8) * 0.06;
          g.rotation.x += 0.05; // lean in while speaking
          if (a.talkT <= 0) {
            if (ud.mouth && ud.mouthBaseY !== undefined) ud.mouth.scale.y = ud.mouthBaseY;
            // headGroup.rotation.x eases back to 0 in the idle branch above
          }
        }
      })(aidList[ai]);

      // Moonwake-style: name pills keep a constant screen size at any zoom
      var _a2 = agents[aidList[ai]];
      if (_a2 && _a2.label) {
        var _ldx = camera.position.x - _a2.group.position.x,
            _ldy = camera.position.y - (_a2.group.position.y + 2.5),
            _ldz = camera.position.z - _a2.group.position.z;
        var _ld = Math.sqrt(_ldx * _ldx + _ldy * _ldy + _ldz * _ldz);
        var _lf = clamp(_ld / 46, 0.22, 3);
        _a2.label.scale.set(_a2.labelBaseX * _lf, _a2.labelBaseY * _lf, 1);
      }
    }
    updateSpeechBubbles();

    // place pills: same constant-screen-size treatment
    for (var _pli = 0; _pli < labelSprites.length; _pli++) {
      var _pls = labelSprites[_pli];
      if (!_pls.userData.baseSX) {
        _pls.userData.baseSX = _pls.scale.x;
        _pls.userData.baseSY = _pls.scale.y;
      }
      var _pld = camera.position.distanceTo(_pls.position);
      var _plf = clamp(_pld / 46, 0.22, 3);
      _pls.scale.set(_pls.userData.baseSX * _plf, _pls.userData.baseSY * _plf, 1);
    }

    // labels face camera automatically (sprites); scale labels by distance is handled by sprite sizeAttenuation
    if (window.GlowBloom) window.GlowBloom.render(scene, camera);
    else renderer.render(scene, camera);
  }

  // ---------- resize ----------
  function onResize() {
    if (!container) return;
    var w = container.clientWidth || window.innerWidth;
    var h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (window.GlowBloom) { try { window.GlowBloom.resize(); } catch (e) {} }
  }

  // ---------- init ----------
  function init(containerEl) {
    container = containerEl || document.body;

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    // cinematic tone mapping: warmer highlights, deeper night.
    // (kept subtle so the stylized palette stays vivid)
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    // selective glow-layer bloom (cheap: quarter-res, additive composite)
    if (window.GlowBloom) { try { window.GlowBloom.init(renderer); } catch (e) { /* bloom off */ } }

    // floating speech bubbles live in an overlay above the canvas (below the HUD)
    speechLayer = document.createElement('div');
    speechLayer.id = 'speech-layer';
    container.appendChild(speechLayer);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2('#ccd8e2', 0.0016);

    camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2000);

    // lights: hemisphere + directional sun + cool moon fill + ambient
    hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x6a8f5a, 0.65);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xfff2dd, 1.1);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -60; sunLight.shadow.camera.right = 60;
    sunLight.shadow.camera.top = 60; sunLight.shadow.camera.bottom = -60;
    sunLight.shadow.camera.near = 10; sunLight.shadow.camera.far = 400;
    sunLight.shadow.bias = -0.0006;
    scene.add(sunLight);
    scene.add(sunLight.target);
    // moonlight: dim cool fill that crossfades in as the sun hands off
    moonLight = new THREE.DirectionalLight(0x8fb4e8, 0.0);
    moonLight.castShadow = false; // perf: shadows stay on the sun pass
    scene.add(moonLight);
    scene.add(moonLight.target);
    ambLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambLight);

    buildSky();
    buildWater();
    buildIsland();
    buildPaths();

    var places = CFG.places || [];
    places.forEach(function (pl) {
      buildPatio(pl);
      // lamp offset beside each place
      var lx = pl.x + 4.2, lz = pl.z + 2.4;
      buildLamp(lx, lz);
    });
    scatterPalms();
    scatterLollipops();
    scatterGrassBlobs();
    buildCottages();
    scatterProps();
    buildShafts();
    buildSparkles();
    buildClouds();
    buildRain();
    buildFireflies();
    registerBloomCasters();

    applyTimeOfDay(10.5);
    setWeather('Clear');
    applyCamera();
    onResize();
    window.addEventListener('resize', onResize);
    setupInput();
  }

  function focusAgentFn(id) {
    var a = agents[id];
    if (!a) return;
    followId = id;
    var p = a.group.position;
    startTween({ yaw: cam.yaw, pitch: 0.5, dist: 32, tx: p.x, ty: p.y + 2, tz: p.z }, 1.4);
  }
  function followAgentFn(id) {
    if (!agents[id]) return;
    followId = id;
    var p = agents[id].group.position;
    startTween({ yaw: cam.yaw, pitch: 0.45, dist: 30, tx: p.x, ty: p.y + 2, tz: p.z }, 1.4);
  }
  function unfollowFn() { followId = null; }

  // ---------- public API ----------
  window.Island = {
    init: init,
    setTimeOfDay: function (h) { applyTimeOfDay(h); },
    setWeather: setWeather,
    setBloom: function (b) { if (window.GlowBloom) window.GlowBloom.setEnabled(b); },

    toggleOverview: function () {
      overview = !overview;
      followId = null;
      startTween(overview ? OVERVIEW_VIEW : DEFAULT_VIEW, 1.6);
    },
    resetView: function () {
      overview = false;
      followId = null;
      startTween(DEFAULT_VIEW, 1.4);
    },
    zoom: function (d) {
      tween = null;
      cam.dist = clamp(cam.dist * d, 10, 170);
    },

    focusAgent: focusAgentFn,
    followAgent: followAgentFn,
    unfollow: unfollowFn,
    faceToward: faceToward,
    agentSpeak: agentSpeak,
    focusPlace: function (x, z) {
      startTween({ yaw: cam.yaw, pitch: 0.55, dist: 48, tx: x, ty: 1.0 + groundHeight(x, z) + 2, tz: z }, 1.4);
    },
    setCam: function (yaw, pitch, dist, tx, ty, tz) {
      tween = null;
      cam.yaw = yaw;
      cam.pitch = clamp(pitch, 0.15, 1.2);
      cam.dist = clamp(dist, 10, 170);
      cam.tx = tx; cam.ty = ty; cam.tz = tz;
    },

    addAgentMesh: addAgentMesh,
    moveAgentMesh: moveAgentMesh,
    setAgentStatus: setAgentStatus,
    removeAgentMesh: removeAgentMesh,
    groundHeight: groundHeight,
    onTick: onTick,

    // live refs (populated by init)
    get scene() { return scene; },
    get camera() { return camera; },
    get renderer() { return renderer; }
  };
})();

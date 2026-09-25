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
  var labelSprites = [];
  var agents = {};            // id -> { group, ringMat, nameSprite, phase, status, heading }
  var weatherMode = 'Clear';
  var nightF = 0;             // 0 = full day, 1 = full night (set by applyTimeOfDay)
  var sunF = 1;               // 0 = sun down, 1 = full day sun (set by applyTimeOfDay)
  var starBase = 0;           // base star opacity from palette (twinkle modulates it)
  var overview = false;

  var cam = { yaw: 0.85, pitch: 0.55, dist: 72, tx: 0, ty: 2, tz: 0 };
  var DEFAULT_VIEW = { yaw: 0.85, pitch: 0.55, dist: 72, tx: 0, ty: 2, tz: 0 };
  var OVERVIEW_VIEW = { yaw: 0.85, pitch: 0.95, dist: 155, tx: 0, ty: 0, tz: 0 };
  var tween = null;           // { t, dur, from, to }
  var curTOD = 12;            // hour 0..24

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function easeInOut(t) { return t * t * (3 - 2 * t); }

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

  function makeLabelSprite(text, scale) {
    var c = makeCanvas(256, 72);
    var ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(10,16,32,0.62)';
    roundedPill(ctx, 4, 10, 248, 52, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    roundedPill(ctx, 4, 10, 248, 52, 26);
    ctx.stroke();
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
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
    var grass = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ color: '#5da24f', vertexColors: false }));
    // subtle green variation via vertex colors
    var cols = new Float32Array(p.count * 3);
    var cA = new THREE.Color('#58a04b'), cB = new THREE.Color('#6fb257');
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
      var m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#dccb9e' }));
      var mx = dx / 2, mz = dz / 2;
      m.position.set(mx, 1.0 + groundHeight(mx, mz) + 0.09, mz);
      m.rotation.y = Math.atan2(dx, dz);
      m.receiveShadow = true;
      scene.add(m);
    });
  }

  function buildHouse(pl) {
    var g = new THREE.Group();
    var gy = 1.0 + groundHeight(pl.x, pl.z);
    var wallColor = new THREE.Color(pl.color || '#c98f5f');

    var walls = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3, 4.2), new THREE.MeshLambertMaterial({ color: wallColor }));
    walls.position.y = 1.5;
    walls.castShadow = true; walls.receiveShadow = true;
    g.add(walls);

    var roof = new THREE.Mesh(new THREE.ConeGeometry(4.0, 2.4, 4), new THREE.MeshLambertMaterial({ color: '#8a4f36' }));
    roof.position.y = 3 + 1.2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);

    var door = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.0), new THREE.MeshLambertMaterial({ color: '#5a3a26' }));
    door.position.set(0, 1.0, 2.11);
    g.add(door);

    // warm emissive windows
    var winMat = new THREE.MeshLambertMaterial({ color: '#3a2c1c', emissive: new THREE.Color('#ffb347'), emissiveIntensity: 0.15 });
    windows.push(winMat);
    [-1.5, 1.5].forEach(function (wx) {
      var w = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), winMat);
      w.position.set(wx, 1.9, 2.11);
      g.add(w);
      var w2 = w.clone();
      w2.rotation.y = Math.PI;
      w2.position.z = -2.11;
      g.add(w2);
    });

    g.position.set(pl.x, gy, pl.z);
    g.rotation.y = Math.atan2(-pl.x, -pl.z); // face plaza
    scene.add(g);

    // floating name label
    var label = makeLabelSprite(pl.name || pl.id || 'Place');
    label.position.set(pl.x, gy + 7.2, pl.z);
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
    lamps.push({ bulbMat: bulbMat, glowMat: glowMat, glow: glow, phase: Math.random() * 6.28 });
    // a few real point lights for warm pools of light at night (perf-capped)
    if (lampLights.length < 3) {
      var pl = new THREE.PointLight(0xffc37a, 0, 22, 2);
      pl.position.set(x, gy + 3.6, z);
      scene.add(pl);
      lampLights.push(pl);
    }
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

  function scatterPalms() {
    var places = CFG.places || [];
    var placed = 0, tries = 0;
    while (placed < 24 && tries < 400) {
      tries++;
      var a = Math.random() * Math.PI * 2;
      var r = 9 + Math.random() * (R - 13);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      var ok = true;
      for (var i = 0; i < places.length; i++) {
        var dx = x - places[i].x, dz = z - places[i].z;
        if (dx * dx + dz * dz < 36) { ok = false; break; }
      }
      if (!ok) continue;
      buildPalm(x, z);
      placed++;
    }
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
      cam.dist = clamp(cam.dist * (1 + e.deltaY * 0.0011), 30, 170);
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
    }
  }

  // ---------- agent figures ----------
  function addAgentMesh(id, colorHex, name) {
    if (agents[id]) removeAgentMesh(id);
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

    // eyes
    var eyeMat = new THREE.MeshBasicMaterial({ color: 0x1c1c22 });
    [-0.13, 0.13].forEach(function (ex) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), eyeMat);
      eye.position.set(ex, 2.2, 0.32);
      g.add(eye);
    });

    // status ring at feet
    var ringMat = new THREE.MeshBasicMaterial({ color: 0x7fe07f, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.92, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    g.add(ring);

    var label = makeLabelSprite(name || id, 0.72);
    label.position.y = 3.15;
    g.add(label);

    g.userData.agentId = id;
    g.userData.body = body;
    g.userData.head = head;
    var sx = 0, sz = 0;
    g.position.set(sx, 1.0 + groundHeight(sx, sz), sz);
    scene.add(g);
    agents[id] = { group: g, ringMat: ringMat, phase: Math.random() * 6.28, status: 'idle', heading: 0 };
    return g;
  }

  function moveAgentMesh(id, x, z, heading) {
    var a = agents[id];
    if (!a) return;
    a.group.position.x = x;
    a.group.position.z = z;
    a.group.position.y = 1.0 + groundHeight(x, z);
    if (typeof heading === 'number') {
      a.heading = heading;
      a.group.rotation.y = heading;
    }
  }

  function setAgentStatus(id, status) {
    var a = agents[id];
    if (!a) return;
    a.status = status;
    a.ringMat.color.set(status === 'working' ? 0xffb347 : 0x7fe07f);
  }

  function removeAgentMesh(id) {
    var a = agents[id];
    if (!a) return;
    scene.remove(a.group);
    delete agents[id];
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
    applyCamera();

    // keep the sun/moon billboards in frame (camera-relative sky anchors)
    var _f = new THREE.Vector3(); camera.getWorldDirection(_f);
    var _r = new THREE.Vector3().crossVectors(_f, camera.up).normalize();
    var _u = new THREE.Vector3().crossVectors(_r, _f).normalize();
    sunSprite.position.copy(camera.position)
      .addScaledVector(_f, 500).addScaledVector(_u, 150).addScaledVector(_r, -190);
    moonSprite.position.copy(camera.position)
      .addScaledVector(_f, 500).addScaledVector(_u, 170).addScaledVector(_r, 210);

    // water shimmer: gentle vertex waves + subtle opacity pulse
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

    // agent bobbing
    Object.keys(agents).forEach(function (id) {
      var a = agents[id];
      var speed = a.status === 'working' ? 9 : 3.2;
      var amp = a.status === 'working' ? 0.13 : 0.05;
      var b = Math.sin(t * speed + a.phase) * amp;
      a.group.userData.body.position.y = 1.15 + b;
      a.group.userData.head.position.y = 2.15 + b * 1.15;
    });

    // labels face camera automatically (sprites); scale labels by distance is handled by sprite sizeAttenuation
    renderer.render(scene, camera);
  }

  // ---------- resize ----------
  function onResize() {
    if (!container) return;
    var w = container.clientWidth || window.innerWidth;
    var h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
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
      buildHouse(pl);
      // lamp offset beside each place
      var lx = pl.x + 4.2, lz = pl.z + 2.4;
      buildLamp(lx, lz);
    });
    scatterPalms();
    buildClouds();
    buildRain();
    buildFireflies();

    applyTimeOfDay(10.5);
    setWeather('Clear');
    applyCamera();
    onResize();
    window.addEventListener('resize', onResize);
    setupInput();
  }

  // ---------- public API ----------
  window.Island = {
    init: init,
    setTimeOfDay: function (h) { applyTimeOfDay(h); },
    setWeather: setWeather,

    toggleOverview: function () {
      overview = !overview;
      startTween(overview ? OVERVIEW_VIEW : DEFAULT_VIEW, 1.6);
    },
    resetView: function () {
      overview = false;
      startTween(DEFAULT_VIEW, 1.4);
    },
    zoom: function (d) {
      tween = null;
      cam.dist = clamp(cam.dist * d, 30, 170);
    },

    focusAgent: function (id) {
      var a = agents[id];
      if (!a) return;
      var p = a.group.position;
      startTween({ yaw: cam.yaw, pitch: 0.5, dist: 42, tx: p.x, ty: p.y + 2, tz: p.z }, 1.4);
    },
    focusPlace: function (x, z) {
      startTween({ yaw: cam.yaw, pitch: 0.55, dist: 48, tx: x, ty: 1.0 + groundHeight(x, z) + 2, tz: z }, 1.4);
    },
    setCam: function (yaw, pitch, dist, tx, ty, tz) {
      tween = null;
      cam.yaw = yaw;
      cam.pitch = clamp(pitch, 0.15, 1.2);
      cam.dist = clamp(dist, 30, 170);
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

/* characters.js — Chibi character builder for Agent Island
 *
 * Exposes window.Chibi with:
 *   Chibi.DEFS               named definitions for the 14 Moonwake residents
 *   Chibi.defFor(name, colorHex)  look up (or deterministically generate) a def
 *   Chibi.build(def)          -> THREE.Group (group.userData.body/.head/.ringMat)
 *
 * Plain <script> file: THREE r149 is global (window.THREE), no modules.
 * Loads after three.min.js, before island.js.
 */
(function () {
  'use strict';

  var THREE = window.THREE;

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function lambert(color) {
    return new THREE.MeshLambertMaterial({ color: color });
  }

  function sph(r, w, h, mat) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(r, w || 12, h || 10), mat);
    m.castShadow = true;
    return m;
  }

  function cap(r, len, mat) {
    var m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
    m.castShadow = true;
    return m;
  }

  function cone(r, h, mat, seg) {
    var m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg || 10), mat);
    m.castShadow = true;
    return m;
  }

  function box(w, h, d, mat) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    return m;
  }

  // Deterministic hash of a string -> unsigned int (for generated defs).
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* Named character definitions                                        */
  /* ------------------------------------------------------------------ */

  var DEFS = {
    'Pip': {
      name: 'Pip', body: 0xe8c98a, head: 0xf6cfa0,
      accessory: { type: 'ears', color: 0xe8c98a }
    },
    'Mushoh': {
      name: 'Mushoh', body: 0xb9a7e6, head: 0xf6cfa0,
      accessory: { type: 'hood', color: 0xb9a7e6 }
    },
    'Bryan': {
      name: 'Bryan', body: 0x8fbf7f, head: 0xf2c89b,
      accessory: { type: 'cap', color: 0x6b7f3f }
    },
    'Fern': {
      name: 'Fern', body: 0x7da05a, head: 0xf2c89b,
      accessory: { type: 'sprout', color: 0x5a8a3f }
    },
    'Miso': {
      name: 'Miso', body: 0xf0e0c0, head: 0xf6cfa0,
      accessory: { type: 'cap', color: 0x3a7bd5 }
    },
    'Michelle': {
      name: 'Michelle', body: 0xd64545, head: 0xf6cfa0,
      accessory: { type: 'hood', color: 0xd64545 }
    },
    'Duhleet': {
      name: 'Duhleet', body: 0xe8935a, head: 0xf6cfa0,
      accessory: { type: 'band', color: 0xb4502a }
    },
    'Otto': {
      name: 'Otto', body: 0xb08954, head: 0xf2c89b,
      accessory: { type: 'brimhat', color: 0x5a4030 }
    },
    'Grom': {
      name: 'Grom', body: 0x6b5d4f, head: 0xd9a878, scale: 1.12,
      accessory: { type: 'none', color: 0x000000 }
    },
    'bozo': {
      name: 'bozo', body: 0x4fb3a9, head: 0xf2c89b,
      accessory: { type: 'cap', color: 0x2f7f78, capStripe: 0xf2f2f2 }
    },
    'Delphine Roux': {
      name: 'Delphine Roux', body: 0xe88bb0, head: 0xf6cfa0,
      accessory: { type: 'bow', color: 0xc24a7c }
    },
    'Silas Marchetti': {
      name: 'Silas Marchetti', body: 0x5b7a99, head: 0xf2c89b,
      accessory: { type: 'brimhat', color: 0x8a6b45 }
    },
    'Ezra Whitlock': {
      name: 'Ezra Whitlock', body: 0x6fb7e8, head: 0xf6cfa0,
      accessory: { type: 'scarf', color: 0xe8a33d }
    },
    'ROKKO BASILISK': {
      name: 'ROKKO BASILISK', body: 0x2e2a33, head: 0x9a7b62, scale: 1.1,
      accessory: { type: 'crest', color: 0xd64545 }
    }
  };

  var GEN_ACCESSORIES = ['cap', 'hood', 'ears', 'band', 'none'];

  /* ------------------------------------------------------------------ */
  /* defFor                                                             */
  /* ------------------------------------------------------------------ */

  function defFor(name, colorHex) {
    if (Object.prototype.hasOwnProperty.call(DEFS, name)) {
      return DEFS[name];
    }
    // "Bring your Muse" guests: body from colorHex, peachy head, deterministic accessory.
    var accType = GEN_ACCESSORIES[hashStr(String(name)) % GEN_ACCESSORIES.length];
    return {
      name: name,
      body: colorHex,
      head: 0xf2c89b,
      accessory: { type: accType, color: 0xdde3ea }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Accessory builders                                                 */
  /* Each adds to `group` and sits on/around the head.                  */
  /* ------------------------------------------------------------------ */

  var HEAD_R = 0.58;
  var HEAD_Y = 1.55;

  function addCap(group, def) {
    var acc = def.accessory;
    // Dome cap: half-sphere sitting on the head.
    var dome = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R * 1.02, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52),
      lambert(acc.color)
    );
    dome.position.y = HEAD_Y + 0.02;
    dome.castShadow = true;
    group.add(dome);

    // Optional two-tone stripe: second half-dome slightly inset, offset in theta.
    if (acc.capStripe) {
      var stripe = new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_R * 1.02, 6, 8, 0, Math.PI, 0, Math.PI * 0.52),
        lambert(acc.capStripe)
      );
      stripe.position.y = HEAD_Y + 0.02;
      stripe.castShadow = true;
      group.add(stripe);
    }

    // Brim pointing forward.
    var brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.38, 0.07, 12),
      lambert(acc.color)
    );
    brim.position.set(0, HEAD_Y + 0.10, HEAD_R * 0.98);
    brim.castShadow = true;
    group.add(brim);

    // Tiny button on top.
    var btn = sph(0.07, 8, 6, lambert(acc.color));
    btn.position.set(0, HEAD_Y + HEAD_R * 1.02 + 0.02, 0);
    group.add(btn);
  }

  function addHood(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Hood: slightly larger sphere shell behind the head, leaving the face open.
    var hood = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R * 1.18, 14, 10, Math.PI * 0.62, Math.PI * 1.76, Math.PI * 0.06, Math.PI * 0.82),
      mat
    );
    hood.position.y = HEAD_Y - 0.06;
    hood.castShadow = true;
    hood.material = mat.clone();
    hood.material.side = THREE.DoubleSide;
    group.add(hood);
    // Hood rim: torus ring framing the face.
    var rim = new THREE.Mesh(new THREE.TorusGeometry(HEAD_R * 0.98, 0.13, 8, 16), lambert(acc.color));
    rim.position.y = HEAD_Y + 0.02;
    rim.castShadow = true;
    group.add(rim);
  }

  function addEars(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    var innerMat = lambert(0xf2c89b);
    [-1, 1].forEach(function (s) {
      var ear = cone(0.17, 0.38, mat, 8);
      ear.position.set(s * 0.38, HEAD_Y + HEAD_R * 0.82, -0.02);
      ear.rotation.z = -s * 0.28;
      group.add(ear);
      var inner = cone(0.09, 0.20, innerMat, 8);
      inner.position.set(s * 0.365, HEAD_Y + HEAD_R * 0.76, 0.05);
      inner.rotation.z = -s * 0.28;
      group.add(inner);
    });
  }

  function addSprout(group, def) {
    var acc = def.accessory;
    // Stem.
    var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.30, 8), lambert(acc.color));
    stem.position.set(0, HEAD_Y + HEAD_R + 0.12, 0);
    stem.castShadow = true;
    group.add(stem);
    // Two leaves: flattened spheres tilted outward.
    [-1, 1].forEach(function (s) {
      var leaf = sph(0.16, 8, 6, lambert(acc.color));
      leaf.scale.set(1.35, 0.42, 0.8);
      leaf.position.set(s * 0.16, HEAD_Y + HEAD_R + 0.26, 0);
      leaf.rotation.z = s * 0.5;
      group.add(leaf);
    });
  }

  function addBow(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Two loop triangles + center knot, perched on the upper-left of the head.
    var bx = -0.30, by = HEAD_Y + HEAD_R * 0.80, bz = 0.10;
    [-1, 1].forEach(function (s) {
      var loop = cone(0.16, 0.30, mat, 4);
      loop.position.set(bx + s * 0.17, by, bz);
      loop.rotation.z = s * (Math.PI / 2) * 0.94;
      loop.rotation.y = -0.2;
      group.add(loop);
    });
    var knot = sph(0.10, 8, 6, mat);
    knot.position.set(bx, by, bz + 0.04);
    group.add(knot);
  }

  function addBrimHat(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Wide flat brim.
    var brim = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 0.08, 14), mat);
    brim.position.set(0, HEAD_Y + 0.34, 0);
    brim.castShadow = true;
    group.add(brim);
    // Dome crown on top of the brim.
    var crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.40, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      mat
    );
    crown.position.y = HEAD_Y + 0.38;
    crown.castShadow = true;
    group.add(crown);
    // Hat band.
    var band = new THREE.Mesh(new THREE.CylinderGeometry(0.405, 0.415, 0.10, 12), lambert(0x3a2c1e));
    band.position.y = HEAD_Y + 0.40;
    band.castShadow = true;
    group.add(band);
  }

  function addScarf(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Wrap torus around the neck (between head and body).
    var wrap = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.13, 8, 14), mat);
    wrap.position.y = 1.02;
    wrap.rotation.x = Math.PI / 2;
    wrap.castShadow = true;
    group.add(wrap);
    // Dangling tail in front.
    var tail = box(0.16, 0.34, 0.08, mat);
    tail.position.set(0.22, 0.78, 0.38);
    tail.rotation.z = 0.18;
    group.add(tail);
  }

  function addCrest(group, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Mohawk: three small cones running front-to-back along the top.
    var zs = [0.30, 0.02, -0.26];
    zs.forEach(function (z, i) {
      var spike = cone(0.11, 0.30 - i * 0.02, mat, 6);
      spike.position.set(0, HEAD_Y + HEAD_R * 0.92, z);
      group.add(spike);
    });
  }

  function addBand(group, def) {
    var acc = def.accessory;
    // Headband: torus tilted to wrap the forehead line.
    var band = new THREE.Mesh(new THREE.TorusGeometry(HEAD_R * 0.98, 0.075, 8, 16), lambert(acc.color));
    band.position.y = HEAD_Y + 0.10;
    band.rotation.x = Math.PI / 2 - 0.18;
    band.castShadow = true;
    group.add(band);
  }

  var ACCESSORY_BUILDERS = {
    cap: addCap,
    hood: addHood,
    ears: addEars,
    sprout: addSprout,
    bow: addBow,
    brimhat: addBrimHat,
    scarf: addScarf,
    crest: addCrest,
    band: addBand,
    none: function () {}
  };

  /* ------------------------------------------------------------------ */
  /* build                                                              */
  /* ------------------------------------------------------------------ */

  function build(def) {
    var group = new THREE.Group();

    var bodyMat = lambert(def.body);
    var headMat = lambert(def.head);
    var darkMat = lambert(0x333333);

    // Head: big round sphere.
    var head = sph(HEAD_R, 14, 12, headMat);
    head.position.y = HEAD_Y;
    group.add(head);

    // Body: stubby capsule.
    var body = cap(0.34, 0.5, bodyMat);
    body.position.y = 0.72;
    group.add(body);

    // Eyes: two black dots on the face.
    [-1, 1].forEach(function (s) {
      var eye = sph(0.055, 8, 6, darkMat);
      eye.position.set(s * 0.16, HEAD_Y + 0.07, HEAD_R - 0.08);
      group.add(eye);
      // Blush: small pink flattened spheres on cheeks.
      var blush = sph(0.07, 8, 6, lambert(0xf4a7a7));
      blush.scale.set(1.3, 0.7, 0.5);
      blush.position.set(s * 0.34, HEAD_Y - 0.06, HEAD_R - 0.16);
      group.add(blush);
    });

    // Feet: two dark nubs.
    [-1, 1].forEach(function (s) {
      var foot = sph(0.14, 8, 6, lambert(0x4a4038));
      foot.scale.set(1.0, 0.75, 1.35);
      foot.position.set(s * 0.20, 0.12, 0.06);
      group.add(foot);
    });

    // Arms: small capsules at the body's sides, slight outward tilt.
    [-1, 1].forEach(function (s) {
      var arm = cap(0.10, 0.28, bodyMat);
      arm.position.set(s * 0.42, 0.74, 0);
      arm.rotation.z = s * 0.35;
      group.add(arm);
    });

    // Accessory on/around the head.
    var accType = (def.accessory && def.accessory.type) || 'none';
    var builder = ACCESSORY_BUILDERS[accType] || ACCESSORY_BUILDERS.none;
    builder(group, def);

    // Status ring: thin flat ring at the feet (integrator tints it).
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0x66cc88,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide
    });
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    group.add(ring);

    // Optional per-character scale (e.g. Grom 1.12, ROKKO BASILISK 1.1).
    if (def.scale && def.scale !== 1) {
      group.scale.setScalar(def.scale);
    }

    group.userData.body = body;
    group.userData.head = head;
    group.userData.ringMat = ringMat;

    return group;
  }

  /* ------------------------------------------------------------------ */

  window.Chibi = {
    DEFS: DEFS,
    defFor: defFor,
    build: build
  };
})();

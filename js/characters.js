/* characters.js — Chibi character builder for Agent Island
 *
 * Exposes window.Chibi with:
 *   Chibi.DEFS               named definitions for the 14 Moonwake residents
 *   Chibi.defFor(name, colorHex)  look up (or deterministically generate) a def
 *   Chibi.build(def)          -> THREE.Group with an articulated rig:
 *     group.userData = { body, head, headGroup, armL, armR, legL, legR,
 *                        eyeL, eyeR, mouth, ringMat }
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

  // Body color multiplied by a factor -> hex (for two-tone darkening).
  function shade(hex, f) {
    return new THREE.Color(hex).multiplyScalar(f).getHex();
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
  /* Each adds into `host` using HEAD-LOCAL coordinates (host is the     */
  /* headGroup, so y = old group-space y - NECK_Y). Scarf is the         */
  /* exception: it hangs below the neck, so it still goes on the main    */
  /* group at its old positions. All dimensions are chunked up x1.25.    */
  /* ------------------------------------------------------------------ */

  var HEAD_R = 0.58;   // head radius the old accessory layout was designed for
  var NECK_Y = 1.32;   // headGroup pivot height in group space
  var K = 1.25;        // chunk factor for accessories

  function addCap(host, def) {
    var acc = def.accessory;
    // Dome cap: half-sphere sitting on the head.
    var dome = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R * 1.02 * K, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52),
      lambert(acc.color)
    );
    dome.position.y = 1.57 - NECK_Y;
    dome.castShadow = true;
    host.add(dome);

    // Optional two-tone stripe: second half-dome slightly inset, offset in theta.
    if (acc.capStripe) {
      var stripe = new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_R * 1.02 * K, 6, 8, 0, Math.PI, 0, Math.PI * 0.52),
        lambert(acc.capStripe)
      );
      stripe.position.y = 1.57 - NECK_Y;
      stripe.castShadow = true;
      host.add(stripe);
    }

    // Brim pointing forward.
    var brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34 * K, 0.38 * K, 0.07 * K, 12),
      lambert(acc.color)
    );
    brim.position.set(0, 1.65 - NECK_Y, HEAD_R * 0.98);
    brim.castShadow = true;
    host.add(brim);

    // Tiny button on top.
    var btn = sph(0.07 * K, 8, 6, lambert(acc.color));
    btn.position.set(0, (1.55 + HEAD_R * 1.02 + 0.02) - NECK_Y, 0);
    host.add(btn);
  }

  function addHood(host, def) {
    var acc = def.accessory;
    // Hood: slightly larger sphere shell behind the head, leaving the face open.
    var hood = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R * 1.18 * K, 14, 10, Math.PI * 0.62, Math.PI * 1.76, Math.PI * 0.06, Math.PI * 0.82),
      lambert(acc.color)
    );
    hood.position.y = 1.49 - NECK_Y;
    hood.castShadow = true;
    hood.material = hood.material.clone();
    hood.material.side = THREE.DoubleSide;
    host.add(hood);
    // Hood rim: torus ring framing the face.
    var rim = new THREE.Mesh(new THREE.TorusGeometry(HEAD_R * 0.98 * K, 0.13 * K, 8, 16), lambert(acc.color));
    rim.position.y = 1.57 - NECK_Y;
    rim.castShadow = true;
    host.add(rim);
  }

  function addEars(host, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    var innerMat = lambert(0xf2c89b);
    [-1, 1].forEach(function (s) {
      var ear = cone(0.17 * K, 0.38 * K, mat, 8);
      ear.position.set(s * 0.38, (1.55 + HEAD_R * 0.82) - NECK_Y, -0.02);
      ear.rotation.z = -s * 0.28;
      host.add(ear);
      var inner = cone(0.09 * K, 0.20 * K, innerMat, 8);
      inner.position.set(s * 0.365, (1.55 + HEAD_R * 0.76) - NECK_Y, 0.05);
      inner.rotation.z = -s * 0.28;
      host.add(inner);
    });
  }

  function addSprout(host, def) {
    var acc = def.accessory;
    // Stem.
    var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * K, 0.05 * K, 0.30 * K, 8), lambert(acc.color));
    stem.position.set(0, (1.55 + HEAD_R + 0.12) - NECK_Y, 0);
    stem.castShadow = true;
    host.add(stem);
    // Two leaves: flattened spheres tilted outward.
    [-1, 1].forEach(function (s) {
      var leaf = sph(0.16 * K, 8, 6, lambert(acc.color));
      leaf.scale.set(1.35, 0.42, 0.8);
      leaf.position.set(s * 0.16, (1.55 + HEAD_R + 0.26) - NECK_Y, 0);
      leaf.rotation.z = s * 0.5;
      host.add(leaf);
    });
  }

  function addBow(host, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Two loop triangles + center knot, perched on the upper-left of the head.
    var bx = -0.30, by = (1.55 + HEAD_R * 0.80) - NECK_Y, bz = 0.10;
    [-1, 1].forEach(function (s) {
      var loop = cone(0.16 * K, 0.30 * K, mat, 4);
      loop.position.set(bx + s * 0.17, by, bz);
      loop.rotation.z = s * (Math.PI / 2) * 0.94;
      loop.rotation.y = -0.2;
      host.add(loop);
    });
    var knot = sph(0.10 * K, 8, 6, mat);
    knot.position.set(bx, by, bz + 0.04);
    host.add(knot);
  }

  function addBrimHat(host, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Wide flat brim.
    var brim = new THREE.Mesh(new THREE.CylinderGeometry(0.72 * K, 0.76 * K, 0.08 * K, 14), mat);
    brim.position.set(0, 1.89 - NECK_Y, 0);
    brim.castShadow = true;
    host.add(brim);
    // Dome crown on top of the brim.
    var crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.40 * K, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      mat
    );
    crown.position.y = 1.93 - NECK_Y;
    crown.castShadow = true;
    host.add(crown);
    // Hat band.
    var band = new THREE.Mesh(new THREE.CylinderGeometry(0.405 * K, 0.415 * K, 0.10 * K, 12), lambert(0x3a2c1e));
    band.position.y = 1.95 - NECK_Y;
    band.castShadow = true;
    host.add(band);
  }

  function addScarf(host, def) {
    // host is the MAIN group here (below the neck pivot): positions unchanged.
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Wrap torus around the neck (between head and body).
    var wrap = new THREE.Mesh(new THREE.TorusGeometry(0.36 * K, 0.13 * K, 8, 14), mat);
    wrap.position.y = 1.02;
    wrap.rotation.x = Math.PI / 2;
    wrap.castShadow = true;
    host.add(wrap);
    // Dangling tail in front.
    var tail = box(0.16 * K, 0.34 * K, 0.08 * K, mat);
    tail.position.set(0.22, 0.78, 0.38);
    tail.rotation.z = 0.18;
    host.add(tail);
  }

  function addCrest(host, def) {
    var acc = def.accessory;
    var mat = lambert(acc.color);
    // Mohawk: three small cones running front-to-back along the top.
    var zs = [0.30, 0.02, -0.26];
    zs.forEach(function (z, i) {
      var spike = cone(0.11 * K, (0.30 - i * 0.02) * K, mat, 6);
      spike.position.set(0, (1.55 + HEAD_R * 0.92) - NECK_Y, z);
      host.add(spike);
    });
  }

  function addBand(host, def) {
    var acc = def.accessory;
    // Headband: torus tilted to wrap the forehead line.
    var band = new THREE.Mesh(new THREE.TorusGeometry(HEAD_R * 0.98 * K, 0.075 * K, 8, 16), lambert(acc.color));
    band.position.y = 1.65 - NECK_Y;
    band.rotation.x = Math.PI / 2 - 0.18;
    band.castShadow = true;
    host.add(band);
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
  /* build — articulated chibi rig                                      */
  /*                                                                    */
  /*   group                                                            */
  /*    +- legL / legR  (pivot at hip)                                  */
  /*    +- body, belly                                                  */
  /*    +- armL / armR  (pivot at shoulder)                             */
  /*    +- headGroup    (pivot at neck)                                 */
  /*    |    +- head, eyeL, eyeR, blush x2, mouth, accessory             */
  /*    +- scarf (if any, hangs below the neck pivot)                   */
  /*    +- status ring                                                  */
  /* ------------------------------------------------------------------ */

  function build(def) {
    var group = new THREE.Group();

    var bodyMat = lambert(def.body);
    var headMat = lambert(def.head);
    var darkMat = lambert(0x333333);

    // Legs: pivoted Groups at the hips.
    function makeLeg(side) {
      var leg = new THREE.Group();
      leg.position.set(side * 0.17, 0.45, 0);
      var legMat = lambert(shade(def.body, 0.9));
      var shin = cap(0.13, 0.22, legMat);
      shin.position.set(0, -0.16, 0);
      leg.add(shin);
      var foot = sph(0.14, 8, 6, lambert(0x4a4038));
      foot.scale.set(1.0, 0.7, 1.4);
      foot.position.set(0, -0.33, 0.06);
      leg.add(foot);
      group.add(leg);
      return leg;
    }
    var legL = makeLeg(-1);
    var legR = makeLeg(1);

    // Body: stubby capsule.
    var body = cap(0.36, 0.35, bodyMat);
    body.position.y = 0.78;
    group.add(body);

    // Belly: two-tone sphere patch on the front of the body.
    var belly = sph(0.30, 12, 10, lambert(shade(def.body, 0.86)));
    belly.scale.set(0.85, 0.9, 0.55);
    belly.position.set(0, 0.66, 0.20);
    group.add(belly);

    // Arms: pivoted Groups at the shoulders.
    function makeArm(side) {
      var arm = new THREE.Group();
      arm.position.set(side * 0.42, 0.95, 0);
      var mesh = cap(0.105, 0.26, bodyMat);
      mesh.position.set(0, -0.18, 0);
      arm.add(mesh);
      group.add(arm);
      return arm;
    }
    var armL = makeArm(-1);
    var armR = makeArm(1);

    // Head group: pivoted at the neck so yaw/nod animates head + face + accessory.
    var headGroup = new THREE.Group();
    headGroup.position.set(0, NECK_Y, 0);
    group.add(headGroup);

    // Head: big round sphere.
    var head = sph(0.62, 16, 14, headMat);
    head.position.set(0, 0.28, 0);
    headGroup.add(head);

    // Eyes: two dark dots on the face.
    var eyeL = sph(0.06, 8, 6, darkMat);
    eyeL.position.set(-0.17, 0.35, 0.52);
    headGroup.add(eyeL);
    var eyeR = sph(0.06, 8, 6, darkMat);
    eyeR.position.set(0.17, 0.35, 0.52);
    headGroup.add(eyeR);

    // Blush: pink flattened spheres on the cheeks.
    [-1, 1].forEach(function (s) {
      var blush = sph(0.08, 8, 6, lambert(0xf4a7a7));
      blush.scale.set(1.3, 0.7, 0.5);
      blush.position.set(s * 0.36, 0.18, 0.42);
      headGroup.add(blush);
    });

    // Mouth: small flattened dark-red sphere.
    var mouth = sph(0.09, 8, 6, lambert(0x7a3b2e));
    mouth.scale.set(1.4, 0.5, 0.5);
    mouth.position.set(0, 0.12, 0.55);
    headGroup.add(mouth);

    // Accessory: into headGroup (head-local coords), except the scarf,
    // which hangs below the neck pivot and stays on the main group.
    var accType = (def.accessory && def.accessory.type) || 'none';
    var builder = ACCESSORY_BUILDERS[accType] || ACCESSORY_BUILDERS.none;
    builder(accType === 'scarf' ? group : headGroup, def);

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
    group.userData.headGroup = headGroup;
    group.userData.armL = armL;
    group.userData.armR = armR;
    group.userData.legL = legL;
    group.userData.legR = legR;
    group.userData.eyeL = eyeL;
    group.userData.eyeR = eyeR;
    group.userData.mouth = mouth;
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

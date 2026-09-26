/* bloom.js — selective glow-layer bloom for Agent Island.
 *
 * Cheap, no-build-tools "bloom": instead of full-scene post-processing, only
 * registered glow casters (lamps, cottage windows, moon/sun, fireflies,
 * lanterns, water glint) are rendered into a quarter-res target, blurred with
 * a separable Gaussian, and additively composited over the finished frame.
 * The main scene render is untouched, so the existing look can't wash out.
 *
 * Usage (from island.js):
 *   GlowBloom.init(renderer);            // once, after renderer creation
 *   GlowBloom.resize();                  // on window resize
 *   GlowBloom.addCaster(obj3d);          // register a glow proxy (returns it)
 *   GlowBloom.setStrength(0..2);        // art-directed per time of day
 *   GlowBloom.setEnabled(true/false);   // quality toggle
 *   GlowBloom.render(scene, camera);    // replaces renderer.render(scene, camera)
 */
window.GlowBloom = (function () {
  var renderer = null;
  var glowScene = null;
  var rtGlow = null, rtA = null, rtB = null;
  var blurH = null, blurV = null, comp = null;
  var orthoCam = null;
  var enabled = true;
  var strength = 1.0;
  var ready = false;

  var QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  var BLUR_FRAG =
    'uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;' +
    'void main(){' +
    ' vec4 c = texture2D(tDiffuse, vUv) * 0.227027;' +
    ' c += texture2D(tDiffuse, vUv + uDir * 1.384) * 0.316216;' +
    ' c += texture2D(tDiffuse, vUv - uDir * 1.384) * 0.316216;' +
    ' c += texture2D(tDiffuse, vUv + uDir * 3.230) * 0.070270;' +
    ' c += texture2D(tDiffuse, vUv - uDir * 3.230) * 0.070270;' +
    ' gl_FragColor = c; }';
  var COMP_FRAG =
    'uniform sampler2D tDiffuse; uniform float uStrength; varying vec2 vUv;' +
    'void main(){ vec3 g = texture2D(tDiffuse, vUv).rgb;' +
    ' gl_FragColor = vec4(g * uStrength, 1.0); }';

  function makeRT(w, h) {
    return new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
  }

  // fullscreen triangle (covers the screen with one tri, no camera transform needed)
  function quadPass(frag, uniforms) {
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    var sc = new THREE.Scene();
    sc.add(new THREE.Mesh(geo, mat));
    return { scene: sc, mat: mat };
  }

  function init(r) {
    if (ready) return;
    renderer = r;
    glowScene = new THREE.Scene();
    orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    blurH = quadPass(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } });
    blurV = quadPass(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(0, 1) } });
    comp = quadPass(COMP_FRAG, { tDiffuse: { value: null }, uStrength: { value: 1.0 } });
    comp.mat.blending = THREE.AdditiveBlending;
    comp.mat.transparent = true;
    resize();
    ready = true;
  }

  function resize() {
    if (!renderer) return;
    var s = renderer.getDrawingBufferSize(new THREE.Vector2());
    var w = Math.max(2, Math.floor(s.x / 4));
    var h = Math.max(2, Math.floor(s.y / 4));
    if (rtGlow) { rtGlow.dispose(); rtA.dispose(); rtB.dispose(); }
    rtGlow = makeRT(w, h);
    rtA = makeRT(w, h);
    rtB = makeRT(w, h);
  }

  function addCaster(obj) {
    if (glowScene && obj) glowScene.add(obj);
    return obj;
  }

  function blurPass(src, dst, pass, horizontal) {
    pass.mat.uniforms.tDiffuse.value = src.texture;
    if (horizontal) pass.mat.uniforms.uDir.value.set(1 / src.width, 0);
    else pass.mat.uniforms.uDir.value.set(0, 1 / src.height);
    renderer.setRenderTarget(dst);
    renderer.render(pass.scene, orthoCam);
  }

  function render(mainScene, camera) {
    if (!ready || !enabled || !glowScene.children.length) {
      renderer.render(mainScene, camera);
      return;
    }
    var prevAutoClear = renderer.autoClear;
    var prevClear = renderer.getClearColor(new THREE.Color());
    var prevAlpha = renderer.getClearAlpha();

    // 1. glow casters -> quarter-res target (black background)
    renderer.setRenderTarget(rtGlow);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(glowScene, camera);

    // 2. separable gaussian blur (single H+V pass — soft halo without blowout)
    blurPass(rtGlow, rtA, blurH, true);
    blurPass(rtA, rtB, blurV, false);

    // 3. main scene, exactly as before (restores clear color first)
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = true;
    renderer.render(mainScene, camera);

    // 4. additive composite of the blurred glow
    comp.mat.uniforms.tDiffuse.value = rtB.texture;
    comp.mat.uniforms.uStrength.value = strength;
    renderer.autoClear = false;
    renderer.render(comp.scene, orthoCam);

    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevAlpha);
  }

  return {
    init: init,
    resize: resize,
    addCaster: addCaster,
    render: render,
    setEnabled: function (b) { enabled = !!b; },
    isEnabled: function () { return enabled; },
    setStrength: function (v) { strength = Math.max(0, v); },
    get scene() { return glowScene; }
  };
})();

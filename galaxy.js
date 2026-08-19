/* The galaxy behind the landing page.
 *
 * Every drifting word is a real term out of the corpus -- a tool or a concept
 * some employer actually asked for -- so the ornament is also the argument:
 * this is what the market is made of, and there is a great deal of it.
 *
 * It is deliberately easy to switch off, because a first screen that costs a
 * phone its battery is a bad first screen. The whole thing is skipped when the
 * visitor asked for reduced motion, when there is no WebGL, while the canvas is
 * scrolled out of view, while the tab is hidden, and if the library simply fails
 * to arrive. The page is written to look finished without it.
 *
 * The motion is computed in the vertex shader rather than in JavaScript. That is
 * not only cheaper -- it is the only way to give every star its own orbital
 * period, and that shear is what winds the arms slowly forever instead of
 * turning the whole picture like a wheel.
 */

const canvas = document.querySelector('#galaxy');
const coarse = matchMedia('(pointer: coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How much this device should be asked to draw. */
const STARS = coarse ? 2600 : 6500;
const LABELS = coarse ? 14 : 26;

/** Terms an employer actually asked for. */
async function terms() {
  try {
    const data = await (await fetch('/data/jooob.json', { cache: 'no-cache' })).json();
    const known = Object.values(data.vocabulary || {});
    const unique = [...new Set(known.filter((t) => typeof t === 'string' && t.length < 22))];
    // shuffled, so two visits do not show the same constellation
    for (let i = unique.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [unique[i], unique[j]] = [unique[j], unique[i]];
    }
    return unique.slice(0, LABELS);
  } catch {
    return [];
  }
}

/** One word, drawn once into a texture. Cheaper than any text geometry, and it
 *  stays crisp because the tile is sized for the device's pixel ratio. */
function label(THREE, text, colour) {
  const scale = Math.min(devicePixelRatio || 1, 2);
  const pad = 8 * scale;
  const font = `600 ${26 * scale}px Vazirmatn, ui-sans-serif, system-ui, sans-serif`;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + pad * 2;
  const height = Math.ceil(34 * scale) + pad;

  const tile = document.createElement('canvas');
  tile.width = width;
  tile.height = height;
  const ctx = tile.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 12 * scale;
  ctx.fillText(text, pad, height / 2);

  const texture = new THREE.CanvasTexture(tile);
  texture.colorSpace = THREE.SRGBColorSpace;
  // starts invisible: the drift loop fades it in from the bottom of the field,
  // so nothing is ever seen appearing out of nothing on the first frame
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, opacity: 0,
  }));
  // Small on purpose. At 2.6 these were bigger than the headline and read as a
  // broken word cloud sitting on top of the copy, rather than as depth behind
  // it. A backdrop that competes with the text is not a backdrop.
  sprite.scale.set((width / height) * 0.95, 0.95, 1);
  return sprite;
}

/** The soft bulge at the centre. One sprite, drawn once: a real galaxy is
 *  brightest in the middle, and without it the centre read as a hole rather
 *  than as a nucleus. */
function core(THREE, rgb, light) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const ctx = tile.getContext('2d');
  const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, `rgba(${rgb}, 1)`);
  glow.addColorStop(0.35, `rgba(${rgb}, 0.32)`);
  glow.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);

  const texture = new THREE.CanvasTexture(tile);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false,
    opacity: light ? 0.28 : 0.5,
    blending: light ? THREE.NormalBlending : THREE.AdditiveBlending,
  }));
  sprite.scale.set(19, 19, 1);
  return sprite;
}

/* Each star carries its own radius and starting angle, and the shader turns it
 * at a speed that falls away with radius -- the inner disc laps the outer one,
 * so the two arms shear apart and rewind on a period no visitor will ever sit
 * through. `aSeed` desynchronises the twinkle, so it reads as atmosphere rather
 * than as one pulse. */
const VERTEX = `
  uniform float uTime;
  uniform float uSize;
  uniform float uRatio;
  attribute float aRadius;
  attribute float aAngle;
  attribute float aScale;
  attribute float aSeed;
  attribute vec3 aColour;
  varying vec3 vColour;
  varying float vTwinkle;

  void main() {
    float angle = aAngle + uTime * (1.5 / (aRadius + 6.0) + 0.014);
    vec3 world = vec3(cos(angle) * aRadius, position.y, sin(angle) * aRadius);
    vec4 view = modelViewMatrix * vec4(world, 1.0);

    vTwinkle = 0.6 + 0.4 * sin(uTime * (0.6 + aSeed * 1.9) + aSeed * 37.0);
    vColour = aColour;
    gl_PointSize = uSize * aScale * uRatio * (34.0 / max(-view.z, 1.0));
    gl_Position = projectionMatrix * view;
  }
`;

/* A square point reads as a dead pixel. The falloff is what makes it a star. */
const FRAGMENT = `
  precision mediump float;
  uniform float uOpacity;
  varying vec3 vColour;
  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = pow(1.0 - d * 2.0, 1.7);
    gl_FragColor = vec4(vColour, a * uOpacity * vTwinkle);
  }
`;

/** A two-armed spiral. The arm offset is what makes the eye read "galaxy"
 *  rather than "cloud of dots". */
function stars(THREE, count, inner, outer, light) {
  // only .y is read from `position`; the shader derives x and z from the polar
  // pair, because that is what lets each radius turn at its own rate
  const heights = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const angles = new Float32Array(count);
  const scales = new Float32Array(count);
  const seeds = new Float32Array(count);
  const colours = new Float32Array(count * 3);
  const near = new THREE.Color(inner);
  const far = new THREE.Color(outer);

  for (let i = 0; i < count; i += 1) {
    const radius = Math.pow(Math.random(), 0.62) * 26 + 1.6;
    const arm = (i % 2) * Math.PI;
    // cubed, so most of the scatter hugs the arm and only a few stars stray
    const stray = () => Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * radius * 0.22;
    const angle = arm + radius * 0.27 + Math.random() * 0.26;

    // the scatter is folded back into a radius and an angle, so it turns with
    // the arm instead of standing still while the arm slides out from under it
    const x = Math.cos(angle) * radius + stray();
    const z = Math.sin(angle) * radius + stray();
    radii[i] = Math.hypot(x, z);
    angles[i] = Math.atan2(z, x);
    heights[i * 3 + 1] = stray() * 0.42;                   // a galaxy is a disc
    // a field of identical dots looks printed; a few bright ones give it depth
    scales[i] = 0.55 + Math.pow(Math.random(), 2.5) * 2.2;
    seeds[i] = Math.random();

    const shade = near.clone().lerp(far, Math.min(radii[i] / 28, 1));
    colours[i * 3] = shade.r;
    colours[i * 3 + 1] = shade.g;
    colours[i * 3 + 2] = shade.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(heights, 3));
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
  // the shader places every star, so three cannot infer the extent from a
  // buffer that holds only heights -- without this the disc is culled away
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);

  return new THREE.Points(geometry, new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 4.8 },
      uRatio: { value: Math.min(devicePixelRatio || 1, 1.75) },
      uOpacity: { value: light ? 0.7 : 0.95 },
    },
    transparent: true,
    depthWrite: false,
    // Additive blending only makes sense against a dark sky: on the light theme
    // it drives every star towards white and the galaxy disappears into the
    // page. Normal blending keeps it visible on both.
    blending: light ? THREE.NormalBlending : THREE.AdditiveBlending,
  }));
}

/** Torn down and rebuilt when the theme flips, because the colours and the
 *  blend mode both depend on it and neither can be tweened in place. */
let teardown = null;

async function build() {
  if (!canvas) return;
  if (teardown) { teardown(); teardown = null; }

  // no WebGL is an ordinary state on plenty of machines, not an error to log
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return;

  let THREE;
  try {
    THREE = await import('three');
  } catch {
    return;                    // blocked, offline, or the CDN is having a day
  }

  const light = document.documentElement.dataset.theme === 'light';
  // deeper on light, brighter on dark -- the same hues, inverted in weight
  const inner = light ? '#4b3fb8' : '#7cc0ff';
  const outer = light ? '#1d3055' : '#7c5cff';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 300);
  camera.position.set(0, 26, 40);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true,
                                             powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);

  const galaxy = new THREE.Group();
  const disc = stars(THREE, STARS, inner, outer, light);
  galaxy.add(disc);
  galaxy.add(core(THREE, light ? '96, 84, 210' : '150, 195, 255', light));
  scene.add(galaxy);

  const words = [];
  for (const term of await terms()) {
    const sprite = label(THREE, term, light ? '#3f4c6b' : '#cfe3ff');
    // only in the outer disc: the middle of the screen belongs to the headline
    const radius = 17 + Math.random() * 13;
    const angle = Math.random() * Math.PI * 2;
    sprite.position.set(Math.cos(angle) * radius,
                        (Math.random() - 0.5) * 9,
                        Math.sin(angle) * radius);
    sprite.userData.drift = 0.1 + Math.random() * 0.25;
    galaxy.add(sprite);
    words.push(sprite);
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    const ratio = Math.min(devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    disc.material.uniforms.uRatio.value = ratio;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener('resize', resize, { passive: true });

  // a little parallax: enough to read as depth, not as movement
  let tiltX = 0;
  let tiltY = 0;
  if (!reduced) {
    addEventListener('pointermove', (event) => {
      tiltX = (event.clientX / innerWidth - 0.5) * 0.35;
      tiltY = (event.clientY / innerHeight - 0.5) * 0.2;
    }, { passive: true });
  }

  // reduced motion gets one still frame: the picture, without the movement
  if (reduced) {
    galaxy.rotation.y = 0.6;
    for (const word of words) word.material.opacity = 0.34;
    renderer.render(scene, camera);
    teardown = () => renderer.dispose();
    return;
  }

  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  const clock = new THREE.Clock();
  let time = 0;
  renderer.setAnimationLoop(() => {
    // scrolled past, or in a background tab: draw nothing at all
    if (!running || !visible) { clock.getDelta(); return; }
    const step = Math.min(clock.getDelta(), 0.05);
    time += step;
    disc.material.uniforms.uTime.value = time;

    // the group turns slowly on top of the shader's shear, which is what
    // carries the words around: the shear alone would leave them hanging still
    galaxy.rotation.y += step * 0.02;
    galaxy.rotation.x += (tiltY - galaxy.rotation.x * 0.5) * step * 0.6;
    galaxy.position.x += (tiltX * 4 - galaxy.position.x) * step * 1.2;

    // the disc breathes: a camera that never moves makes the depth read flat,
    // and three units over half a minute is felt rather than seen
    camera.position.z = 40 + Math.sin(time * 0.11) * 2.4;
    camera.position.y = 26 + Math.sin(time * 0.07) * 1.8;
    camera.lookAt(0, 0, 0);

    // the words rise slowly out of the disc and fold back into it, fading at
    // both ends so nothing is ever seen popping in or out at the edge
    for (const word of words) {
      word.position.y += word.userData.drift * step;
      if (word.position.y > 6) word.position.y = -6;
      const edge = Math.min(word.position.y + 6, 6 - word.position.y) / 2.5;
      word.material.opacity = 0.34 * Math.min(edge, 1);
    }

    renderer.render(scene, camera);
  });

  teardown = () => {
    renderer.setAnimationLoop(null);
    renderer.dispose();
  };
}

build();

// The theme button changes both the palette and the blend mode -- additive
// blending against a white page washes every star out -- so a flip rebuilds
// rather than leaving a galaxy tuned for the other background.
new MutationObserver((records) => {
  if (records.some((r) => r.attributeName === 'data-theme')) build();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

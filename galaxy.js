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
    const data = await (await fetch('data/jooob.json', { cache: 'no-cache' })).json();
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, opacity: 0.34,
  }));
  // Small on purpose. At 2.6 these were bigger than the headline and read as a
  // broken word cloud sitting on top of the copy, rather than as depth behind
  // it. A backdrop that competes with the text is not a backdrop.
  sprite.scale.set((width / height) * 0.95, 0.95, 1);
  return sprite;
}

/** A two-armed spiral. The arm offset is what makes the eye read "galaxy"
 *  rather than "cloud of dots". */
function stars(THREE, count, inner, outer, light) {
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const near = new THREE.Color(inner);
  const far = new THREE.Color(outer);

  for (let i = 0; i < count; i += 1) {
    const radius = Math.pow(Math.random(), 0.65) * 42 + 2;
    const arm = (i % 2) * Math.PI;
    // cubed, so most of the scatter hugs the arm and only a few stars stray
    const stray = () => Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * radius * 0.22;
    const angle = arm + radius * 0.14 + Math.random() * 0.5;

    positions[i * 3] = Math.cos(angle) * radius + stray();
    positions[i * 3 + 1] = stray() * 0.42;                 // a galaxy is a disc
    positions[i * 3 + 2] = Math.sin(angle) * radius + stray();

    const shade = near.clone().lerp(far, Math.min(radius / 44, 1));
    colours[i * 3] = shade.r;
    colours[i * 3 + 1] = shade.g;
    colours[i * 3 + 2] = shade.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.26, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: light ? 0.75 : 0.95, depthWrite: false,
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
  camera.position.set(0, 15, 52);
  camera.lookAt(0, 1, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true,
                                             powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);

  const galaxy = new THREE.Group();
  galaxy.add(stars(THREE, STARS, inner, outer, light));
  scene.add(galaxy);

  for (const term of await terms()) {
    const sprite = label(THREE, term, light ? '#3f4c6b' : '#cfe3ff');
    // only in the outer disc: the middle of the screen belongs to the headline
    const radius = 26 + Math.random() * 20;
    const angle = Math.random() * Math.PI * 2;
    sprite.position.set(Math.cos(angle) * radius,
                        (Math.random() - 0.5) * 9,
                        Math.sin(angle) * radius);
    sprite.userData.drift = 0.1 + Math.random() * 0.25;
    galaxy.add(sprite);
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setSize(w, h, false);
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
    renderer.render(scene, camera);
    teardown = () => renderer.dispose();
    return;
  }

  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // scrolled past, or in a background tab: draw nothing at all
    if (!running || !visible) { clock.getDelta(); return; }
    const step = Math.min(clock.getDelta(), 0.05);

    galaxy.rotation.y += step * 0.045;
    galaxy.rotation.x += (tiltY - galaxy.rotation.x * 0.5) * step * 0.6;
    galaxy.position.x += (tiltX * 4 - galaxy.position.x) * step * 1.2;

    // the words rise slowly out of the disc and fold back into it, so the field
    // keeps changing without anything ever leaving it
    for (const child of galaxy.children) {
      if (!child.userData.drift) continue;
      child.position.y += child.userData.drift * step;
      if (child.position.y > 6) child.position.y = -6;
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

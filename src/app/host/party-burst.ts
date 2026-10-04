// A few seconds of balloons, confetti, party hats and stars over the page,
// drawn with three.js on a click-through overlay. three is loaded on first use
// so it stays out of the board's initial bundle.

const COLORS = [0xf43f5e, 0xfbbf24, 0x34d399, 0x60a5fa, 0xa78bfa, 0xfb923c, 0xf472b6];
const DURATION = 4200;

export async function partyBurst() {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const THREE = await import("three");

  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "60" });
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 14;
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 6, 8);
  scene.add(sun);

  // Visible half-extents of the z=0 plane.
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  const halfW = halfH * camera.aspect;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

  type Mover = { obj: InstanceType<typeof THREE.Object3D>; v: InstanceType<typeof THREE.Vector3>; spin: InstanceType<typeof THREE.Vector3>; sway: number; phase: number; gravity: number };
  const movers: Mover[] = [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // Balloons: stretched glossy spheres with a knot and a string, rising and swaying.
  const balloonGeo = track(new THREE.SphereGeometry(0.62, 32, 24));
  const knotGeo = track(new THREE.ConeGeometry(0.1, 0.16, 12));
  const stringMat = track(new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.7 }));
  for (let i = 0; i < 16; i++) {
    const color = pick(COLORS);
    const mat = track(new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.1 }));
    const g = new THREE.Group();
    const body = new THREE.Mesh(balloonGeo, mat);
    body.scale.set(1, 1.18, 1);
    const knot = new THREE.Mesh(knotGeo, mat);
    knot.position.y = -0.78;
    knot.rotation.x = Math.PI;
    const pts = Array.from({ length: 12 }, (_, k) => new THREE.Vector3(Math.sin(k * 0.9) * 0.08, -0.85 - k * 0.16, 0));
    const string = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(pts)), stringMat);
    g.add(body, knot, string);
    const s = rand(0.7, 1.15);
    g.scale.setScalar(s);
    g.position.set(rand(-halfW, halfW), -halfH - rand(0.3, 4), rand(-3, 2));
    scene.add(g);
    movers.push({ obj: g, v: new THREE.Vector3(0, rand(4.5, 6.5), 0), spin: new THREE.Vector3(0, rand(-0.6, 0.6), 0), sway: rand(0.4, 0.9), phase: rand(0, 6), gravity: 0 });
  }

  // Confetti: small double-sided rectangles bursting up from the bottom, then falling.
  const confettiGeo = track(new THREE.PlaneGeometry(0.16, 0.3));
  const confettiMats = COLORS.map((c) => track(new THREE.MeshStandardMaterial({ color: c, side: THREE.DoubleSide, roughness: 0.6 })));
  for (let i = 0; i < 220; i++) {
    const m = new THREE.Mesh(confettiGeo, pick(confettiMats));
    const fromLeft = i % 2 === 0;
    m.position.set(fromLeft ? -halfW * 0.85 : halfW * 0.85, -halfH * 0.9, rand(-2, 2));
    scene.add(m);
    movers.push({
      obj: m,
      v: new THREE.Vector3((fromLeft ? 1 : -1) * rand(3, 13), rand(12, 21), rand(-2, 2)),
      spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)), sway: rand(0.2, 0.8), phase: rand(0, 6), gravity: 9,
    });
  }

  // Party hats: striped cones that tumble across.
  const hatGeo = track(new THREE.ConeGeometry(0.45, 1.1, 24, 1, true));
  const pomGeo = track(new THREE.SphereGeometry(0.13, 12, 10));
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const hatMat = track(new THREE.MeshStandardMaterial({ color: pick(COLORS), side: THREE.DoubleSide, roughness: 0.4 }));
    const pom = new THREE.Mesh(pomGeo, track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })));
    pom.position.y = 0.6;
    g.add(new THREE.Mesh(hatGeo, hatMat), pom);
    g.position.set(rand(-halfW, halfW), -halfH - 1, rand(-1, 1));
    scene.add(g);
    movers.push({ obj: g, v: new THREE.Vector3(rand(-2, 2), rand(11, 15), 0), spin: new THREE.Vector3(rand(-3, 3), rand(-3, 3), rand(-3, 3)), sway: 0, phase: 0, gravity: 9 });
  }

  // Stars: flat five-pointed shapes that twinkle near the top.
  const star = new THREE.Shape();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 0.16 : 0.4, a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    if (k) star.lineTo(Math.cos(a) * r, Math.sin(a) * r); else star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const starGeo = track(new THREE.ShapeGeometry(star));
  const starMat = track(new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, side: THREE.DoubleSide }));
  const stars: InstanceType<typeof THREE.Mesh>[] = [];
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Mesh(starGeo, starMat);
    s.position.set(rand(-halfW, halfW), rand(halfH * 0.1, halfH * 0.9), rand(-2, 1));
    s.userData.phase = rand(0, 6);
    scene.add(s);
    stars.push(s);
  }

  const t0 = performance.now();
  let last = t0, frame = 0;
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  await new Promise<void>((done) => {
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      for (const m of movers) {
        m.v.y -= m.gravity * dt;
        if (m.gravity) m.v.multiplyScalar(1 - 0.5 * dt); // air drag so confetti floats
        m.obj.position.addScaledVector(m.v, dt);
        m.obj.position.x += Math.sin(t * 2 + m.phase) * m.sway * dt;
        m.obj.rotation.x += m.spin.x * dt;
        m.obj.rotation.y += m.spin.y * dt;
        m.obj.rotation.z += m.spin.z * dt;
      }
      for (const s of stars) {
        const k = Math.max(0, Math.sin(t * 5 + s.userData.phase));
        s.scale.setScalar(0.4 + k);
        s.rotation.z += dt;
      }
      // Fade everything out over the last 0.8s.
      const left = DURATION - (now - t0);
      canvas.style.opacity = String(Math.min(1, Math.max(0, left / 800)));
      renderer.render(scene, camera);
      if (left > 0) frame = requestAnimationFrame(tick); else done();
    };
    frame = requestAnimationFrame(tick);
  });

  cancelAnimationFrame(frame);
  window.removeEventListener("resize", onResize);
  disposables.forEach((d) => d.dispose());
  renderer.dispose();
  canvas.remove();
}

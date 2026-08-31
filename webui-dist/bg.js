(() => {
  const c = document.getElementById('bg-canvas');
  if (!c) return;
  const g = c.getContext('webgl2', { alpha: true, antialias: false });
  if (!g) return;

  const P = g.createProgram();

  function S(t, s) {
    const h = g.createShader(t);
    g.shaderSource(h, s);
    g.compileShader(h);
    g.attachShader(P, h);
  }

  S(g.VERTEX_SHADER, `#version 300 es
  in vec2 p;
  void main(){gl_Position=vec4(p,0.,1.);}`);

  S(g.FRAGMENT_SHADER, `#version 300 es
  precision highp float;
  uniform vec2 r;
  uniform float t;
  uniform vec2 u_mouse;
  out vec4 o;

  mat2 m(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float map(vec3 p, vec2 uv, vec2 mouse) {
    p.xz *= m(t*.4);
    p.xy *= m(t*.1);
    vec3 q = p*2. + t;
    float base = length(p+vec3(sin(t*.7)))*log(length(p)+1.) + sin(q.x+sin(q.z+sin(q.y)))*.5 - 1.;
    float dist = length(uv - mouse);
    float influence = 0.6 * exp(-dist*dist / (0.12*0.12));
    return base - influence;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / r;
    vec2 a = uv * vec2(r.x / r.y, 1.0) - vec2(.9, .5);

    float particleIntensity = 0.0;
    for (float i = 0.0; i < 25.0; i++) {
      vec2 p = vec2(
        sin(i * 1.234 + t * 0.08) * 0.9 + 0.5,
        cos(i * 2.345 + t * 0.12) * 0.9 + 0.5
      );
      float size = 0.02 + 0.03 * hash(vec2(i, 1.0));
      float d = length(uv - p);
      float glow = 0.05 / (d + 0.05);
      float flicker = 0.5 + 0.5 * sin(t * 3.0 + i * 10.0);
      particleIntensity += glow * flicker * 0.5;
    }
    particleIntensity = clamp(particleIntensity, 0.0, 1.0);

    vec3 cl = vec3(0);
    float d = 2.5;
    for (int i = 0; i <= 5; i++) {
      vec3 p = vec3(0,0,4) + normalize(vec3(a, -1)) * d;
      float rz = map(p, uv, u_mouse);
      float f = clamp((rz - map(p + .1, uv, u_mouse)) * .5, -.1, 1.);
      float pulse = 1.0 + 0.08 * sin(t * 0.4);
      vec3 l = vec3(.55, .35, .40) * pulse + vec3(4.2, 3.4, 3.8) * f;
      cl = cl * l + smoothstep(2.5, 0., rz) * .6 * l;
      d += min(rz, 1.);
    }

    vec3 particleColor = vec3(1.0, 0.8, 0.9);
    cl += particleColor * particleIntensity * 0.35;
    cl = clamp(cl, 0.0, 1.0);
    o = vec4(cl, 1);
  }`);

  g.linkProgram(P);
  g.useProgram(P);

  const V = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    B = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, B);
  g.bufferData(g.ARRAY_BUFFER, V, g.STATIC_DRAW);
  g.enableVertexAttribArray(0);
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);

  const R = g.getUniformLocation(P, 'r');
  const T = g.getUniformLocation(P, 't');
  const U_MOUSE = g.getUniformLocation(P, 'u_mouse');

  let startTime = performance.now();
  let mouseNorm = { x: -10, y: -10 };

  function resize() {
    const d = Math.min(devicePixelRatio, 2);
    c.width = innerWidth * d;
    c.height = innerHeight * d;
    g.viewport(0, 0, c.width, c.height);
  }

  addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', (e) => {
    const rect = c.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const normX = cssX / rect.width;
    const normY = 1.0 - cssY / rect.height;
    mouseNorm.x = Math.min(1, Math.max(0, normX));
    mouseNorm.y = Math.min(1, Math.max(0, normY));
  });

  window.addEventListener('mouseleave', () => {
    mouseNorm.x = -10;
    mouseNorm.y = -10;
  });

  window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    const touch = e.touches[0];
    const cssX = touch.clientX - rect.left;
    const cssY = touch.clientY - rect.top;
    const normX = cssX / rect.width;
    const normY = 1.0 - cssY / rect.height;
    mouseNorm.x = Math.min(1, Math.max(0, normX));
    mouseNorm.y = Math.min(1, Math.max(0, normY));
  }, { passive: false });

  window.addEventListener('touchend', () => {
    mouseNorm.x = -10;
    mouseNorm.y = -10;
  });

  function render() {
    const elapsed = (performance.now() - startTime) / 1000;
    g.uniform2f(R, c.width, c.height);
    g.uniform1f(T, elapsed);
    g.uniform2f(U_MOUSE, mouseNorm.x, mouseNorm.y);
    g.drawArrays(g.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  }

  render();
})();

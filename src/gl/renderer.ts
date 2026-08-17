import type { RgbColor } from '../lib/colors';
import { binnedCdf } from '../lib/equalize';
import {
  ACCUM_FRAG, ACCUM_VERT,
  FLAT_FRAG, FLAT_VERT,
  POINT_FRAG, POINT_VERT,
  FLOW_JOINT_FRAG, FLOW_JOINT_VERT,
  RESOLVE_FRAG, RESOLVE_VERT,
  THICK_FRAG, THICK_VERT,
} from './shaders';

export type View = { centerX: number; centerY: number; scaleX: number; scaleY: number };

// Everything the map can show at once. Only one of network / desireLines /
// agents is ever set -- the mode decides -- but zones can accompany any of
// them, hollow, as the basemap.
export type Scene = {
  view: View;
  pixelRatio: number;
  // Rebuilt per frame rather than taken straight off the geometry: zone
  // vertices move as the detail control collapses them, so the triangulation
  // that ships with the file is only valid at full detail.
  // fillColors null means hollow -- only the borders draw, and the white
  // background shows through.
  zones: {
    fillPositions: Float32Array;
    fillColors: Uint8Array | null;
    borderPositions: Float32Array;
    borderWidthCssPx: number;
  } | null;
  // Either the simplified virtual graph or the real links, whichever the
  // view calls for -- both arrive as the same x1,y1,x2,y2 lines with one
  // colour each, so the renderer doesn't need to know which it got.
  // jointColors runs per endpoint rather than per line: where lines meet,
  // the join is blended from all of them.
  network: {
    positions: Float32Array;
    colors: Uint8Array;
    jointColors: Uint8Array;
    widthCssPx: number;
  } | null;
  agents: { positions: Float32Array; colors: Uint8Array; radiusCssPx: number; borderCssPx: number } | null;
  desireLines: {
    positions: Float32Array;
    quantities: Float32Array;
    ramp: RgbColor[];
    widthCssPx: number;
  } | null;
};

// What the desire-line pass measured off this exact frame. The legend needs
// it to label its ticks, and it can only be known after accumulating, so it
// comes back out of the draw rather than being computed alongside it.
export type FlowStats = { max: number; cdf: Float32Array };

const CDF_BINS = 256;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram()!;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

// readPixels on an RGBA16F attachment hands back half floats, which JS has no
// native type for. Accumulated flow stays far below half float's 65504
// ceiling for any dataset seen so far (a whole country peaked in the low
// hundreds), so the range is not the concern -- this only has to undo the
// encoding.
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

type Cached = { buffer: WebGLBuffer; source: ArrayBufferView | null };

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private flat: WebGLProgram;
  private points: WebGLProgram;
  private thick: WebGLProgram;
  private accum: WebGLProgram;
  private resolve: WebGLProgram;
  private flowJoint: WebGLProgram;
  private quad: WebGLBuffer;
  // The line quad runs 0..1 along the segment and -1..1 across it, so the
  // vertex shader can place it by interpolating between the two endpoints.
  private lineQuad: WebGLBuffer;
  // One vertex array per draw path. Enabled attribute arrays and their
  // divisors are otherwise global state: the agent pass enables arrays at
  // the point program's locations, and those stay enabled -- still bound to
  // small per-agent buffers -- when a later pass draws far more vertices
  // through a program whose attributes sit at different locations. The draw
  // then fails validation and renders nothing, and stays broken until the
  // context is thrown away. A vertex array scopes all of that per path.
  private flatVao: WebGLVertexArrayObject;
  private pointsVao: WebGLVertexArrayObject;
  private thickVao: WebGLVertexArrayObject;
  private accumVao: WebGLVertexArrayObject;
  private resolveVao: WebGLVertexArrayObject;
  private flowJointVao: WebGLVertexArrayObject;
  private cdfTexture: WebGLTexture;
  private rampTexture: WebGLTexture;
  private accumulator: {
    drawFramebuffer: WebGLFramebuffer;
    resolveFramebuffer: WebGLFramebuffer;
    renderbuffer: WebGLRenderbuffer | null;
    texture: WebGLTexture;
    width: number;
    height: number;
  } | null = null;
  private buffers = new Map<string, Cached>();
  // Zeroed instance colours, grown as needed and handed out as exact-length
  // views. Black is the only colour zone outlines take, so there is nothing
  // per-feature to store.
  private black: Uint8Array = new Uint8Array(0);
  private floatTargetsSupported: boolean;
  private readback: Uint16Array | Float32Array | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // Antialiasing on: every line is 1px now, so almost all of a line is
    // edge, and multisampling is what keeps those edges from stair-stepping.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    // Float render targets are what let the accumulator sum flow past 1
    // without clamping. Without them desire lines simply can't be drawn.
    this.floatTargetsSupported = !!gl.getExtension('EXT_color_buffer_float');

    this.flat = link(gl, FLAT_VERT, FLAT_FRAG);
    this.points = link(gl, POINT_VERT, POINT_FRAG);
    this.thick = link(gl, THICK_VERT, THICK_FRAG);
    this.accum = link(gl, ACCUM_VERT, ACCUM_FRAG);
    this.resolve = link(gl, RESOLVE_VERT, RESOLVE_FRAG);
    this.flowJoint = link(gl, FLOW_JOINT_VERT, FLOW_JOINT_FRAG);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.lineQuad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );

    this.flatVao = gl.createVertexArray()!;
    this.pointsVao = gl.createVertexArray()!;
    this.thickVao = gl.createVertexArray()!;
    this.accumVao = gl.createVertexArray()!;
    this.resolveVao = gl.createVertexArray()!;
    this.flowJointVao = gl.createVertexArray()!;

    this.cdfTexture = this.makeLookup(gl.R32F, CDF_BINS);
    this.rampTexture = this.makeLookup(gl.RGBA8, 128);
  }

  get supportsFlow(): boolean {
    return this.floatTargetsSupported;
  }

  private makeLookup(internalFormat: number, width: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // NEAREST throughout: the ramp holds exactly the palette's own colors and
    // interpolating between them would invent colors that aren't on the
    // wheel.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, 1);
    return texture;
  }

  // Uploads only when the array identity changed. Positions never change once
  // a file is loaded, so this keeps zooming to a transform update.
  private upload(key: string, data: ArrayBufferView, usage: number): WebGLBuffer {
    const gl = this.gl;
    let entry = this.buffers.get(key);
    if (!entry) {
      entry = { buffer: gl.createBuffer()!, source: null };
      this.buffers.set(key, entry);
    }
    if (entry.source !== data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      entry.source = data;
    }
    return entry.buffer;
  }

  private blackFor(length: number): Uint8Array {
    if (this.black.length < length) this.black = new Uint8Array(length);
    return this.black.length === length ? this.black : this.black.subarray(0, length);
  }

  invalidate() {
    const gl = this.gl;
    for (const entry of this.buffers.values()) gl.deleteBuffer(entry.buffer);
    this.buffers.clear();
  }

  // A draw rejected for a bad attribute buffer is otherwise completely
  // silent: WebGL flags the error and renders nothing, with no exception and
  // no console output. Cheap enough to leave on, since renders here are
  // driven by user actions rather than by an animation loop.
  private checkError(label: string) {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) {
      console.error(`WebGL error after ${label}: 0x${error.toString(16)}`);
    }
  }

  private setTransform(program: WebGLProgram, view: View) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(program, 'u_center'), view.centerX, view.centerY);
    gl.uniform2f(gl.getUniformLocation(program, 'u_scale'), view.scaleX, view.scaleY);
  }

  private drawFlat(key: string, positions: Float32Array, colors: Uint8Array, mode: number, view: View) {
    if (positions.length === 0) return;
    const gl = this.gl;

    gl.bindVertexArray(this.flatVao);
    gl.useProgram(this.flat);
    this.setTransform(this.flat, view);

    const positionLoc = gl.getAttribLocation(this.flat, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:pos`, positions, gl.STATIC_DRAW));
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const colorLoc = gl.getAttribLocation(this.flat, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:col`, colors, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(mode, 0, positions.length / 2);
    this.checkError(key);
    gl.bindVertexArray(null);
  }

  // Instanced discs, used both for agent dots and for the round joins that
  // cover the seam where two link quads meet at a shared endpoint. Joins
  // never carry a border -- they exist to blend into the lines around them,
  // not to be outlined -- so borderCssPx defaults to none and only the
  // agents call site passes a real one.
  private drawPoints(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    radiusCssPx: number,
    view: View,
    width: number,
    height: number,
    pixelRatio: number,
    borderCssPx = 0,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;

    gl.bindVertexArray(this.pointsVao);
    gl.useProgram(this.points);
    this.setTransform(this.points, view);
    const fillRadius = radiusCssPx * pixelRatio;
    const outerRadius = fillRadius + borderCssPx * pixelRatio;
    gl.uniform2f(
      gl.getUniformLocation(this.points, 'u_pixelRadius'),
      (outerRadius * 2) / width,
      (outerRadius * 2) / height,
    );
    gl.uniform1f(gl.getUniformLocation(this.points, 'u_radiusPx'), outerRadius);
    gl.uniform1f(
      gl.getUniformLocation(this.points, 'u_innerRatio'),
      outerRadius > 0 ? fillRadius / outerRadius : 1,
    );

    const cornerLoc = gl.getAttribLocation(this.points, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    const positionLoc = gl.getAttribLocation(this.points, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:pos`, positions, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(positionLoc, 1);

    const colorLoc = gl.getAttribLocation(this.points, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:col`, colors, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, positions.length / 2);
    this.checkError(key);
    gl.bindVertexArray(null);
  }

  // Triangulated lines: one instanced quad per segment, stretched along it
  // and extruded across it in the vertex shader.
  private drawThick(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    widthCssPx: number,
    view: View,
    width: number,
    height: number,
    pixelRatio: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;

    gl.bindVertexArray(this.thickVao);
    gl.useProgram(this.thick);
    this.setTransform(this.thick, view);
    gl.uniform2f(gl.getUniformLocation(this.thick, 'u_viewportPx'), width, height);
    gl.uniform1f(gl.getUniformLocation(this.thick, 'u_halfWidthPx'), (widthCssPx * pixelRatio) / 2);

    const cornerLoc = gl.getAttribLocation(this.thick, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    // Both endpoints come from one vec4 attribute: x1,y1,x2,y2 is already the
    // buffer's layout, so a 16-byte stride reads a whole line per instance.
    const endpointsLoc = gl.getAttribLocation(this.thick, 'a_endpoints');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:pos`, positions, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(endpointsLoc);
    gl.vertexAttribPointer(endpointsLoc, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(endpointsLoc, 1);

    const colorLoc = gl.getAttribLocation(this.thick, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:col`, colors, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, positions.length / 4);
    this.checkError(key);
    gl.bindVertexArray(null);
  }

  // Discs at every line endpoint, one line width across, so the flat-ended
  // quads meeting at a shared point read as a join rather than a notch. The
  // line buffer is already a list of x,y pairs, so it doubles as the join
  // positions with no extra array.
  private drawJoints(
    positions: Float32Array,
    colors: Uint8Array,
    widthCssPx: number,
    view: View,
    width: number,
    height: number,
    pixelRatio: number,
  ) {
    this.drawPoints('joints', positions, colors, widthCssPx / 2, view, width, height, pixelRatio);
  }

  private ensureAccumulator(width: number, height: number) {
    const gl = this.gl;
    if (this.accumulator && this.accumulator.width === width && this.accumulator.height === height) {
      return this.accumulator;
    }
    this.disposeAccumulator();

    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const resolveFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // `antialias: true` only ever applied to the default framebuffer, so
    // without an explicitly multisampled target the accumulation pass would
    // be the one thing on the map with no antialiasing at all. Multisampled
    // RGBA16F is a step beyond plain float-renderability, so this checks
    // completeness rather than assuming, and falls back to accumulating
    // straight into the texture if a driver refuses.
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    let renderbuffer: WebGLRenderbuffer | null = null;
    let drawFramebuffer = resolveFramebuffer;

    if (samples > 1) {
      renderbuffer = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, width, height);
      const multisampled = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, multisampled);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        drawFramebuffer = multisampled;
      } else {
        gl.deleteFramebuffer(multisampled);
        gl.deleteRenderbuffer(renderbuffer);
        renderbuffer = null;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumulator = { drawFramebuffer, resolveFramebuffer, renderbuffer, texture, width, height };
    this.readback = null; // allocated once the read format is known
    return this.accumulator;
  }

  private disposeAccumulator() {
    const gl = this.gl;
    if (!this.accumulator) return;
    gl.deleteFramebuffer(this.accumulator.resolveFramebuffer);
    gl.deleteTexture(this.accumulator.texture);
    if (this.accumulator.renderbuffer) gl.deleteRenderbuffer(this.accumulator.renderbuffer);
    if (this.accumulator.drawFramebuffer !== this.accumulator.resolveFramebuffer) {
      gl.deleteFramebuffer(this.accumulator.drawFramebuffer);
    }
    this.accumulator = null;
    this.readback = null;
  }

  // Accumulate, measure, resolve. The measure step is a real GPU->CPU stall,
  // paid once per zoom or selection change rather than per frame -- there is
  // no continuous interaction left in the map for it to interrupt.
  private drawFlow(
    layer: NonNullable<Scene['desireLines']>,
    view: View,
    width: number,
    height: number,
    pixelRatio: number,
  ): FlowStats | null {
    const gl = this.gl;
    if (!this.floatTargetsSupported || layer.positions.length === 0) return null;

    const target = this.ensureAccumulator(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.drawFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.bindVertexArray(this.accumVao);
    gl.useProgram(this.accum);
    this.setTransform(this.accum, view);
    gl.uniform2f(gl.getUniformLocation(this.accum, 'u_viewportPx'), width, height);
    gl.uniform1f(gl.getUniformLocation(this.accum, 'u_halfWidthPx'), (layer.widthCssPx * pixelRatio) / 2);

    const cornerLoc = gl.getAttribLocation(this.accum, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    const endpointsLoc = gl.getAttribLocation(this.accum, 'a_endpoints');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('flow:pos', layer.positions, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(endpointsLoc);
    gl.vertexAttribPointer(endpointsLoc, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(endpointsLoc, 1);

    // One quantity per edge, and now one instance per edge too, so it maps
    // straight across with no per-vertex duplication.
    const quantityLoc = gl.getAttribLocation(this.accum, 'a_quantity');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('flow:qty', layer.quantities, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(quantityLoc);
    gl.vertexAttribPointer(quantityLoc, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(quantityLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, layer.positions.length / 4);
    this.checkError('desire-line accumulation');
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    if (target.drawFramebuffer !== target.resolveFramebuffer) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.drawFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFramebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    // Measure: the same coverage correction the resolve shader applies, so
    // the histogram is built over exactly the values that will be colored.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.resolveFramebuffer);

    // WebGL2 guarantees only (RGBA, UNSIGNED_BYTE) plus one pair the
    // implementation picks per attachment format. For RGBA16F that is
    // usually (RGBA, HALF_FLOAT), but a driver is free to prefer FLOAT, and
    // guessing wrong is an INVALID_OPERATION that silently reads nothing --
    // so this asks rather than assuming.
    const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
    const isFloat = readType === gl.FLOAT;
    const pixels = width * height;
    if (!this.readback || this.readback.length !== pixels * 4
      || (isFloat) !== (this.readback instanceof Float32Array)) {
      this.readback = isFloat ? new Float32Array(pixels * 4) : new Uint16Array(pixels * 4);
    }
    const raw = this.readback;
    gl.readPixels(0, 0, width, height, gl.RGBA, isFloat ? gl.FLOAT : gl.HALF_FLOAT, raw);
    this.checkError('accumulator readback');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const decode = isFloat ? (bits: number) => bits : halfToFloat;
    const values = new Float32Array(pixels);
    let max = 0;
    for (let i = 0; i < pixels; i++) {
      const coverage = Math.min(decode(raw[i * 4 + 3]), 1);
      if (!(coverage > 1e-4)) continue;
      const value = decode(raw[i * 4]) / coverage;
      values[i] = value;
      if (value > max) max = value;
    }
    const cdf = binnedCdf(values, max, CDF_BINS);

    gl.bindTexture(gl.TEXTURE_2D, this.cdfTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CDF_BINS, 1, gl.RED, gl.FLOAT, cdf);
    this.checkError('cdf upload');

    const rampPixels = new Uint8Array(128 * 4);
    layer.ramp.forEach((c, i) => {
      rampPixels[i * 4] = c.r;
      rampPixels[i * 4 + 1] = c.g;
      rampPixels[i * 4 + 2] = c.b;
      rampPixels[i * 4 + 3] = 255;
    });
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RGBA, gl.UNSIGNED_BYTE, rampPixels);
    this.checkError('ramp upload');

    // Resolve onto the scene, blended so partially covered edges soften into
    // what's beneath instead of punching a hard silhouette.
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindVertexArray(this.resolveVao);
    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_accumulator'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cdfTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_cdf'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_ramp'), 2);
    gl.uniform1f(gl.getUniformLocation(this.resolve, 'u_maxValue'), max);

    const resolveCornerLoc = gl.getAttribLocation(this.resolve, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(resolveCornerLoc);
    gl.vertexAttribPointer(resolveCornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.checkError('desire-line resolve');
    gl.bindVertexArray(null);

    // Joins last, reading the accumulator the resolve pass just read and
    // never writing to it. The line buffer is already a list of x,y pairs,
    // so it supplies the endpoint positions with no array of its own.
    gl.bindVertexArray(this.flowJointVao);
    gl.useProgram(this.flowJoint);
    this.setTransform(this.flowJoint, view);
    const jointRadius = (layer.widthCssPx * pixelRatio) / 2;
    gl.uniform2f(
      gl.getUniformLocation(this.flowJoint, 'u_pixelRadius'),
      (jointRadius * 2) / width,
      (jointRadius * 2) / height,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(gl.getUniformLocation(this.flowJoint, 'u_accumulator'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cdfTexture);
    gl.uniform1i(gl.getUniformLocation(this.flowJoint, 'u_cdf'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.uniform1i(gl.getUniformLocation(this.flowJoint, 'u_ramp'), 2);
    gl.uniform1f(gl.getUniformLocation(this.flowJoint, 'u_maxValue'), max);

    const jointCornerLoc = gl.getAttribLocation(this.flowJoint, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(jointCornerLoc);
    gl.vertexAttribPointer(jointCornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(jointCornerLoc, 0);

    const jointPositionLoc = gl.getAttribLocation(this.flowJoint, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('flow:pos', layer.positions, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(jointPositionLoc);
    gl.vertexAttribPointer(jointPositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(jointPositionLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, layer.positions.length / 2);
    this.checkError('desire-line joins');
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);

    return { max, cdf };
  }

  render(scene: Scene): FlowStats | null {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    // Always white. There is one mode now, and this is its paper.
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    if (scene.zones) {
      const { fillPositions, fillColors, borderPositions, borderWidthCssPx } = scene.zones;
      if (fillColors) {
        this.drawFlat('zoneFill', fillPositions, fillColors, gl.TRIANGLES, scene.view);
      }
      // Black throughout -- the one colour a zone outline ever takes -- so the
      // colour buffers are simply zeroed and grown as needed.
      const black = this.blackFor((borderPositions.length / 4) * 3);
      this.drawThick(
        'zoneBorder', borderPositions, black, borderWidthCssPx,
        scene.view, width, height, scene.pixelRatio,
      );
      this.drawJoints(
        borderPositions, this.blackFor((borderPositions.length / 2) * 3), borderWidthCssPx,
        scene.view, width, height, scene.pixelRatio,
      );
    }

    if (scene.network) {
      const { positions, colors, jointColors, widthCssPx } = scene.network;
      this.drawThick('network', positions, colors, widthCssPx, scene.view, width, height, scene.pixelRatio);
      this.drawJoints(positions, jointColors, widthCssPx, scene.view, width, height, scene.pixelRatio);
    }

    let stats: FlowStats | null = null;
    if (scene.desireLines) {
      stats = this.drawFlow(scene.desireLines, scene.view, width, height, scene.pixelRatio);
    }

    if (scene.agents) {
      this.drawPoints(
        'agents',
        scene.agents.positions,
        scene.agents.colors,
        scene.agents.radiusCssPx,
        scene.view,
        width,
        height,
        scene.pixelRatio,
        scene.agents.borderCssPx,
      );
    }

    return stats;
  }

  dispose() {
    const gl = this.gl;
    this.invalidate();
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.lineQuad);
    gl.deleteVertexArray(this.flatVao);
    gl.deleteVertexArray(this.pointsVao);
    gl.deleteVertexArray(this.thickVao);
    gl.deleteVertexArray(this.accumVao);
    gl.deleteVertexArray(this.resolveVao);
    gl.deleteVertexArray(this.flowJointVao);
    gl.deleteTexture(this.cdfTexture);
    gl.deleteTexture(this.rampTexture);
    this.disposeAccumulator();
    gl.deleteProgram(this.flat);
    gl.deleteProgram(this.points);
    gl.deleteProgram(this.thick);
    gl.deleteProgram(this.accum);
    gl.deleteProgram(this.resolve);
    gl.deleteProgram(this.flowJoint);
  }
}

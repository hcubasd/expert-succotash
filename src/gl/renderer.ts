import { wheel } from '../lib/colors';
import type { RgbColor } from '../lib/colors';
import type { Geometries } from '../lib/geometryMaker';
import {
  FLAT_FRAG, FLAT_VERT,
  HUE_FRAG, HUE_VERT,
  POINT_FRAG, POINT_VERT,
  RESOLVE_FRAG, RESOLVE_VERT,
} from './shaders';

export type View = { centerX: number; centerY: number; scaleX: number; scaleY: number };

// In CSS pixels, not device pixels: the canvas backing store is scaled up by
// devicePixelRatio, so a radius measured against it directly would come out
// half-size on a 2x display instead of the same apparent size at twice the
// sharpness. Callers pass the ratio in and it's applied at the uniform.
const AGENT_RADIUS_CSS_PX = 2.5;

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

type Buffers = {
  position: WebGLBuffer;
  color: WebGLBuffer;
  hue?: WebGLBuffer;
  vertexCount: number;
  // Colors are rewritten in place when the selection changes, so the arrays
  // keep their identity and can't be compared by reference. This is the
  // stamp that says whether the GPU copy is still current -- without it a
  // pan would re-upload every color buffer on every frame.
  colorVersion: number;
};

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private flat: WebGLProgram;
  private points: WebGLProgram;
  private hue: WebGLProgram;
  private resolve: WebGLProgram;
  private quad: WebGLBuffer;
  private wheelTexture: WebGLTexture;
  private accumulator: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  private uploaded = new Map<string, Buffers>();
  private floatTargetsSupported: boolean;
  // Which luminance the wheel texture currently holds, so a repeated
  // setLuminance for the same mode (most frames) is a no-op rather than a
  // re-upload.
  private wheelLuminance: number | null = null;

  constructor(canvas: HTMLCanvasElement, luminance: number) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    // Float render targets are what let the hue accumulator sum unit vectors
    // without clamping to [0,1]. Universally present on desktop GPUs; if it's
    // missing we simply fall back to drawing desire lines opaque.
    this.floatTargetsSupported = !!gl.getExtension('EXT_color_buffer_float');

    this.flat = link(gl, FLAT_VERT, FLAT_FRAG);
    this.points = link(gl, POINT_VERT, POINT_FRAG);
    this.hue = link(gl, HUE_VERT, HUE_FRAG);
    this.resolve = link(gl, RESOLVE_VERT, RESOLVE_FRAG);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.wheelTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // REPEAT so an angle landing just past the last vertex wraps to the first,
    // which is what a wheel should do.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setLuminance(luminance);
  }

  // The 256 wheel vertices as a lookup texture, so the resolve pass can turn
  // an averaged angle straight back into the exact palette color instead of
  // reimplementing CIELAB conversion in GLSL. The wheel's colors depend on
  // luminance (dark vs. light mode draw from different points on the gamut),
  // so this has to be callable again whenever the mode changes, not just
  // once at construction.
  setLuminance(luminance: number) {
    if (this.wheelLuminance === luminance) return;
    const gl = this.gl;
    const colors = wheel(luminance);
    const pixels = new Uint8Array(colors.length * 4);
    colors.forEach((c, i) => {
      pixels[i * 4] = c.r;
      pixels[i * 4 + 1] = c.g;
      pixels[i * 4 + 2] = c.b;
      pixels[i * 4 + 3] = 255;
    });
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, colors.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.wheelLuminance = luminance;
  }

  private buffers(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    colorVersion: number,
    hues?: Uint8Array,
  ): Buffers {
    const gl = this.gl;
    let entry = this.uploaded.get(key);
    if (!entry) {
      entry = {
        position: gl.createBuffer()!,
        color: gl.createBuffer()!,
        hue: hues ? gl.createBuffer()! : undefined,
        vertexCount: positions.length / 2,
        colorVersion: -1,
      };
      // Positions are uploaded once and never touched again: panning and
      // zooming are transform changes, not geometry changes.
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      this.uploaded.set(key, entry);
    }
    entry.vertexCount = positions.length / 2;

    if (entry.colorVersion !== colorVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
      if (hues && entry.hue) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.hue);
        gl.bufferData(gl.ARRAY_BUFFER, hues, gl.DYNAMIC_DRAW);
      }
      entry.colorVersion = colorVersion;
    }
    return entry;
  }

  invalidate() {
    const gl = this.gl;
    for (const entry of this.uploaded.values()) {
      gl.deleteBuffer(entry.position);
      gl.deleteBuffer(entry.color);
      if (entry.hue) gl.deleteBuffer(entry.hue);
    }
    this.uploaded.clear();
  }

  private setTransform(program: WebGLProgram, view: View) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(program, 'u_center'), view.centerX, view.centerY);
    gl.uniform2f(gl.getUniformLocation(program, 'u_scale'), view.scaleX, view.scaleY);
  }

  private drawFlat(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    mode: number,
    view: View,
    colorVersion: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    const entry = this.buffers(key, positions, colors, colorVersion);

    gl.useProgram(this.flat);
    this.setTransform(this.flat, view);

    const positionLoc = gl.getAttribLocation(this.flat, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const colorLoc = gl.getAttribLocation(this.flat, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(mode, 0, entry.vertexCount);
  }

  private drawPoints(
    positions: Float32Array,
    colors: Uint8Array,
    view: View,
    width: number,
    height: number,
    colorVersion: number,
    pixelRatio: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    const entry = this.buffers('agents', positions, colors, colorVersion);

    gl.useProgram(this.points);
    this.setTransform(this.points, view);
    // Radius is specified in pixels, so agents keep a constant on-screen size
    // no matter how far the view is zoomed in. width/height are the backing
    // store's device pixels, so the CSS radius is scaled by the ratio first.
    const radius = AGENT_RADIUS_CSS_PX * pixelRatio;
    gl.uniform2f(
      gl.getUniformLocation(this.points, 'u_pixelRadius'),
      (radius * 2) / width,
      (radius * 2) / height,
    );

    const cornerLoc = gl.getAttribLocation(this.points, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    const positionLoc = gl.getAttribLocation(this.points, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(positionLoc, 1);

    const colorLoc = gl.getAttribLocation(this.points, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, entry.vertexCount);

    gl.vertexAttribDivisor(positionLoc, 0);
    gl.vertexAttribDivisor(colorLoc, 0);
  }

  private ensureAccumulator(width: number, height: number) {
    const gl = this.gl;
    if (this.accumulator && this.accumulator.width === width && this.accumulator.height === height) {
      return this.accumulator;
    }
    if (this.accumulator) {
      gl.deleteFramebuffer(this.accumulator.framebuffer);
      gl.deleteTexture(this.accumulator.texture);
    }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.accumulator = { framebuffer, texture, width, height };
    return this.accumulator;
  }

  // Desire lines in hue-averaging mode: sum unit vectors into an offscreen
  // float target, then resolve to real colors in one full-screen pass. Two
  // passes rather than plain blending because ordinary alpha blending would
  // either dilute a lone line against the scene beneath it or let whichever
  // line drew last simply win -- neither of which is an average.
  private drawBlendedLines(
    positions: Float32Array,
    hues: Uint8Array,
    colors: Uint8Array,
    view: View,
    width: number,
    height: number,
    colorVersion: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    // A key of its own: this path needs a hue buffer alongside the position
    // buffer, and buffer sets are created once per key on first use.
    const entry = this.buffers('desireLinesBlend', positions, colors, colorVersion, hues);
    const target = this.ensureAccumulator(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.hue);
    this.setTransform(this.hue, view);

    const positionLoc = gl.getAttribLocation(this.hue, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const hueLoc = gl.getAttribLocation(this.hue, 'a_hue');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.hue!);
    gl.enableVertexAttribArray(hueLoc);
    gl.vertexAttribPointer(hueLoc, 1, gl.UNSIGNED_BYTE, false, 0, 0);

    gl.drawArrays(gl.LINES, 0, entry.vertexCount);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_accumulator'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_wheel'), 1);

    const cornerLoc = gl.getAttribLocation(this.resolve, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  render(
    geometries: Geometries,
    view: View,
    paper: RgbColor,
    lineLayer: 'network' | 'desireLines' | null,
    blendDesireLines: boolean,
    colorVersion: number,
    pixelRatio: number,
  ) {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(paper.r / 255, paper.g / 255, paper.b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    // Fixed stacking: zones behind, one line layer over them, agents on top.
    if (geometries.zones) {
      this.drawFlat('zoneFill', geometries.zones.fillPositions, geometries.zones.fillColors, gl.TRIANGLES, view, colorVersion);
      this.drawFlat('zoneBorder', geometries.zones.borderPositions, geometries.zones.borderColors, gl.LINES, view, colorVersion);
    }

    if (lineLayer === 'network' && geometries.network) {
      this.drawFlat('network', geometries.network.positions, geometries.network.colors, gl.LINES, view, colorVersion);
    } else if (lineLayer === 'desireLines' && geometries.desireLines) {
      const lines = geometries.desireLines;
      if (blendDesireLines && this.floatTargetsSupported) {
        this.drawBlendedLines(lines.positions, lines.hues, lines.colors, view, width, height, colorVersion);
      } else {
        this.drawFlat('desireLines', lines.positions, lines.colors, gl.LINES, view, colorVersion);
      }
    }

    if (geometries.agents) {
      this.drawPoints(
        geometries.agents.positions, geometries.agents.colors, view, width, height, colorVersion, pixelRatio,
      );
    }
  }

  dispose() {
    const gl = this.gl;
    this.invalidate();
    gl.deleteBuffer(this.quad);
    gl.deleteTexture(this.wheelTexture);
    if (this.accumulator) {
      gl.deleteFramebuffer(this.accumulator.framebuffer);
      gl.deleteTexture(this.accumulator.texture);
    }
    gl.deleteProgram(this.flat);
    gl.deleteProgram(this.points);
    gl.deleteProgram(this.hue);
    gl.deleteProgram(this.resolve);
  }
}

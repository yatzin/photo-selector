"use client"

import { useEffect, useRef, type CSSProperties } from "react"
import { videoKeyParams, type Rgb } from "@/lib/video/chroma"

// A video clip with its background keyed out, in the player: a WebGL canvas
// that draws the video element's current frame through the same color key
// ffmpeg's colorkey applies in the export (lib/video/chroma videoKeyParams:
// distance from the key color as a fraction of the longest RGB distance, clear
// below `similarity`, fading in over `blend`). The video element itself stays
// (hidden) in the player so it plays and seeks as always. Where WebGL isn't
// there the video stays visible, unkeyed.

const VERTEX = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`
const FRAGMENT = `precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform vec3 key; uniform float sim; uniform float blend;
void main(){ vec4 c = texture2D(tex, uv); float d = length(c.rgb - key) / 1.7320508; float a = clamp((d - sim) / blend, 0.0, 1.0); gl_FragColor = vec4(c.rgb * a, a); }`

export function KeyedVideo({ video, keyColor, tolerance, style, onUnsupported }: {
  video: () => HTMLVideoElement | null
  keyColor: Rgb
  tolerance: number
  style?: CSSProperties
  /** WebGL isn't available: show the plain video. */
  onUnsupported?: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // What the draw loop reads each frame, kept current without restarting it.
  const params = useRef({ keyColor, tolerance })
  const getVideo = useRef(video)
  const unsupported = useRef(onUnsupported)
  useEffect(() => {
    params.current = { keyColor, tolerance }
    getVideo.current = video
    unsupported.current = onUnsupported
  })

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const gl = c.getContext("webgl", { premultipliedAlpha: true, alpha: true })
    if (!gl) {
      unsupported.current?.()
      return
    }
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      unsupported.current?.()
      return
    }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, "p")
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    let raf = 0
    let stopped = false
    const draw = () => {
      if (stopped) return
      const v = getVideo.current()
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
          c.width = v.videoWidth
          c.height = v.videoHeight
        }
        gl.viewport(0, 0, c.width, c.height)
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v)
          const { keyColor: k, tolerance: t } = params.current
          const { similarity, blend } = videoKeyParams(t)
          gl.uniform3f(u("key"), k[0] / 255, k[1] / 255, k[2] / 255)
          gl.uniform1f(u("sim"), similarity)
          gl.uniform1f(u("blend"), blend)
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        } catch {
          // A frame that can't be read this tick: try the next.
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
  }, [])

  return <canvas ref={canvas} aria-hidden className="pointer-events-none absolute" style={style} />
}

import portraitWeights from "./portrait-light-field-weights.json"

// Starts the relightable portrait on the home page and returns a function
// that stops it.
export function mountPortrait(): () => void {
  const canvasElement = document.getElementById("portraitRelight")
  const posterElement = document.getElementById("portraitPoster")
  const fieldElement = document.getElementById("relightField")
  const handleElement = fieldElement?.querySelector(".relight-handle")
  if (
    !(canvasElement instanceof HTMLCanvasElement) ||
    !(posterElement instanceof HTMLImageElement) ||
    !(fieldElement instanceof HTMLElement) ||
    !(handleElement instanceof HTMLButtonElement) ||
    // The basis images are AVIF; without it the poster stays a still image.
    !new URL(posterElement.currentSrc, location.href).pathname.endsWith(".avif")
  )
    return () => {}

  const canvas = canvasElement
  const poster = posterElement
  const field = fieldElement
  const handle = handleElement

  type Point = { x: number; y: number }

  // Light positions are in portrait coordinates (0-1 across the width and
  // height). Measured from the frames: azimuths 1-7 light the face from the
  // viewer's left, 21-27 from the right, and elevation 2 is face level. The
  // light turns fully to the side a quarter portrait width from the face
  // center and moves one elevation step per quarter width vertically.
  const face = { x: 0.479, y: 0.292 }
  const sideReach = 0.25
  const elevationStep = 0.25
  const aspect = 466 / 720
  // Azimuth 6, elevation 2: a side light beside the head at face level.
  const defaultPoint = { x: face.x - (sideReach * 6) / 7, y: face.y }
  const highResolution =
    poster.getBoundingClientRect().width * window.devicePixelRatio > 720
  const tier = highResolution ? "high" : "standard"
  const root = `/relight-field/${tier}`
  const frameWeights: Record<string, number[]> = portraitWeights[tier]
  const components = frameWeights[frameName(0, 0)].length
  const sourceWidth = highResolution ? 1440 : 720
  const sourceHeight = sourceWidth * aspect
  const handleRadius = 19
  let point: Point = { ...defaultPoint }
  let rect: DOMRect
  let gl: WebGLRenderingContext | null = null
  let weightsUniform: WebGLUniformLocation | null = null
  let ready = false
  let dragOffset: Point = { x: 0, y: 0 }
  let raf = 0
  let disposed = false

  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.max(minimum, Math.min(maximum, value))

  function frameName(elevation: number, azimuth: number) {
    return `elev_${String(elevation).padStart(2, "0")}/az_${String(azimuth).padStart(2, "0")}`
  }

  // The requested point kept within the page, so the handle marks the light.
  function lightPoint(): Point {
    return {
      x: clamp(
        point.x,
        (handleRadius - rect.left) / rect.width,
        (innerWidth - handleRadius - rect.left) / rect.width
      ),
      y: clamp(
        point.y,
        (handleRadius - rect.top) / rect.height,
        (innerHeight - handleRadius - rect.top) / rect.height
      ),
    }
  }

  // Bilinear blend of the basis weights of the four frames around the light.
  function lightWeights() {
    const light = lightPoint()
    const right = clamp((light.x - face.x) / sideReach, -1, 1)
    const down = ((light.y - face.y) * aspect) / elevationStep
    const signedAzimuth = -7 * right
    const azimuth = signedAzimuth < 0 ? signedAzimuth + 28 : signedAzimuth
    const elevation = clamp(2 - down, 0, 3)
    const azimuth0 = Math.floor(azimuth) % 28
    const elevation0 = Math.floor(elevation)
    const azimuthWeight = azimuth - Math.floor(azimuth)
    const elevationWeight = elevation - elevation0
    const blended = new Float32Array(components)
    for (const [nextElevation, verticalWeight] of [
      [elevation0, 1 - elevationWeight],
      [Math.min(elevation0 + 1, 3), elevationWeight],
    ]) {
      for (const [nextAzimuth, horizontalWeight] of [
        [azimuth0, 1 - azimuthWeight],
        [(azimuth0 + 1) % 28, azimuthWeight],
      ]) {
        const weight = verticalWeight * horizontalWeight
        if (weight <= 0.0001) continue
        const frame = frameWeights[frameName(nextElevation, nextAzimuth)]
        for (let index = 0; index < blended.length; index += 1)
          blended[index] += frame[index] * weight
      }
    }
    return blended
  }

  function compileShader(
    renderer: WebGLRenderingContext,
    type: number,
    source: string
  ) {
    const shader = renderer.createShader(type)
    if (!shader) throw new Error("Could not create portrait shader")
    renderer.shaderSource(shader, source)
    renderer.compileShader(shader)
    if (!renderer.getShaderParameter(shader, renderer.COMPILE_STATUS)) {
      throw new Error(
        renderer.getShaderInfoLog(shader) || "Portrait shader failed"
      )
    }
    return shader
  }

  function initializeRenderer(renderer: WebGLRenderingContext) {
    if (renderer.getParameter(renderer.MAX_TEXTURE_IMAGE_UNITS) < components + 1)
      throw new Error("Too few texture units for the portrait basis")
    const vertex = compileShader(
      renderer,
      renderer.VERTEX_SHADER,
      `
            attribute vec2 position;
            varying vec2 uv;
            void main() {
                uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
                gl_Position = vec4(position, 0.0, 1.0);
            }
        `
    )
    const fragment = compileShader(
      renderer,
      renderer.FRAGMENT_SHADER,
      `
            precision mediump float;
            uniform sampler2D mean;
            uniform sampler2D basis[${components}];
            uniform float weights[${components}];
            varying vec2 uv;
            void main() {
                vec4 color = texture2D(mean, uv);
                for (int index = 0; index < ${components}; index++) {
                    color.rgb += weights[index] * (texture2D(basis[index], uv).rgb * 2.0 - 1.0);
                }
                // Premultiplied output, which every browser composites the same way.
                gl_FragColor = vec4(clamp(color.rgb, 0.0, 1.0) * color.a, color.a);
            }
        `
    )
    const program = renderer.createProgram()
    if (!program) throw new Error("Could not create portrait shader program")
    renderer.attachShader(program, vertex)
    renderer.attachShader(program, fragment)
    renderer.linkProgram(program)
    renderer.deleteShader(vertex)
    renderer.deleteShader(fragment)
    if (!renderer.getProgramParameter(program, renderer.LINK_STATUS)) {
      throw new Error(
        renderer.getProgramInfoLog(program) || "Portrait shader program failed"
      )
    }

    const buffer = renderer.createBuffer()
    if (!buffer) throw new Error("Could not create portrait vertex buffer")
    renderer.bindBuffer(renderer.ARRAY_BUFFER, buffer)
    renderer.bufferData(
      renderer.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      renderer.STATIC_DRAW
    )
    renderer.useProgram(program)
    const position = renderer.getAttribLocation(program, "position")
    renderer.enableVertexAttribArray(position)
    renderer.vertexAttribPointer(position, 2, renderer.FLOAT, false, 0, 0)
    renderer.uniform1i(renderer.getUniformLocation(program, "mean"), 0)
    renderer.uniform1iv(
      renderer.getUniformLocation(program, "basis"),
      Array.from({ length: components }, (_, index) => index + 1)
    )
    weightsUniform = renderer.getUniformLocation(program, "weights")
    renderer.viewport(0, 0, canvas.width, canvas.height)
  }

  function fail(error: unknown) {
    if (disposed) return
    console.error("Portrait light field unavailable", error)
    field.hidden = true
    canvas.hidden = true
    poster.hidden = false
  }

  function uploadTexture(unit: number, bitmap: ImageBitmap) {
    if (!gl) throw new Error("WebGL rendering is unavailable")
    const texture = gl.createTexture()
    if (!texture) throw new Error("Could not create portrait texture")
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    bitmap.close()
  }

  function loadImage(file: string) {
    return fetch(`${root}/${file}.avif?v=4`)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Portrait basis failed: ${response.status}`)
        return response.blob()
      })
      .then((blob) =>
        createImageBitmap(blob, {
          colorSpaceConversion: "none",
          premultiplyAlpha: "none",
        })
      )
  }

  async function load() {
    const files = [
      "mean",
      ...Array.from(
        { length: components },
        (_, index) => `basis_${String(index).padStart(2, "0")}`
      ),
    ]
    gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      powerPreference: "high-performance",
      stencil: false,
    })
    if (!gl) throw new Error("WebGL rendering is unavailable")
    initializeRenderer(gl)
    await Promise.all(
      files.map((file, unit) =>
        loadImage(file).then((bitmap) => {
          if (disposed) bitmap.close()
          else uploadTexture(unit, bitmap)
        })
      )
    )
    if (disposed) return
    ready = true
    requestRender()
  }

  function positionHandle() {
    const light = lightPoint()
    handle.style.left = `${rect.left + light.x * rect.width}px`
    handle.style.top = `${rect.top + light.y * rect.height}px`
  }

  function render() {
    raf = 0
    if (!gl || !ready || field.hidden) return
    gl.uniform1fv(weightsUniform, lightWeights())
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    canvas.hidden = false
    poster.hidden = true
  }

  function requestRender() {
    if (!raf) raf = requestAnimationFrame(render)
  }

  function updatePoint(nextPoint: Point) {
    point = nextPoint
    positionHandle()
    requestRender()
  }

  function moveLight(clientX: number, clientY: number) {
    updatePoint({
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    })
  }

  field.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    const fromHandle = event.target === handle
    const light = lightPoint()
    dragOffset = fromHandle
      ? {
          x: rect.left + light.x * rect.width - event.clientX,
          y: rect.top + light.y * rect.height - event.clientY,
        }
      : { x: 0, y: 0 }
    field.setPointerCapture(event.pointerId)
    if (fromHandle) handle.focus({ preventScroll: true })
    moveLight(event.clientX + dragOffset.x, event.clientY + dragOffset.y)
    event.preventDefault()
  })
  field.addEventListener("pointermove", (event) => {
    if (!field.hasPointerCapture(event.pointerId)) return
    moveLight(event.clientX + dragOffset.x, event.clientY + dragOffset.y)
  })
  handle.addEventListener("keydown", (event) => {
    const delta = (
      {
        ArrowLeft: [-0.04, 0],
        ArrowRight: [0.04, 0],
        ArrowUp: [0, -0.04],
        ArrowDown: [0, 0.04],
      } as Record<string, [number, number]>
    )[event.key]
    if (!delta) return

    const light = lightPoint()
    updatePoint({ x: light.x + delta[0], y: light.y + delta[1] })
    event.preventDefault()
  })

  function resize() {
    rect = (canvas.hidden ? poster : canvas).getBoundingClientRect()
    const width = Math.min(
      sourceWidth,
      Math.ceil(rect.width * window.devicePixelRatio)
    )
    const height = Math.round((width * sourceHeight) / sourceWidth)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      gl?.viewport(0, 0, width, height)
    }
    positionHandle()
    requestRender()
  }

  window.addEventListener("resize", resize)
  window.visualViewport?.addEventListener("resize", resize)
  field.hidden = false
  resize()
  load().catch(fail)

  return () => {
    disposed = true
    cancelAnimationFrame(raf)
    window.removeEventListener("resize", resize)
    window.visualViewport?.removeEventListener("resize", resize)
    gl?.getExtension("WEBGL_lose_context")?.loseContext()
  }
}

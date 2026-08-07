;(function () {
  const canvasElement = document.getElementById("portraitRelight")
  const posterElement = document.getElementById("portraitPoster")
  const fieldElement = document.getElementById("relightField")
  const handleElement = fieldElement?.querySelector(".relight-handle")
  if (
    !(canvasElement instanceof HTMLCanvasElement) ||
    !(posterElement instanceof HTMLImageElement) ||
    !(fieldElement instanceof HTMLElement) ||
    !(handleElement instanceof HTMLButtonElement)
  )
    return

  const canvas = canvasElement
  const poster = posterElement
  const field = fieldElement
  const handle = handleElement

  type Point = { x: number; y: number }
  type Frame = { file: string; weight: number }
  type Selection = {
    key: string
    frames: Frame[]
    nearest: { azimuth: number; elevation: number }
  }

  const root = "/static/resources/relight-field"
  const defaultPoint = { x: 0.265, y: -0.586 }
  const highResolution =
    poster.getBoundingClientRect().width * window.devicePixelRatio > 720
  const tier = highResolution ? "high" : "standard"
  const sourceWidth = highResolution ? 1440 : 720
  const sourceHeight = (sourceWidth * 466) / 720
  const cacheLimit = highResolution ? 8 : 12
  const loadLimit = 8
  const cache = new Map<string, WebGLTexture>()
  const loads = new Map<string, Promise<WebGLTexture>>()
  const selectionLoads = new Set<string>()
  let point: Point = { ...defaultPoint }
  let rect: DOMRect
  let gl: WebGLRenderingContext | null = null
  let weightsUniform: WebGLUniformLocation | null = null
  let target: Selection | undefined
  let dragging = false
  let raf = 0
  let warmTimer = 0

  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.max(minimum, Math.min(maximum, value))

  function frameFile(elevation: number, azimuth: number) {
    return `elev_${String(elevation).padStart(2, "0")}/az_${String(azimuth).padStart(2, "0")}.webp`
  }

  function frameSelection(): Selection {
    const signedAzimuth = -Math.tanh((point.x - defaultPoint.x) * 3) * 7
    const azimuth = signedAzimuth < 0 ? signedAzimuth + 28 : signedAzimuth
    const elevation = clamp(2 - (point.y - defaultPoint.y) * 2.315, 0, 3)
    const azimuth0 = Math.floor(azimuth) % 28
    const elevation0 = Math.floor(elevation)
    const azimuthWeight = azimuth - Math.floor(azimuth)
    const elevationWeight = elevation - elevation0
    const merged = new Map<string, number>()
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
        const file = frameFile(nextElevation, nextAzimuth)
        merged.set(file, (merged.get(file) || 0) + weight)
      }
    }
    const frames = Array.from(merged, ([file, weight]) => ({ file, weight }))
    return {
      key: frames.map(({ file }) => file).join("|"),
      frames,
      nearest: {
        azimuth: Math.round(azimuth) % 28,
        elevation: Math.round(elevation),
      },
    }
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
            uniform sampler2D frame0;
            uniform sampler2D frame1;
            uniform sampler2D frame2;
            uniform sampler2D frame3;
            uniform vec4 weights;
            varying vec2 uv;
            void main() {
                gl_FragColor = texture2D(frame0, uv) * weights.x
                    + texture2D(frame1, uv) * weights.y
                    + texture2D(frame2, uv) * weights.z
                    + texture2D(frame3, uv) * weights.w;
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
    for (let index = 0; index < 4; index += 1) {
      renderer.uniform1i(
        renderer.getUniformLocation(program, `frame${index}`),
        index
      )
    }
    weightsUniform = renderer.getUniformLocation(program, "weights")
    renderer.viewport(0, 0, canvas.width, canvas.height)
  }

  function fail(error: unknown) {
    console.error("Portrait light field unavailable", error)
    field.hidden = true
    canvas.hidden = true
    poster.hidden = false
  }

  function ensureRenderer() {
    if (gl) return true
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        desynchronized: true,
        powerPreference: "high-performance",
        premultipliedAlpha: false,
        stencil: false,
      })
      if (!gl) throw new Error("WebGL rendering is unavailable")
      initializeRenderer(gl)
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  function uploadTexture(bitmap: ImageBitmap) {
    if (!gl) throw new Error("WebGL rendering is unavailable")
    const texture = gl.createTexture()
    if (!texture) throw new Error("Could not create portrait texture")
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    return texture
  }

  function textureForFrame(file: string): Promise<WebGLTexture> {
    const cached = cache.get(file)
    if (cached) {
      cache.delete(file)
      cache.set(file, cached)
      return Promise.resolve(cached)
    }
    const activeLoad = loads.get(file)
    if (activeLoad) return activeLoad

    const promise = fetch(`${root}/${tier}/${file}?v=3`)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Portrait frame failed: ${response.status}`)
        return response.blob()
      })
      .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "none" }))
      .then((bitmap) => {
        const texture = uploadTexture(bitmap)
        bitmap.close()
        cache.set(file, texture)
        trimCache()
        return texture
      })
      .finally(() => {
        loads.delete(file)
        requestRender()
      })
    loads.set(file, promise)
    return promise
  }

  function trimCache(keep = new Set(target?.frames.map(({ file }) => file))) {
    for (const [file, texture] of cache) {
      if (cache.size <= cacheLimit) break
      if (keep.has(file)) continue
      gl?.deleteTexture(texture)
      cache.delete(file)
    }
  }

  function draw(selection: Selection) {
    if (!gl) return false
    const frames = selection.frames.map(({ file, weight }) => ({
      file,
      weight,
      texture: cache.get(file),
    }))
    if (frames.some(({ texture }) => !texture)) return false

    const weights = new Float32Array(4)
    for (let index = 0; index < 4; index += 1) {
      const frame = frames[index] || frames[0]
      if (!frame.texture) return false
      gl.activeTexture(gl.TEXTURE0 + index)
      gl.bindTexture(gl.TEXTURE_2D, frame.texture)
      weights[index] = frames[index]?.weight || 0
    }
    gl.uniform4fv(weightsUniform, weights)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    canvas.hidden = false
    poster.hidden = true
    trimCache()
    return true
  }

  function loadSelection(selection: Selection) {
    if (selectionLoads.has(selection.key)) return
    const files = new Set(selection.frames.map(({ file }) => file))
    const missing = Array.from(files).filter(
      (file) => !cache.has(file) && !loads.has(file)
    ).length
    if (loads.size + missing > loadLimit) return

    selectionLoads.add(selection.key)
    Promise.all(Array.from(files, textureForFrame))
      .catch(fail)
      .finally(() => selectionLoads.delete(selection.key))
  }

  function scheduleWarmup(selection: Selection) {
    clearTimeout(warmTimer)
    warmTimer = window.setTimeout(() => {
      if (dragging || field.hidden) return
      const { azimuth, elevation } = selection.nearest
      const candidates = [
        [elevation, azimuth],
        [elevation, azimuth - 1],
        [elevation, azimuth + 1],
        [elevation - 1, azimuth],
        [elevation + 1, azimuth],
      ]
      for (const [nextElevation, nextAzimuth] of candidates) {
        const wrappedAzimuth = (nextAzimuth + 28) % 28
        if (
          nextElevation < 0 ||
          nextElevation > 3 ||
          (wrappedAzimuth > 7 && wrappedAzimuth < 21)
        )
          continue
        const file = frameFile(nextElevation, wrappedAzimuth)
        if (cache.has(file) || loads.has(file)) continue
        if (loads.size >= loadLimit) break
        textureForFrame(file).catch(fail)
      }
    }, 250)
  }

  function positionHandle() {
    handle.style.left = `${rect.left + point.x * rect.width}px`
    handle.style.top = `${rect.top + point.y * rect.height}px`
  }

  function render() {
    raf = 0
    if (field.hidden || !ensureRenderer()) return
    positionHandle()
    target = frameSelection()
    if (!draw(target)) loadSelection(target)
  }

  function requestRender() {
    if (!raf) raf = requestAnimationFrame(render)
  }

  function moveLight(clientX: number, clientY: number) {
    point = {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    }
    requestRender()
  }

  field.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !ensureRenderer()) return
    clearTimeout(warmTimer)
    dragging = true
    field.setPointerCapture(event.pointerId)
    if (event.target === handle) handle.focus({ preventScroll: true })
    moveLight(event.clientX, event.clientY)
    event.preventDefault()
  })
  field.addEventListener("pointermove", (event) => {
    if (field.hasPointerCapture(event.pointerId)) {
      moveLight(event.clientX, event.clientY)
    }
  })
  field.addEventListener("lostpointercapture", () => {
    dragging = false
    const selection = frameSelection()
    target = selection
    requestRender()
    scheduleWarmup(selection)
  })
  handle.addEventListener("pointerenter", () => {
    if (!dragging && ensureRenderer()) scheduleWarmup(frameSelection())
  })
  handle.addEventListener("focus", () => {
    if (!dragging && ensureRenderer()) scheduleWarmup(frameSelection())
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
    if (!delta || !ensureRenderer()) return

    const handleRect = handle.getBoundingClientRect()
    moveLight(
      clamp(handleRect.left + 18 + delta[0] * rect.width, 18, innerWidth - 18),
      clamp(handleRect.top + 18 + delta[1] * rect.height, 18, innerHeight - 18)
    )
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
      if (gl && !canvas.hidden) requestRender()
    }
    positionHandle()
  }

  window.addEventListener("resize", resize)
  window.visualViewport?.addEventListener("resize", resize)
  field.hidden = false
  resize()
})()

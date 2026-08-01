(function () {
    const canvas = document.getElementById("portraitRelight");
    const fallback = document.getElementById("portraitFallback");
    const field = document.getElementById("relightField");
    const handle = field ? field.querySelector(".relight-handle") : null;
    if (!canvas || !fallback || !field || !handle) return;

    const fieldRoot = "static/resources/relight-field";
    const bitmapCacheLimit = 6;
    const selectionDelay = 50;
    const keyboardStep = 0.08;
    const defaultHandlePosition = { x: 0.316, y: -0.296 };
    const state = {
        gl: null,
        texture: null,
        blendUniform: null,
        layerUniform: null,
        width: 0,
        height: 0,
        azimuthSlots: 0,
        frontArcSteps: 0,
        elevationCount: 0,
        azimuthResponse: 0,
        elevationResponse: 0,
        defaultLight: null,
        manifest: null,
        version: "",
        fieldPath: "",
        light: null,
        bitmapCache: new Map(),
        bitmapLoads: new Map(),
        bitmapWorker: null,
        bitmapRequests: new Map(),
        nextBitmapRequestId: 0,
        textureFiles: [null, null, null, null],
        pendingSelection: null,
        loadingPromise: null,
        scheduledSelection: null,
        selectionTimer: 0,
        rendererPromise: null,
        rendererReady: false,
        raf: 0,
        ready: false,
        suspended: false,
        canvasRect: null,
        fieldRect: null
    };

    const vertexShader = `#version 300 es
        in vec2 position;
        out vec2 uv;
        void main() {
            uv = position * 0.5 + 0.5;
            gl_Position = vec4(position, 0.0, 1.0);
        }
    `;

    const fragmentShader = `#version 300 es
        precision highp float;
        precision highp sampler2DArray;
        uniform sampler2DArray fieldTex;
        uniform vec2 blendWeights;
        uniform ivec4 fieldLayers;
        in vec2 uv;
        out vec4 outColor;

        vec3 linearToSrgb(vec3 color) {
            vec3 positive = max(color, vec3(0.0));
            return mix(
                positive * 12.92,
                1.055 * pow(positive, vec3(1.0 / 2.4)) - 0.055,
                step(vec3(0.0031308), positive)
            );
        }

        vec4 sampleField() {
            vec2 sampleUv = vec2(uv.x, 1.0 - uv.y);
            vec4 lower = mix(
                texture(fieldTex, vec3(sampleUv, float(fieldLayers.x))),
                texture(fieldTex, vec3(sampleUv, float(fieldLayers.y))),
                blendWeights.x
            );
            vec4 upper = mix(
                texture(fieldTex, vec3(sampleUv, float(fieldLayers.z))),
                texture(fieldTex, vec3(sampleUv, float(fieldLayers.w))),
                blendWeights.x
            );
            return mix(lower, upper, blendWeights.y);
        }

        void main() {
            vec4 base = sampleField();
            outColor = vec4(linearToSrgb(base.rgb), base.a);
        }
    `;

    function compile(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(message);
        }
        return shader;
    }

    function createProgram(gl) {
        const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader);
        const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentShader);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
        const message = gl.getProgramInfoLog(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!linked) {
            gl.deleteProgram(program);
            throw new Error(message);
        }
        return program;
    }

    function createBitmapWorker() {
        const worker = new Worker("static/scripts/portrait-frame-worker.js?v=1");
        worker.addEventListener("message", (event) => {
            const { id, bitmap, error } = event.data;
            const request = state.bitmapRequests.get(id);
            if (!request) {
                bitmap?.close();
                return;
            }
            state.bitmapRequests.delete(id);
            request.cleanup();
            if (error) request.reject(new Error(error));
            else request.resolve(bitmap);
        });
        worker.addEventListener("error", (event) => {
            const error = event.error || new Error(event.message);
            for (const request of state.bitmapRequests.values()) {
                request.cleanup();
                request.reject(error);
            }
            state.bitmapRequests.clear();
        });
        return worker;
    }

    function loadBitmap(path, version, signal) {
        const id = ++state.nextBitmapRequestId;
        return new Promise((resolve, reject) => {
            const abort = () => {
                state.bitmapRequests.delete(id);
                state.bitmapWorker.postMessage({ id, cancel: true });
                reject(new DOMException("Portrait light-field load canceled", "AbortError"));
            };
            const cleanup = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            state.bitmapRequests.set(id, { resolve, reject, cleanup });
            state.bitmapWorker.postMessage({
                id,
                url: new URL(`${path}?v=${version}`, document.baseURI).href
            });
        });
    }

    function createFieldTexture(gl, width, height) {
        if (gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) < 4) {
            throw new Error("This browser cannot hold the portrait light field");
        }

        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage3D(
            gl.TEXTURE_2D_ARRAY,
            1,
            gl.SRGB8_ALPHA8,
            width,
            height,
            4
        );
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Could not allocate the portrait light field");
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        return texture;
    }

    function bitmapForFrame(file) {
        const cached = state.bitmapCache.get(file);
        if (cached) {
            state.bitmapCache.delete(file);
            state.bitmapCache.set(file, cached);
            return Promise.resolve(cached);
        }
        const activeLoad = state.bitmapLoads.get(file);
        if (activeLoad) return activeLoad.promise;

        const path = `${state.fieldPath}/${file}`;
        const controller = new AbortController();
        const load = { controller, promise: null };
        load.promise = loadBitmap(path, state.version, controller.signal).then(
            (bitmap) => {
                if (state.bitmapLoads.get(file) === load) state.bitmapLoads.delete(file);
                if (!state.ready || state.suspended) {
                    bitmap.close();
                    throw new DOMException("Portrait light-field load canceled", "AbortError");
                }
                state.bitmapCache.set(file, bitmap);
                return bitmap;
            },
            (error) => {
                if (state.bitmapLoads.get(file) === load) state.bitmapLoads.delete(file);
                throw error;
            }
        );
        state.bitmapLoads.set(file, load);
        return load.promise;
    }

    function trimBitmapCache(visibleFiles) {
        const visible = new Set(visibleFiles);
        for (const [file, bitmap] of state.bitmapCache) {
            if (state.bitmapCache.size <= bitmapCacheLimit) break;
            if (visible.has(file)) continue;
            bitmap.close();
            state.bitmapCache.delete(file);
        }
    }

    function lightCoordinates() {
        const lightY = Math.max(-1, Math.min(1, state.light.y));
        const maximumAzimuth = state.frontArcSteps / state.azimuthSlots * 360;
        const signedAzimuth = -Math.tanh(state.light.x * state.azimuthResponse)
            * maximumAzimuth;
        const azimuth = signedAzimuth < 0 ? signedAzimuth + 360 : signedAzimuth;
        const elevation = Math.min(
            state.elevationCount - 1,
            Math.log1p(Math.exp(state.elevationResponse * (2 * lightY + 1)))
                / state.elevationResponse
        );
        return {
            azimuth: azimuth / 360 * state.azimuthSlots,
            elevation
        };
    }

    function frameFile(elevation, azimuth) {
        return `elev_${String(elevation).padStart(2, "0")}/az_${String(azimuth).padStart(2, "0")}.webp`;
    }

    function frameSelection() {
        const coordinates = lightCoordinates();
        const azimuth0 = Math.floor(coordinates.azimuth) % state.azimuthSlots;
        const azimuth1 = azimuth0 === state.frontArcSteps
            ? azimuth0
            : (azimuth0 + 1) % state.azimuthSlots;
        const elevation0 = Math.floor(coordinates.elevation);
        const elevation1 = Math.min(elevation0 + 1, state.elevationCount - 1);
        const files = [
            frameFile(elevation0, azimuth0),
            frameFile(elevation0, azimuth1),
            frameFile(elevation1, azimuth0),
            frameFile(elevation1, azimuth1)
        ];
        return {
            files,
            key: files.join("|"),
            azimuthWeight: azimuth0 === azimuth1
                ? 0
                : coordinates.azimuth - Math.floor(coordinates.azimuth),
            elevationWeight: coordinates.elevation - elevation0
        };
    }

    function drawSelection(selection) {
        const { gl } = state;
        gl.uniform4iv(state.layerUniform, selection.layers);
        gl.uniform2f(
            state.blendUniform,
            selection.azimuthWeight,
            selection.elevationWeight
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    async function processSelectionQueue() {
        while (state.pendingSelection) {
            let selection = state.pendingSelection;
            state.pendingSelection = null;
            let layers = selection.files.map((file) => state.textureFiles.indexOf(file));
            if (layers.every((layer) => layer >= 0)) {
                selection.layers = layers;
                drawSelection(selection);
                trimBitmapCache(selection.files);
                continue;
            }

            let bitmaps;
            try {
                bitmaps = await Promise.all(selection.files.map((file, index) => (
                    layers[index] >= 0 ? null : bitmapForFrame(file)
                )));
            } catch (error) {
                if (error.name === "AbortError") {
                    if (!state.ready || state.suspended) return;
                    if (state.pendingSelection) continue;
                }
                throw error;
            }
            if (state.pendingSelection?.key === selection.key) {
                selection = state.pendingSelection;
                state.pendingSelection = null;
            } else if (state.pendingSelection) {
                trimBitmapCache(state.pendingSelection.files);
                continue;
            }

            const { gl } = state;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.texture);
            const visibleFiles = new Set(selection.files);
            const availableLayers = state.textureFiles
                .map((file, index) => visibleFiles.has(file) ? -1 : index)
                .filter((index) => index >= 0);
            layers = selection.files.map((file, index) => {
                const residentLayer = state.textureFiles.indexOf(file);
                if (residentLayer >= 0) return residentLayer;

                const layer = availableLayers.shift();
                const bitmap = bitmaps[index];
                if (layer === undefined || !bitmap) {
                    throw new Error("Could not assign the portrait light-field texture");
                }
                if (bitmap.width !== state.width || bitmap.height !== state.height) {
                    throw new Error(`Unexpected light-field frame size: ${bitmap.width}x${bitmap.height}`);
                }
                gl.texSubImage3D(
                    gl.TEXTURE_2D_ARRAY,
                    0,
                    0,
                    0,
                    layer,
                    state.width,
                    state.height,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    bitmap
                );
                state.textureFiles[layer] = file;
                return layer;
            });
            if (gl.getError() !== gl.NO_ERROR) {
                throw new Error("Could not upload the portrait light-field frames");
            }
            selection.layers = layers;
            drawSelection(selection);
            trimBitmapCache(selection.files);
        }
    }

    function requestSelection(selection) {
        if (state.suspended) return Promise.resolve();
        state.pendingSelection = selection;
        const neededFiles = new Set(selection.files);
        for (const [file, load] of state.bitmapLoads) {
            if (!neededFiles.has(file)) load.controller.abort();
        }
        if (!state.loadingPromise) {
            state.loadingPromise = processSelectionQueue().finally(() => {
                state.loadingPromise = null;
            });
        }
        return state.loadingPromise;
    }

    function flushScheduledSelection() {
        clearTimeout(state.selectionTimer);
        state.selectionTimer = 0;
        const selection = state.scheduledSelection;
        state.scheduledSelection = null;
        if (selection) requestSelection(selection).catch(showFallback);
    }

    function scheduleSelection(selection) {
        if (selection.files.every((file) => state.textureFiles.includes(file))) {
            state.scheduledSelection = null;
            clearTimeout(state.selectionTimer);
            state.selectionTimer = 0;
            requestSelection(selection).catch(showFallback);
            return;
        }
        state.scheduledSelection = selection;
        clearTimeout(state.selectionTimer);
        state.selectionTimer = setTimeout(flushScheduledSelection, selectionDelay);
    }

    function cancelBitmapLoads() {
        clearTimeout(state.selectionTimer);
        state.selectionTimer = 0;
        state.scheduledSelection = null;
        state.pendingSelection = null;
        for (const load of state.bitmapLoads.values()) load.controller.abort();
        state.bitmapLoads.clear();
    }

    function clearBitmapCache() {
        for (const bitmap of state.bitmapCache.values()) bitmap.close();
        state.bitmapCache.clear();
    }

    function showFallback(error) {
        console.error("Portrait light field unavailable", error);
        state.ready = false;
        state.rendererReady = false;
        cancelBitmapLoads();
        clearBitmapCache();
        state.bitmapWorker?.terminate();
        state.bitmapWorker = null;
        canvas.hidden = true;
        field.hidden = true;
        fallback.hidden = false;
    }

    function configureTier() {
        const tierName = fallback.currentSrc.includes("/high/") ? "high" : "standard";
        const tier = state.manifest.tiers[tierName];
        state.fieldPath = `${fieldRoot}/${tierName}`;
        state.width = tier.source_size[0];
        state.height = tier.source_size[1];
        state.version = tier.version;
        canvas.width = state.width;
        canvas.height = state.height;
    }

    function prepareRenderer() {
        if (state.rendererPromise) return state.rendererPromise;
        state.rendererPromise = (async () => {
            configureTier();
            const gl = canvas.getContext("webgl2", {
                alpha: true,
                antialias: false,
                depth: false,
                desynchronized: true,
                premultipliedAlpha: false,
                preserveDrawingBuffer: false
            });
            if (!gl) throw new Error("WebGL2 is unavailable");

            state.gl = gl;
            gl.viewport(0, 0, state.width, state.height);
            state.bitmapWorker = createBitmapWorker();
            const program = createProgram(gl);
            gl.useProgram(program);

            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
                gl.STATIC_DRAW
            );
            const position = gl.getAttribLocation(program, "position");
            gl.enableVertexAttribArray(position);
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

            state.texture = createFieldTexture(gl, state.width, state.height);
            gl.uniform1i(gl.getUniformLocation(program, "fieldTex"), 0);
            state.blendUniform = gl.getUniformLocation(program, "blendWeights");
            state.layerUniform = gl.getUniformLocation(program, "fieldLayers");
            state.rendererReady = true;
            await requestSelection(frameSelection());
            if (!state.suspended) activateCanvas();
        })().catch(showFallback);
        return state.rendererPromise;
    }

    function render() {
        state.raf = 0;
        if (!state.ready) return;
        positionHandle();
        if (!state.rendererReady) {
            prepareRenderer();
            return;
        }
        scheduleSelection(frameSelection());
    }

    function requestRender() {
        if (!state.raf) state.raf = requestAnimationFrame(render);
    }

    function pointToLight(clientX, clientY) {
        const rect = state.canvasRect;
        const portraitX = (clientX - rect.left) / rect.width;
        const portraitY = (clientY - rect.top) / rect.height;
        return {
            x: state.defaultLight.x + 2 * (portraitX - defaultHandlePosition.x),
            y: state.defaultLight.y - 2 * (portraitY - defaultHandlePosition.y)
        };
    }

    function positionHandle() {
        if (!state.ready) return;
        const { canvasRect, fieldRect } = state;
        const portraitX = defaultHandlePosition.x
            + (state.light.x - state.defaultLight.x) * 0.5;
        const portraitY = defaultHandlePosition.y
            - (state.light.y - state.defaultLight.y) * 0.5;
        handle.style.left = `${canvasRect.left - fieldRect.left + portraitX * canvasRect.width}px`;
        handle.style.top = `${canvasRect.top - fieldRect.top + portraitY * canvasRect.height}px`;
    }

    function updateLightFromPointer(event) {
        state.light = pointToLight(event.clientX, event.clientY);
        requestRender();
    }

    function measureLayout() {
        state.canvasRect = (canvas.hidden ? fallback : canvas).getBoundingClientRect();
        state.fieldRect = field.getBoundingClientRect();
    }

    function activateCanvas() {
        if (!canvas.hidden) return;
        canvas.hidden = false;
        fallback.hidden = true;
    }

    field.addEventListener("pointerdown", (event) => {
        if (!state.ready || event.button !== 0) return;
        field.setPointerCapture(event.pointerId);
        if (event.target === handle) handle.focus({ preventScroll: true });
        updateLightFromPointer(event);
        event.preventDefault();
    });
    handle.addEventListener("pointerenter", () => {
        if (state.ready) prepareRenderer();
    });
    handle.addEventListener("focus", () => {
        if (state.ready) prepareRenderer();
    });
    field.addEventListener("pointermove", (event) => {
        if (!field.hasPointerCapture(event.pointerId)) return;
        updateLightFromPointer(event);
    });
    field.addEventListener("lostpointercapture", flushScheduledSelection);
    handle.addEventListener("keydown", (event) => {
        const delta = {
            ArrowLeft: [-keyboardStep, 0],
            ArrowRight: [keyboardStep, 0],
            ArrowUp: [0, keyboardStep],
            ArrowDown: [0, -keyboardStep]
        }[event.key];
        if (!delta) return;
        const { canvasRect, fieldRect } = state;
        const handleRect = handle.getBoundingClientRect();
        const nextX = Math.max(
            fieldRect.left + handleRect.width * 0.5,
            Math.min(
                fieldRect.right - handleRect.width * 0.5,
                handleRect.left + handleRect.width * 0.5
                    + delta[0] * canvasRect.width * 0.5
            )
        );
        const nextY = Math.max(
            fieldRect.top + handleRect.height * 0.5,
            Math.min(
                fieldRect.bottom - handleRect.height * 0.5,
                handleRect.top + handleRect.height * 0.5
                    - delta[1] * canvasRect.height * 0.5
            )
        );
        state.light = pointToLight(nextX, nextY);
        requestRender();
        event.preventDefault();
    });
    function handleResize() {
        measureLayout();
        positionHandle();
    }

    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    window.addEventListener("pagehide", () => {
        state.suspended = true;
        cancelBitmapLoads();
        clearBitmapCache();
    });
    window.addEventListener("pageshow", () => {
        state.suspended = false;
        if (state.ready && state.rendererReady) {
            requestSelection(frameSelection()).then(activateCanvas).catch(showFallback);
        }
    });
    canvas.addEventListener("webglcontextlost", () => {
        showFallback(new Error("WebGL context was lost"));
    });

    async function init() {
        const response = await fetch(`${fieldRoot}/manifest.json`, {
            cache: "no-cache"
        });
        if (!response.ok) throw new Error("Portrait light-field manifest is unavailable");
        const manifest = await response.json();

        state.manifest = manifest;
        state.azimuthSlots = manifest.azimuth_slots;
        state.frontArcSteps = manifest.front_arc_steps;
        state.elevationCount = manifest.elevations_deg.length;
        state.azimuthResponse = manifest.azimuth_response;
        state.elevationResponse = manifest.elevation_response;
        state.defaultLight = {
            x: manifest.default_light[0],
            y: manifest.default_light[1]
        };
        state.light = { ...state.defaultLight };
        state.ready = true;
        field.hidden = false;
        measureLayout();
        positionHandle();
    }

    init().catch(showFallback);
}());

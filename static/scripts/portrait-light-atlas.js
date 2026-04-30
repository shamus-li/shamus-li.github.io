(function () {
    const canvas = document.getElementById("portraitRelight");
    const fallback = document.getElementById("portraitFallback");
    const field = document.getElementById("relightField");
    const handle = field ? field.querySelector(".relight-handle") : null;
    if (!canvas || !fallback || !field || !handle) return;

    const paths = {
        metadata: "static/resources/relight-atlas/shamus-relight-maps.json"
    };
    const assetVersion = "full-subject-distance-v2";

    const state = {
        gl: null,
        program: null,
        uniforms: {},
        width: 0,
        height: 0,
        light: { x: 0, y: 0, u: 0.5, v: 0.5, intensity: 0.8 },
        sourceLight: [0, 0, 1],
        raf: 0,
        ready: false,
        dragging: false
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
        uniform sampler2D neutralTex;
        uniform sampler2D normalMaskTex;
        uniform sampler2D detailTex;
        uniform vec2 lightDirection;
        uniform vec2 lightImagePosition;
        uniform float lightIntensity;
        uniform vec3 sourceLightDirection;
        in vec2 uv;
        out vec4 outColor;

        void main() {
            vec4 neutral = texture(neutralTex, uv);
            vec4 normalMask = texture(normalMaskTex, uv);
            vec3 normal = normalize(normalMask.rgb * 2.0 - 1.0);
            vec3 detail = pow(max(texture(detailTex, uv).rgb, vec3(0.001)), vec3(0.42));
            float relightMask = smoothstep(0.03, 0.78, normalMask.a);
            float surfaceDistance = length((uv - lightImagePosition) * vec2(1.0, 0.72));
            float localFalloff = 1.08 / (1.0 + pow(surfaceDistance * 2.15, 2.0));
            float localLight = clamp(lightIntensity * (0.34 + 0.72 * localFalloff), 0.08, 1.0);

            float z = sqrt(max(0.18, 1.0 - dot(lightDirection, lightDirection) * 0.44));
            vec3 targetLight = normalize(vec3(lightDirection.x * 0.86, lightDirection.y * 0.78, z));
            vec3 sourceLight = normalize(sourceLightDirection);

            float targetDot = dot(normal, targetLight);
            float sourceDot = dot(normal, sourceLight);
            float targetDiffuse = max(0.0, targetDot);
            float targetWrap = max(0.0, (targetDot + 0.42) / 1.42);
            float sourceShade = 0.52 + 0.50 * pow(max(0.0, sourceDot), 0.82);
            float targetShade = 0.58 + localLight * (
                0.38 * pow(targetDiffuse, 0.82) + 0.10 * pow(targetWrap, 1.65)
            );
            targetShade += lightIntensity * 0.12 * pow(localFalloff, 1.35);
            float compensatedShade = mix(targetShade, targetShade / max(sourceShade, 0.66), 0.26);
            compensatedShade = clamp(compensatedShade, 0.78, 1.18);

            vec3 halfVector = normalize(targetLight + vec3(0.0, 0.0, 1.0));
            float specular = pow(max(0.0, dot(normal, halfVector)), 64.0) * 0.055 * localLight;
            float cheekSculpt = clamp(
                1.0 + (normal.x * lightDirection.x + normal.y * lightDirection.y) * 0.11 * localLight,
                0.86,
                1.14
            );
            vec3 warmKey = vec3(1.01 + lightDirection.y * 0.016, 1.0, 0.985 - lightDirection.y * 0.018);
            vec3 relit = neutral.rgb * compensatedShade * cheekSculpt * warmKey * detail;
            relit += specular * vec3(1.0, 0.93, 0.84);

            float blend = relightMask * mix(0.18, 0.82, localLight);
            vec3 color = mix(neutral.rgb, relit, blend);
            outColor = vec4(clamp(color, 0.0, 1.0), neutral.a);
        }
    `;

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = src;
        });
    }

    function compile(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    function createProgram(gl) {
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexShader));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentShader));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program));
        }
        return program;
    }

    function createTexture(gl, image, unit) {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }

    function pointToLight(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const centerX = rect.left + rect.width * 0.5;
        const centerY = rect.top + rect.height * 0.42;
        const radius = Math.max(rect.width, rect.height) * 0.58;
        const dx = clientX - centerX;
        const dy = centerY - clientY;
        const distance = Math.hypot(dx, dy);
        const normalizedDistance = distance / Math.max(1, radius);
        const intensity = Math.max(0.18, Math.min(1, 1.08 / (1 + Math.pow(normalizedDistance, 1.85))));
        return {
            x: Math.max(-1, Math.min(1, dx / radius)),
            y: Math.max(-1, Math.min(1, dy / radius)),
            u: (clientX - rect.left) / rect.width,
            v: 1 - (clientY - rect.top) / rect.height,
            intensity,
            screenX: clientX,
            screenY: clientY
        };
    }

    function positionHandle() {
        if (Number.isFinite(state.light.screenX) && Number.isFinite(state.light.screenY)) {
            handle.style.left = `${state.light.screenX}px`;
            handle.style.top = `${state.light.screenY}px`;
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const radius = Math.max(rect.width, rect.height) * 0.58;
        const centerX = rect.left + rect.width * 0.5;
        const centerY = rect.top + rect.height * 0.42;
        handle.style.left = `${centerX + state.light.x * radius}px`;
        handle.style.top = `${centerY - state.light.y * radius}px`;
    }

    function render() {
        state.raf = 0;
        if (!state.ready) return;
        const { gl } = state;
        gl.viewport(0, 0, state.width, state.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(state.uniforms.lightDirection, state.light.x, state.light.y);
        gl.uniform2f(state.uniforms.lightImagePosition, state.light.u, state.light.v);
        gl.uniform1f(state.uniforms.lightIntensity, state.light.intensity);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function requestRender() {
        if (!state.raf) state.raf = requestAnimationFrame(render);
    }

    handle.addEventListener("pointerdown", (event) => {
        state.dragging = true;
        handle.setPointerCapture(event.pointerId);
        state.light = pointToLight(event.clientX, event.clientY);
        positionHandle();
        requestRender();
        event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
        if (!state.dragging) return;
        state.light = pointToLight(event.clientX, event.clientY);
        positionHandle();
        requestRender();
    });

    handle.addEventListener("pointerup", () => {
        state.dragging = false;
    });

    handle.addEventListener("pointercancel", () => {
        state.dragging = false;
    });

    window.addEventListener("resize", positionHandle);

    async function init() {
        const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
        if (!gl) return;

        const metadata = await fetch(`${paths.metadata}?v=${assetVersion}`).then((response) => response.json());
        const version = metadata.version || assetVersion;
        const [neutral, normalMask, detail] = await Promise.all([
            loadImage(`static/resources/relight-atlas/${metadata.neutral}?v=${version}`),
            loadImage(`static/resources/relight-atlas/${metadata.normalMask}?v=${version}`),
            loadImage(`static/resources/relight-atlas/${metadata.detail}?v=${version}`)
        ]);

        state.gl = gl;
        state.width = metadata.width;
        state.height = metadata.height;
        state.light = { ...state.light, ...(metadata.initialLight || {}) };
        state.light.u = 0.5 + state.light.x * 0.48;
        state.light.v = 0.5 + state.light.y * 0.48;
        state.sourceLight = metadata.sourceLight ? metadata.sourceLight.direction : state.sourceLight;
        canvas.width = state.width;
        canvas.height = state.height;

        const program = createProgram(gl);
        state.program = program;
        gl.useProgram(program);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

        createTexture(gl, neutral, 0);
        createTexture(gl, normalMask, 1);
        createTexture(gl, detail, 2);
        gl.uniform1i(gl.getUniformLocation(program, "neutralTex"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "normalMaskTex"), 1);
        gl.uniform1i(gl.getUniformLocation(program, "detailTex"), 2);
        state.uniforms.lightDirection = gl.getUniformLocation(program, "lightDirection");
        state.uniforms.lightImagePosition = gl.getUniformLocation(program, "lightImagePosition");
        state.uniforms.lightIntensity = gl.getUniformLocation(program, "lightIntensity");
        gl.uniform3f(
            gl.getUniformLocation(program, "sourceLightDirection"),
            state.sourceLight[0],
            state.sourceLight[1],
            state.sourceLight[2]
        );

        state.ready = true;
        canvas.hidden = false;
        fallback.classList.add("relight-fallback-hidden");
        field.hidden = false;
        positionHandle();
        render();
    }

    init().catch((error) => {
        console.warn("Portrait relight maps unavailable", error);
        canvas.hidden = true;
        fallback.classList.remove("relight-fallback-hidden");
        field.hidden = true;
    });
}());

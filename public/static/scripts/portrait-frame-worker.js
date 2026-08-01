const loads = new Map();

self.addEventListener("message", async (event) => {
    const { id, url, cancel } = event.data;
    if (cancel) {
        loads.get(id)?.abort();
        return;
    }

    const controller = new AbortController();
    loads.set(id, controller);
    try {
        const response = await fetch(url, {
            cache: "force-cache",
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Could not load ${url}`);
        const bitmap = await createImageBitmap(await response.blob(), {
            premultiplyAlpha: "none"
        });
        self.postMessage({ id, bitmap }, [bitmap]);
    } catch (error) {
        if (error.name !== "AbortError") self.postMessage({ id, error: error.message });
    } finally {
        loads.delete(id);
    }
});

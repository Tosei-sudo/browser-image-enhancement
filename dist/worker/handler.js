/**
 * Worker-side message handling, kept free of worker globals so it can be tested directly.
 */
import { compile, isMonochrome, processPixels, resolveMode } from '../core/process.js';
export function createWorkerHandler(post) {
    const held = new Map();
    // Strips of one image arrive with the same ops; reuse the compiled tables.
    let cacheKey = '';
    let cached = null;
    function program(ops, mode) {
        const key = mode + JSON.stringify(ops);
        if (key !== cacheKey || !cached) {
            cached = compile(ops, mode);
            cacheKey = key;
        }
        return cached;
    }
    function finish(id, buffer, ops, mode) {
        const pixels = new Uint8ClampedArray(buffer);
        processPixels(pixels, pixels, program(ops, mode));
        post({ type: 'done', id, buffer, mode }, [buffer]);
    }
    return (request) => {
        const id = request.id;
        try {
            switch (request.type) {
                case 'run':
                    finish(id, request.buffer, request.ops, resolveMode(new Uint8ClampedArray(request.buffer), request.colorMode));
                    break;
                case 'detect':
                    held.set(id, request.buffer);
                    post({ type: 'detected', id, mono: isMonochrome(new Uint8ClampedArray(request.buffer)) });
                    break;
                case 'process': {
                    const buffer = held.get(id);
                    if (!buffer)
                        throw new Error(`No strip held for job ${id}.`);
                    held.delete(id);
                    finish(id, buffer, request.ops, request.mode);
                    break;
                }
                case 'release':
                    held.delete(id);
                    break;
            }
        }
        catch (e) {
            post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
        }
    };
}
//# sourceMappingURL=handler.js.map
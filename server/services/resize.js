/**
 * Every resize in the application, done in one place and off the main thread.
 *
 * One worker, one job at a time, on purpose. Decoding a 9MB phone photograph costs jimp around
 * 590MB of resident memory on this server — measured there — so two at once is a gigabyte and a
 * killed process. Serialising costs a queue; not serialising cost an outage.
 *
 * The worker is started on first use and kept, because starting one is slower than most of the
 * jobs it will be given.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'image-worker.js');
// Beyond this, something is wrong — a page asking for five hundred thumbnails at once, say — and
// the honest answer is to stop queueing and let the caller fall back to the original.
const MAX_QUEUED = 120;

let worker = null;
let queued = 0;
let seq = 0;
const waiting = new Map();

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER);
    worker.on('message', (msg) => {
        if (msg.fatal) { console.error('resizer:', msg.fatal); return; }
        const pending = waiting.get(msg.id);
        if (!pending) return;
        waiting.delete(msg.id);
        queued--;
        if (!queued && worker) worker.unref();
        if (msg.ok) pending.resolve(msg.buffer ? Buffer.from(msg.buffer) : true);
        else pending.reject(new Error(msg.error || 'resize failed'));
    });
    // A worker that dies takes its jobs with it; the callers are told so they can fall back,
    // and the next request starts a fresh one.
    worker.on('error', (err) => {
        console.error('resizer crashed:', err.message);
        for (const [, p] of waiting) p.reject(err);
        waiting.clear(); queued = 0; worker = null;
    });
    worker.on('exit', () => { worker = null; });
    // Idle, the resizer must not hold the process open; working, it must not be abandoned
    // half-way. So it is referenced only while there are jobs in flight.
    worker.unref();
    return worker;
}

/** Queue a job. Resolves to true for a file job, or to a Buffer when no `out` was given. */
function run(job) {
    if (queued >= MAX_QUEUED) return Promise.reject(new Error('too many resizes queued'));
    const w = ensureWorker();
    const id = ++seq;
    if (!queued) w.ref();
    queued++;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        w.postMessage({ ...job, id });
    });
}

/** Resize to a width and write it where it is wanted. */
const toFile = (file, width, out, quality = 72) => run({ file, width, out, quality });

/** Resize so the longest side is at most `fit`, and hand back the JPEG. */
const toBuffer = (file, fit, quality = 82) => run({ file, fit, quality });

module.exports = { toFile, toBuffer, get queued() { return queued; } };

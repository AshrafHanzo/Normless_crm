/**
 * Every resize in the application, done in one place and off the main thread.
 *
 * One worker, one job at a time, on purpose. Decoding a 9MB phone photograph costs jimp around
 * 590MB of resident memory on this server — measured there — so two at once is a gigabyte and a
 * killed process. Serialising costs a queue; not serialising cost an outage.
 *
 * The queue is kept here, not in the worker, so it can be ordered: a picture somebody is looking
 * at right now goes ahead of the background work that renders thumbnails before anyone asks.
 * Each job takes about six seconds on this server, so a viewer stuck behind a backlog was a
 * preview that stayed blank for minutes.
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
let seq = 0;
let busy = null;                        // the job the worker has now
const queues = { now: [], later: [] };  // waiting: someone is looking / background

const queued = () => queues.now.length + queues.later.length + (busy ? 1 : 0);

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER);
    worker.on('message', (msg) => {
        if (msg.fatal) { console.error('resizer:', msg.fatal); return; }
        if (!busy || busy.id !== msg.id) return;
        const job = busy;
        busy = null;
        if (msg.ok) job.resolve(msg.buffer ? Buffer.from(msg.buffer) : true);
        else job.reject(new Error(msg.error || 'resize failed'));
        next();
    });
    // A worker that dies takes its job with it; the caller is told so it can fall back, and the
    // next job starts a fresh worker.
    worker.on('error', (err) => {
        console.error('resizer crashed:', err.message);
        if (busy) busy.reject(err);
        busy = null; worker = null;
        next();
    });
    worker.on('exit', () => { worker = null; });
    worker.unref();
    return worker;
}

/** Hand the worker its next job: anything someone is waiting for first. */
function next() {
    if (busy) return;
    const job = queues.now.shift() || queues.later.shift();
    if (!job) { if (worker) worker.unref(); return; }
    const w = ensureWorker();
    // Idle, the resizer must not hold the process open; working, it must not be abandoned.
    w.ref();
    busy = job;
    w.postMessage(job.payload);
}

/** Queue a job. Resolves to true for a file job, or to a Buffer when no output file was given. */
function run(payload, { background = false } = {}) {
    if (queued() >= MAX_QUEUED) return Promise.reject(new Error('too many resizes queued'));
    return new Promise((resolve, reject) => {
        const id = ++seq;
        (background ? queues.later : queues.now).push({ id, payload: { ...payload, id }, resolve, reject });
        next();
    });
}

/** Resize to a width and write it where it is wanted. */
const toFile = (file, width, out, quality = 72) => run({ file, width, out, quality });

/** Several widths from one decode: [{ width, out }]. */
const toFiles = (file, outs, { background = false, quality = 72 } = {}) => run({ file, outs, quality }, { background });

/** Resize so the longest side is at most `fit`, and hand back the JPEG. */
const toBuffer = (file, fit, quality = 82) => run({ file, fit, quality });

module.exports = {
    toFile, toFiles, toBuffer,
    get queued() { return queued(); },
    get waiting() { return queues.now.length + (busy ? 1 : 0); },
};

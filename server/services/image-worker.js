/**
 * The thread that does the pixel work.
 *
 * jimp is pure JavaScript — this CPU cannot run a native image library — so a single resize is
 * one or two seconds of solid arithmetic. Done on the main thread that is also answering the API,
 * it blocks everything: a cached 46KB thumbnail took six seconds to serve while a few photographs
 * were being rendered beside it, which is what "the page keeps loading" actually was.
 *
 * So it happens here instead, one job at a time, where the only thing it can hold up is the next
 * resize.
 */

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

let Jimp;
try {
    Jimp = require('jimp');
} catch (err) {
    parentPort.postMessage({ fatal: `the resizer could not be loaded: ${err.message}` });
}

parentPort.on('message', async (job) => {
    const reply = (msg) => parentPort.postMessage({ id: job.id, ...msg });
    try {
        if (!Jimp) throw new Error('no resizer');
        const img = await Jimp.read(job.file);

        // Several sizes from one decode. Decoding a phone photo is nearly all of the cost — six
        // seconds on this server — and the list, the gallery and the viewer each want their own
        // size of the same picture. Largest first, each smaller one scaled from the one before.
        if (job.outs) {
            let current = img;
            for (const { width, out } of [...job.outs].sort((a, b) => b.width - a.width)) {
                if (current.getWidth() > width) current = current.clone().scaleToFit(width, Jimp.AUTO);
                current.quality(job.quality || 72);
                // Ends in .jpg so jimp writes a JPEG whatever the original was.
                const tmp = `${out}.${process.pid}.${job.id}.tmp.jpg`;
                await fs.promises.mkdir(path.dirname(out), { recursive: true });
                await current.writeAsync(tmp);
                await fs.promises.rename(tmp, out);
            }
            return reply({ ok: true });
        }

        if (job.fit) {
            // Longest side, for a copy somebody is going to look at.
            if (Math.max(img.bitmap.width, img.bitmap.height) > job.fit) img.scaleToFit(job.fit, job.fit);
        } else if (img.getWidth() > job.width) {
            // Never enlarged: a small image blown up is just a blurry small image.
            img.scaleToFit(job.width, Jimp.AUTO);
        }
        img.quality(job.quality || 72);

        if (job.out) {
            // Written to a temporary name and moved into place, so two requests for the same new
            // thumbnail at the same moment cannot serve each other a half-written file.
            const tmp = `${job.out}.${process.pid}.${job.id}.tmp`;
            await fs.promises.mkdir(path.dirname(job.out), { recursive: true });
            await img.writeAsync(tmp);
            await fs.promises.rename(tmp, job.out);
            reply({ ok: true });
        } else {
            const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
            reply({ ok: true, buffer: buf });
        }
    } catch (err) {
        reply({ ok: false, error: err.message });
    }
});

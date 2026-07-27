# test/fixtures — parse-pipeline fixtures (plan 03-04)

Two committed binary fixtures back the routing (D-20) and image-prep (D-07) specs. Both are
**generated**, not downloaded: every byte is reproducible from the script below, no third-party
document is vendored into the repo, and no real bill (financial data) is committed.

The synthetic-signal cases in `test/parse-route.test.ts` deliberately do NOT use fixtures — the
D-20 gate is fed injected per-page signals, because hand-authoring a PDF that exhibits a 0.91
invisible-glyph ratio proves nothing the injected case does not. The fixtures exist for the two
things injection cannot prove: that a **real** image-only PDF routes `image-only` end-to-end
through the real pdfjs signal loader, and that a **real** EXIF-tagged photo is auto-oriented.

---

## `image-only.pdf` (7.5 KB)

**What it is:** a one-page US-Letter (612 x 792 pt) PDF whose entire content stream is a single
full-page image XObject. There is no `/Font` resource, no `BT`/`ET` text block, and no glyph
operator anywhere in the file.

**What it proves:**

| Property | Measured value | Gate consequence |
|----------|----------------|------------------|
| Painted-bitmap coverage | `1.0` (612x792 image `cm`-scaled over a 612x792 MediaBox) | >= `BITMAP_COVERAGE_THRESHOLD` (0.75) -> **image-only** at layer 1 of D-20 |
| Extractable non-whitespace chars | `0` | Could never reach the >= 50-char native rung anyway |
| Embedded fonts | `0` | Same |
| pdfjs operator list | `save, transform([612,0,0,792,0,0]), dependency, paintImageXObject, restore` | Exactly the signal shape `loadPdfSignals` reads |

It is also the **anti-pattern proof**: sharp cannot decode PDF bytes, so this file is what makes
`test/parse-prep-image.test.ts`'s "sharp rejects PDF bytes" assertion real rather than theoretical.
An image-only PDF must go `renderPdfPageImage` (pdfjs + @napi-rs/canvas) -> bitmap -> vision, never
`prepImage` (D-07 / D-19).

**Why hand-assembled rather than produced by a PDF library:** the repo has no PDF *writer*
dependency and adding one for a 7 KB fixture is not worth the supply-chain surface. The file is
assembled from literal PDF objects with a byte-exact `xref` table, so it is a genuinely valid PDF
(pdfjs parses and renders it) rather than a blob that merely happens to parse.

## `sideways-exif.jpg` (19 KB)

**What it is:** a 2400 x 1200 **landscape** JPEG whose EXIF orientation tag is **6** (rotate 90 CW
on display). Its dark bars sit in the top third only, so the image is asymmetric along the short
axis and an unrotated read is visibly different from an oriented one.

**What it proves:** `prepImage` calls `sharp().rotate()` with no angle, which applies EXIF
orientation (RESEARCH Pitfall 3 — sideways phone receipts are the norm). Correct handling turns
2400x1200 into 1200x2400, which then downscales inside the 2000px box to **1000 x 2000**. A
pipeline that ignored EXIF would emit 2000x1000 instead, so the assertion cannot pass vacuously.
The 2400px source is deliberately over the 2000px `LONG_EDGE`, so the same fixture also proves the
downscale.

`sharp(...).metadata()` on the committed file reports `width: 2400, height: 1200, orientation: 6`.

## Not committed: a HEIC sample

`test/parse-prep-image.test.ts` proves the HEIC-decode-before-sharp ordering (RESEARCH Pitfall 2)
with an **injected** `convert` double that records call order. A real `.heic` file would add ~1 MB
of binary to the repo and would prove the same ordering less directly, since the assertion is about
which collaborator runs first, not about libheif's output.

---

## Regenerating

Both files are byte-reproducible. Save as `make-fixtures.mjs` in the repo root and run
`node make-fixtures.mjs .` (sharp 0.35.3, Node 22):

```js
import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT = join(process.argv[2], 'test', 'fixtures')

// ---------------------------------------------------------------- sideways JPEG
function bandedRgb(width, height) {
  const px = Buffer.alloc(width * height * 3, 0xf5)
  for (let y = 0; y < height; y++) {
    const bar = y < height / 3 && Math.floor(y / 24) % 2 === 0 // top third only: asymmetric
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      if (bar && x > width * 0.08 && x < width * 0.7) {
        px[i] = 0x22
        px[i + 1] = 0x22
        px[i + 2] = 0x22
      }
    }
  }
  return px
}

const SW = 2400
const SH = 1200
await sharp(bandedRgb(SW, SH), { raw: { width: SW, height: SH, channels: 3 } })
  .withMetadata({ orientation: 6 }) // 6 = rotate 90 CW on display -> a viewer sees 1200x2400
  .jpeg({ quality: 60 })
  .toFile(join(OUT, 'sideways-exif.jpg'))

// ---------------------------------------------------------------- image-only PDF
const PW = 612 // US Letter points
const PH = 792
function receiptRaster(width, height) {
  const px = Buffer.alloc(width * height * 3, 0xff)
  const bars = [
    [60, 90, 40, 420], [130, 148, 40, 300], [160, 178, 40, 260], [220, 236, 40, 520],
    [250, 266, 40, 500], [280, 296, 40, 480], [340, 360, 300, 560], [400, 424, 300, 560]
  ]
  for (const [y0, y1, x0, x1] of bars) {
    for (let y = y0; y < y1 && y < height; y++) {
      for (let x = x0; x < x1 && x < width; x++) {
        const i = (y * width + x) * 3
        px[i] = 0x1a
        px[i + 1] = 0x1a
        px[i + 2] = 0x1a
      }
    }
  }
  return px
}

const jpeg = await sharp(receiptRaster(PW, PH), { raw: { width: PW, height: PH, channels: 3 } })
  .jpeg({ quality: 70, progressive: false }) // baseline only: DCTDecode cannot read progressive
  .toBuffer()

const enc = (s) => Buffer.from(s, 'latin1')
const objects = [
  enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
  enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
  enc(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${PW} ${PH}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> ' + // no /Font entry anywhere
      '/Contents 5 0 R >>\nendobj\n'
  ),
  Buffer.concat([
    enc(
      '4 0 obj\n<< /Type /XObject /Subtype /Image ' +
        `/Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    ),
    jpeg,
    enc('\nendstream\nendobj\n')
  ]),
  (() => {
    const content = `q\n${PW} 0 0 ${PH} 0 0 cm\n/Im0 Do\nQ\n` // no BT/ET, no Tj
    return enc(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)
  })()
]

const header = enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
const chunks = [header]
const offsets = []
let cursor = header.length
for (const obj of objects) {
  offsets.push(cursor)
  chunks.push(obj)
  cursor += obj.length
}
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`
xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
chunks.push(enc(xref))

await writeFile(join(OUT, 'image-only.pdf'), Buffer.concat(chunks))
```

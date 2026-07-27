// src/main/upload/app.ts
//
// The express 5 application behind "Add from phone". It is deliberately tiny: two routes, one
// error handler, one catch-all 404, and no static directory anywhere.
//
// THE SURFACE IS UPLOAD-ONLY, AND THAT IS THE POINT. This process is about to listen on 0.0.0.0,
// which means every device on the network can reach it, including a guest on the same Wi-Fi. The
// folder it writes into holds a small business's invoices and receipts. So there is no route that
// reads a file, no express.static, and no directory listing: the only thing this server can do with
// the inbox is add to it. test/upload-server.test.ts proves the property directly by uploading a
// file and then failing to GET it back under every path shape it landed at.
//
// THE TOKEN IS THE ONLY GATE, so it is checked before anything else happens on every route. A bad
// or missing token produces a BARE 404 with no body: an error page that said "wrong token" would
// confirm to a scanner that a token-shaped secret is what unlocks this port, and a 401 would do the
// same. To an unauthenticated probe this port looks like it is serving nothing at all. Comparison
// is constant-time so response latency cannot be used to walk the token character by character.
//
// LIMITS ARE ENFORCED TWICE, on purpose. The mobile page's accept="" attribute is a hint to the
// phone's file picker, nothing more; a client can post whatever it likes to this endpoint. Every
// file is therefore screened again here on BOTH its extension and its declared MIME type, and the
// 25 MB / 20 file caps are enforced by multer rather than by the page.
//
// BYTES LAND IN A STAGING DIRECTORY FIRST, never straight in the inbox. Multer streams a rejected
// or oversized upload to disk before it discovers the problem, and the Phase 2 scan runs on a timer
// against that same folder, so writing in place would let a truncated file be seen mid-write.
// Staging plus an atomic rename means the inbox only ever gains whole files.

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response
} from 'express'
import multer, { MulterError } from 'multer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { extname } from 'node:path'
import { isSupportedName, moveIntoInbox, sanitizeFilename } from './filename'
import { renderProblemPage, renderReceivedPage, renderUploadPage } from './page'

/** Per-file ceiling. Comfortably above a phone photo or a scanned multi-page invoice. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Per-request ceiling. A batch is 5 to 20 documents; more than this is a mistake or an attack. */
export const MAX_FILES = 20

/**
 * MIME types accepted alongside the extension check. Both must pass.
 *
 * The list is explicit rather than a prefix test on 'image/': 'image/svg+xml' is an image by that
 * measure and is also an executable document, and 'image/gif' would sail through a prefix test only
 * to be dropped later by a pipeline that cannot read it. Every entry here corresponds to an
 * extension the scan already accepts. The '-sequence' variants are what iOS sends for a Live Photo.
 */
const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg', // non-standard, but real: some Android camera apps and older clients send it
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
])

/** Dependencies of one app instance. Everything is injected so a test can drive the real routes. */
export interface UploadAppDeps {
  /** The URL path secret. Only requests under /u/{token}/ are served. */
  token: string
  /** Managed inbox folder. Resolved main-side; the renderer and the phone never name a path. */
  inboxPath: string
  /** Temp folder that multer streams into before the atomic move. Must already exist. */
  stagingDir: string
  /** Called with the saved names after each successful upload. Drives the upload:received broadcast. */
  onReceived?: (filenames: string[]) => void
  /** Called on every correctly-tokened request, so the idle shutdown timer can be reset. */
  onActivity?: () => void
}

/** Names rejected by the type filter, collected per request without widening express's Request type. */
const rejectedNames = new WeakMap<Request, string[]>()

function rejectedFor(req: Request): string[] {
  let names = rejectedNames.get(req)
  if (!names) {
    names = []
    rejectedNames.set(req, names)
  }
  return names
}

/**
 * Constant-time string comparison. A length mismatch short-circuits (lengths are not secret, and
 * timingSafeEqual throws on unequal buffers), but equal-length candidates are always compared in
 * full so no prefix leaks through response timing.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Fixed, path-free copy for each way an upload can fail. Never a raw error message. */
function problemCopy(err: unknown): string {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return 'One of those files is bigger than 25 MB. Try taking the photo again at a smaller size, or send it in two parts.'
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return 'That is more than 20 files at once. Please send them in smaller batches.'
    }
    return 'Those files could not be read. Please choose them again and send once more.'
  }
  return 'Something went wrong saving those files. Please try again.'
}

/**
 * Build the upload app. Exported separately from the server lifecycle so tests can bind it to an
 * ephemeral port and drive the real routes over real HTTP, rather than asserting against a mock.
 */
export function createUploadApp(deps: UploadAppDeps): Express {
  const { token, inboxPath, stagingDir } = deps
  const app = express()

  // Advertise nothing. Both are default-on in express and both are pure signal for a scanner.
  app.disable('x-powered-by')
  app.set('etag', false)

  const uploader = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, stagingDir),
      // A random staging name, never the client's. The client's name is only trusted once, at the
      // move step, after sanitizeFilename has reduced it to a single safe path segment.
      filename: (_req, file, cb) => {
        const ext = extname(sanitizeFilename(file.originalname)).toLowerCase()
        cb(null, `${randomBytes(12).toString('hex')}${ext}`)
      }
    }),
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: MAX_FILES,
      fields: 8,
      parts: MAX_FILES + 8
    },
    fileFilter: (req, file, cb) => {
      const name = sanitizeFilename(file.originalname)
      const mime = String(file.mimetype ?? '').toLowerCase().split(';')[0].trim()
      if (!isSupportedName(name) || !ALLOWED_MIME.has(mime)) {
        // cb(null, false) skips this file and keeps the rest of the request alive, which is the
        // right call for a batch: one stray screenshot must not lose the four receipts beside it.
        rejectedFor(req).push(name)
        cb(null, false)
        return
      }
      cb(null, true)
    }
  })

  /** First statement on every route. A wrong or missing token gets a bare 404, never a hint. */
  function tokenGate(req: Request, res: Response, next: NextFunction): void {
    const candidate = req.params['token']
    if (typeof candidate !== 'string' || !tokensMatch(candidate, token)) {
      res.status(404).end()
      return
    }
    deps.onActivity?.()
    next()
  }

  app.get('/u/:token', tokenGate, (_req: Request, res: Response) => {
    res.type('html').send(renderUploadPage(token))
  })

  app.post(
    '/u/:token/upload',
    tokenGate,
    uploader.array('files', MAX_FILES),
    async (req: Request, res: Response) => {
      const staged = Array.isArray(req.files) ? req.files : []
      const rejected = [...rejectedFor(req)]
      const saved: string[] = []

      for (const file of staged) {
        try {
          saved.push(await moveIntoInbox(inboxPath, file.path, file.originalname))
        } catch {
          // The bytes arrived but could not be placed (the inbox was moved, a permission changed,
          // the volume filled). Report it as not accepted rather than claiming a success: the whole
          // value of the confirmation page is that the list on it is true.
          rejected.push(sanitizeFilename(file.originalname))
        }
      }

      if (saved.length > 0) deps.onReceived?.(saved)
      res.type('html').send(renderReceivedPage(token, saved, rejected))
    }
  )

  // Everything else, including any attempt to read a file back out, is a bare 404. There is no
  // route that serves inbox content, so this is the only possible answer.
  app.use((_req: Request, res: Response) => {
    res.status(404).end()
  })

  // Multer's limit errors land here. The token already matched to get this far, so a real user is
  // looking at the result and deserves a page that says what to do next.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err instanceof MulterError ? 400 : 500)
    res.type('html').send(renderProblemPage(token, problemCopy(err)))
  })

  return app
}

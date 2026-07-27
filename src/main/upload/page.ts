// src/main/upload/page.ts
//
// The three pages the phone sees, as self-contained HTML strings.
//
// Everything is inline on purpose: no stylesheet, no script file, no font, no image request. The
// server is upload-only (it exposes exactly two routes and serves no static directory), so a page
// that referenced an asset would need a third route whose only job is to hand bytes back out --
// precisely the surface this feature is built not to have. Inline also means the page renders
// instantly on a phone that has just joined the network and may not have internet at all.
//
// Copy rules: plain language for a non-technical user, and NO em dashes or en dashes anywhere in
// any string a person reads (house rule; test/upload-page.test.ts pins it).
//
// The brand crimson #910023 is hardcoded rather than read from a token file because the renderer's
// design tokens live in a CSS file the main process does not load. DESIGN wave: this is the one
// surface in the app whose styling is not driven by globals.css.

/** Logo crimson, straight off the NicoleBooks lockup. Matches --primary in the renderer theme. */
const BRAND = '#910023'

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Shared chrome: mobile viewport, system font stack, and the crimson accent. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 20px 40px;
    background: #f5f5f7;
    color: #343434;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    font-size: 17px;
    line-height: 1.45;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 480px; margin: 0 auto; }
  .brand {
    color: ${BRAND};
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0 0 6px;
  }
  h1 { font-size: 24px; line-height: 1.2; margin: 0 0 8px; font-weight: 700; }
  p { margin: 0 0 16px; }
  .muted { color: #6e6e73; font-size: 15px; }
  .card {
    background: #ffffff;
    border: 1px solid #e5e5ea;
    border-radius: 14px;
    padding: 18px;
    margin: 0 0 16px;
  }
  .pick {
    display: block;
    width: 100%;
    border: 2px solid ${BRAND};
    border-radius: 12px;
    padding: 16px;
    margin: 0 0 12px;
    background: #ffffff;
    color: ${BRAND};
    font-size: 17px;
    font-weight: 600;
    text-align: center;
    cursor: pointer;
  }
  .pick:last-of-type { margin-bottom: 0; }
  .pick input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .pick .hint { display: block; font-size: 14px; font-weight: 400; color: #6e6e73; margin-top: 4px; }
  .send {
    display: block;
    width: 100%;
    border: 0;
    border-radius: 12px;
    padding: 16px;
    background: ${BRAND};
    color: #ffffff;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
  }
  .send[disabled] { opacity: 0.45; }
  .chosen { margin: 0 0 14px; font-size: 15px; color: #6e6e73; }
  ul { margin: 0 0 16px; padding-left: 20px; }
  li { margin-bottom: 4px; word-break: break-word; }
  .ok { color: ${BRAND}; font-weight: 600; }
  .again {
    display: inline-block;
    margin-top: 4px;
    color: ${BRAND};
    font-weight: 600;
    text-decoration: none;
    border-bottom: 2px solid ${BRAND};
  }
  footer { margin-top: 24px; font-size: 14px; color: #6e6e73; }
</style>
</head>
<body>
<div class="wrap">
<p class="brand">NicoleBooks</p>
${body}
</div>
</body>
</html>`
}

/**
 * The upload form. Two affordances, both posting to the same endpoint under the same field name:
 * a camera capture for a paper receipt in hand, and a file picker for anything already saved on the
 * phone. `capture="environment"` asks for the rear camera, which is the one pointed at a receipt.
 *
 * The inline script only enables the send button and reports the count; with scripting off the form
 * still submits, because the button starts disabled ONLY after the script runs.
 */
export function renderUploadPage(token: string): string {
  const action = `/u/${encodeURIComponent(token)}/upload`
  return shell(
    'Send bills to NicoleBooks',
    `<h1>Send bills to NicoleBooks</h1>
<p class="muted">Snap a photo of a paper receipt, or pick files that are already on your phone. They go straight to the bills folder on the computer running NicoleBooks.</p>
<form class="card" method="post" enctype="multipart/form-data" action="${escapeHtml(action)}" id="form">
  <label class="pick">
    Take a photo
    <span class="hint">Uses your camera</span>
    <input type="file" name="files" accept="image/*" capture="environment">
  </label>
  <label class="pick">
    Choose files
    <span class="hint">Photos or PDF files already saved on this phone</span>
    <input type="file" name="files" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" multiple>
  </label>
  <p class="chosen" id="chosen" style="margin-top:14px">Nothing chosen yet.</p>
  <button class="send" type="submit" id="send">Send to NicoleBooks</button>
</form>
<footer>You can send up to 20 files at a time, and each one can be up to 25 MB. This page only works while NicoleBooks is showing the code on the computer.</footer>
<script>
(function () {
  var form = document.getElementById('form');
  var send = document.getElementById('send');
  var chosen = document.getElementById('chosen');
  var inputs = form.querySelectorAll('input[type=file]');
  send.disabled = true;
  function count() {
    var n = 0;
    for (var i = 0; i < inputs.length; i++) n += inputs[i].files ? inputs[i].files.length : 0;
    send.disabled = n === 0;
    chosen.textContent = n === 0 ? 'Nothing chosen yet.' : (n === 1 ? '1 file ready to send.' : n + ' files ready to send.');
  }
  for (var i = 0; i < inputs.length; i++) inputs[i].addEventListener('change', count);
  form.addEventListener('submit', function () {
    send.disabled = true;
    send.textContent = 'Sending...';
  });
})();
</script>`
  )
}

/** One list, or nothing at all when the list is empty. */
function list(heading: string, names: string[]): string {
  if (names.length === 0) return ''
  return `<p>${escapeHtml(heading)}</p><ul>${names
    .map((name) => `<li>${escapeHtml(name)}</li>`)
    .join('')}</ul>`
}

/**
 * The "it worked" page. It names every file so the user can see their own receipt in the list, and
 * it names the rejected ones too: a file that quietly disappears between the phone and the computer
 * is the failure mode that costs the most trust.
 */
export function renderReceivedPage(token: string, saved: string[], rejected: string[]): string {
  const back = `/u/${encodeURIComponent(token)}/`
  const heading =
    saved.length === 0
      ? 'Nothing was added'
      : saved.length === 1
        ? 'Got it, 1 file added'
        : `Got it, ${saved.length} files added`

  const savedBlock =
    saved.length > 0
      ? `<p class="ok">These are now waiting on the computer:</p><ul>${saved
          .map((name) => `<li>${escapeHtml(name)}</li>`)
          .join('')}</ul>`
      : `<p>None of those files could be used. NicoleBooks accepts PDF files and photos saved as JPG, PNG, or HEIC.</p>`

  const rejectedBlock = list(
    rejected.length === 1
      ? 'This one was not accepted, because NicoleBooks only takes PDF files and photos:'
      : 'These were not accepted, because NicoleBooks only takes PDF files and photos:',
    rejected
  )

  return shell(
    'Sent to NicoleBooks',
    `<h1>${escapeHtml(heading)}</h1>
<div class="card">${savedBlock}${rejectedBlock}</div>
<p><a class="again" href="${escapeHtml(back)}">Add more</a></p>
<footer>You can close this page when you are done.</footer>`
  )
}

/**
 * The friendly failure page. `reason` is always fixed copy chosen main-side, never a raw error
 * message: a filesystem or bind error carries a path or a port and neither belongs on a phone
 * screen that anyone on the network could be looking at.
 */
export function renderProblemPage(token: string, reason: string): string {
  const back = `/u/${encodeURIComponent(token)}/`
  return shell(
    'Could not send',
    `<h1>That did not go through</h1>
<div class="card"><p>${escapeHtml(reason)}</p></div>
<p><a class="again" href="${escapeHtml(back)}">Try again</a></p>`
  )
}

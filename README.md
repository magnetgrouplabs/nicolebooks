# NicoleBooks

NicoleBooks is a desktop application for Windows and macOS that turns a folder of bill documents into reviewed, correctly categorized entries in QuickBooks Online. Documents are dropped into a folder named for the date they should be entered against, and the app reads each one, whether it is a text based PDF invoice or a photo of a paper receipt. It extracts the vendor, amount, category, and line items, checks them against the records that already exist in the connected QuickBooks company, and presents everything in a review table with editable dropdowns. Nothing is sent anywhere until it is approved. Once it is, the approved rows post to QuickBooks Online as Bills or Expenses, with an audit trail of exactly what was created.

## Key features

- **Mixed document handling.** Digital PDFs are read with programmatic text extraction. Photos, scans, and image only PDFs are routed to a vision capable model. HEIC photos from an iPhone are converted automatically.
- **Review before send.** Every parsed bill lands in an editable table first. Vendor, category, and amount are all adjustable, and each row can be posted as an unpaid Bill or an already paid Expense.
- **Reconciliation against your books.** Vendors, categories, and accounts are matched against what already exists in the connected QuickBooks company, so the app prefers an existing record over creating a new one.
- **Confidence flags.** Fields the parser is unsure about are marked, so attention goes to the handful of values that actually need a second look.
- **Duplicate guardrails.** File level hashing catches the same document twice, and a warning appears when a vendor, amount, and date combination looks like something already recorded.
- **Audit log and undo.** Everything sent is logged with the identifiers QuickBooks returned, and the most recent batch can be voided in one click.
- **Bring your own AI key.** Settings takes an OpenAI compatible API key, pulls the list of models that key can reach, and lets you choose which one to use. It works against OpenAI, OpenRouter, or any compatible endpoint.
- **Local and private.** Credentials are held in the operating system keychain (Keychain on macOS, DPAPI on Windows). The database, the audit log, and the documents themselves stay on the machine.
- **Automatic updates.** The app checks for new versions on launch and offers to install them when they are ready.

## Download and install

Installers are published on the [Releases page](https://github.com/magnetgrouplabs/nicolebooks/releases). Download the newest release for your platform.

| Platform | File |
| --- | --- |
| Windows 10 or 11 (64 bit) | `NicoleBooks-Setup-<version>.exe` |
| macOS, Apple Silicon | `NicoleBooks-<version>-arm64.dmg` |
| macOS, Intel | `NicoleBooks-<version>.dmg` |

### Windows

1. Run the downloaded `NicoleBooks-Setup-<version>.exe`.
2. Windows SmartScreen will show a blue "Windows protected your PC" panel, because the installer is not yet code signed. Click **More info**, then click **Run anyway**.
3. The installer runs on its own, with no options to choose and no administrator prompt. It installs for the current user only and adds a desktop shortcut and a Start menu entry.
4. Launch NicoleBooks from the desktop shortcut.

To remove it later, use Settings, then Apps, then Installed apps, and uninstall NicoleBooks. Your local database, audit log, and saved credentials are deliberately left in place so a reinstall picks up where you left off.

### macOS

1. Open the downloaded `.dmg` and drag **NicoleBooks** into the Applications folder.
2. Open Applications and double click NicoleBooks. macOS will refuse the first launch and say the app cannot be opened because it is from an unidentified developer. This is expected, because the app is not yet notarized by Apple.
3. Open **System Settings**, go to **Privacy and Security**, and scroll to the Security section. There will be a message about NicoleBooks being blocked, with an **Open Anyway** button next to it. Click it.
4. Confirm with **Open** when macOS asks a second time, and authenticate with Touch ID or your password.

You only have to do this once. Every launch after that is a normal double click.

Two macOS builds are published. If you are on an Apple Silicon Mac (M1 or newer), take the `arm64` file. If you are on an Intel Mac, take the file without an architecture suffix. Apple menu, then About This Mac, tells you which one you have.

### Updates

Once installed, NicoleBooks checks for a newer version each time it starts. If one is found it downloads quietly in the background, and a small window appears when it is ready, offering to restart now or later. Choosing later installs the update the next time the app is closed. Nothing is downloaded or installed without that prompt.

## Uploading bills from your phone

Photographing a receipt with a phone and then getting the file onto a computer is the slowest part of a paper bill. NicoleBooks removes that step: it can display a QR code that opens a small upload page served from the app itself, over your local network.

1. Make sure the phone and the computer are on the same Wi-Fi network.
2. In NicoleBooks, open the phone upload panel. A QR code appears.
3. Scan the QR code with the phone camera and tap the link that appears.
4. Take photos or pick existing ones, then send. They arrive in the app's inbox folder for the selected date and appear in the next scan.

The upload page is served by the app on your local network only. It is not published to the internet, it is not reachable from outside your network, and it stops as soon as you close the panel.

## Development setup

Requirements: Node.js 22.12 or newer, and a working native build toolchain (Visual Studio Build Tools with the C++ workload on Windows, Xcode Command Line Tools on macOS).

```bash
git clone https://github.com/magnetgrouplabs/nicolebooks.git
cd nicolebooks
npm ci
npm run dev
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs the app with hot reload |
| `npm run build` | Builds the main, preload, and renderer bundles into `out/` |
| `npm run typecheck` | Type checks every project reference |
| `npm run test:unit` | Runs the Vitest unit suite |
| `npm run test:e2e` | Runs the Playwright end to end suite against the built app |
| `npm run package` | Builds and packages installers for the current platform into `dist/` |

The app is built on Electron, React, Vite, and TypeScript, with SQLite for local persistence and Zod for validation at every boundary. The main process handles document parsing, the QuickBooks API, and secret storage; the renderer is a sandboxed UI that reaches the main process only through a narrow, validated IPC surface.

Releases are cut by pushing a tag that starts with `v`. A GitHub Actions workflow then builds on both platforms and publishes the installers, along with the update feed the app reads.

## License

UNLICENSED. This is a private tool built by Magnet Group Labs and is not offered for redistribution or reuse.

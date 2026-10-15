# ramtalk

A private, two-person chat PWA for people in the same place. There are no accounts and no servers, and nothing is kept after the chat ends.

- **Pairing by QR code.** One person taps *Start* and shows a code, and the other taps *Join* and scans it. The joiner then shows a reply code for the starter to scan.
- **Direct and local.** Messages go straight between the two devices over a WebRTC data channel on a shared Wi-Fi network or one phone's personal hotspot. No internet connection is needed.
- **End-to-end encrypted at the app layer.** This is in addition to WebRTC's DTLS. Both screens show the same five emoji, which lets you check that nobody is listening in.
- Markdown, emoji (picker and `:shortcodes:`), files, and camera photos.
- **Ephemeral.** History lives only in memory. Ending the chat, closing the app or losing the connection wipes everything. Save received files *during* the chat.
- **Exactly two people.** A conversation accepts one reply code, and each code works once.

## Why not Bluetooth?

Browsers can't do phone-to-phone Bluetooth:

- Web Bluetooth only supports the *central* role. A page can connect to a device, but it can't advertise or act as a GATT server.
- Safari and all iOS browsers have no Web Bluetooth at all.

A local WebRTC link keeps what matters: direct, nearby-only, serverless and fast. It also works as an installable PWA on both iOS and Android without app stores.

## Running it

```sh
npm install
npm run dev        # https://<your-LAN-IP>:5173 (self-signed cert; accept the warning on each phone)
npm run build      # static output in dist/
npm run preview    # serve the production build over HTTPS on the LAN
npm test           # unit tests (Vitest)
npm run test:e2e   # end-to-end tests (Playwright: Chromium↔Chromium, Chromium↔Firefox)
npm run check      # svelte-check / TypeScript
```

The camera and service worker require a secure context, so the dev and preview servers use HTTPS. Set `HTTPS=0` to turn that off on `localhost`.

**Deploying:** put `dist/` on any static HTTPS host, such as GitHub Pages. For a sub-path, build with `BASE=/repo-name/ npm run build`. Open the site once on each phone and choose *Add to Home Screen*. After that it works offline.

## How it works

```
Host                                                   Joiner
──────────────────────────────────────────────────────────────────────────────
open camera, ECDH keypair, RTCPeerConnection
createOffer, gather ICE
QR1 = [sessionId, hostPub, ufrag/pwd,
       DTLS fingerprint, host candidates]   ── scan ─▶  open camera, ECDH keypair
                                                       apply offer, createAnswer
                                                       (setup:passive), gather ICE
                                                       QR2 = [sessionId, joinerPub, …]
scan QR2 ◀──────────────────────────────────────────── show QR2
both: keys = HKDF(ECDH, salt = SHA-256("ramtalk/v1" ‖ QR1 ‖ QR2))
data channel opens ── hello{name, HMAC confirm} ──▶ ◀── hello ──  → chat
```

- **`src/lib/signaling/`**: compresses a browser SDP down to the few fields that matter, so the codes stay small. These fields are the ICE credentials, the DTLS fingerprint and role, the SCTP limits and up to 6 host candidates. Each code is a ~250-character base45 string (QR alphanumeric mode).
- **`src/lib/crypto/session.ts`**: P-256 ECDH, HKDF-SHA256 and AES-256-GCM via WebCrypto, with no crypto dependencies.
  - Each direction has its own key.
  - Nonces are 64-bit counters, and anything out of sequence, replayed or tampered with ends the session.
  - The first message each side sends must prove it holds the same keys (HMAC key confirmation).
  - The QR codes are exchanged in person, and that visual channel is what authenticates the public keys.
- **`src/lib/protocol/`**: the message types sent inside the encrypted channel, and file chunking.
  - File chunks are sized to the peer's SCTP limit, with backpressure while sending.
  - Received files are reassembled in memory with size limits: 200 MB per file and 500 MB in total.
- **`src/lib/transport/peer.ts`**: the single `RTCPeerConnection` and its pre-negotiated data channel. There are no ICE servers, and no ICE restart is possible because there is no signaling channel. A drop lasting longer than 10 s ends the chat.
- **`src/lib/chat/controller.svelte.ts`**: runs the chat and keeps all its state. `end()` wipes it:
  - closes the connection and stops the camera
  - revokes object URLs and drops the keys
  - clears all messages and files

### Security notes

- Peer content is untrusted:
  - Markdown is rendered with raw HTML disabled, then DOMPurify applies an allowlist.
  - Remote images are never loaded.
  - Links are `noopener noreferrer`.
  - Only PNG, JPEG, GIF and WebP are shown inline. Every other received file is held as `application/octet-stream`, so it can't render on the app's origin.
  - Filenames are sanitized.
- A strict CSP is set in `index.html`: no inline script, no eval, and `connect-src 'self'`.
- The service worker precaches the app shell only, with no runtime caching. Chat content never touches `localStorage`, IndexedDB or caches. What is stored on the device:
  - your display name, in `localStorage`
  - the emoji picker's own emoji database and recently used emoji, in IndexedDB (not chat content)
- The joiner is the DTLS *server*. Anyone who glimpsed the host's code can send ICE checks to the host, and as a DTLS client a stray second joiner could stall the real handshake. As a server, it never contacts the host on its own. The E2E suite covers this.

### Why the camera opens first

Chrome and Safari hide local IP addresses behind `*.local` mDNS names unless the page has camera permission or an active capture. Those names often fail to resolve on a phone hotspot. The camera is needed to scan codes anyway, so it opens *before* connection candidates are gathered and stays open until the link is up. This makes real LAN addresses available. Only one side needs a reachable address.

## Limitations

- Both devices must be on the same network: a shared Wi-Fi or one phone's hotspot. Networks with client isolation, such as some public Wi-Fi, block the connection.
- Locking the phone or switching apps (especially on iOS) suspends the PWA and ends the chat. A screen wake lock is held while chatting.
- There is no "nearby people" list. Browsers can't scan for other devices, so scanning the code *is* discovery.

## Testing on real devices (required)

The automated tests run in desktop Chromium and Firefox. Safari/iOS can only be verified on hardware, so before relying on the app:

1. iPhone (Safari, installed to the Home Screen) ↔ Android (Chrome, installed). Use one phone's hotspot with mobile data off. Try both host/joiner directions.
   Watch the joiner for a `setLocalDescription` error. If the browser rejects the `setup:passive` answer, the app falls back to the default DTLS role and logs a warning in dev builds.
2. Repeat on a shared Wi-Fi network.
3. Wait 30–60 s before the host scans the reply code, to confirm a slow scan still connects.
4. Send a ~20 MB file and a camera photo, and save both on the receiving side. On iOS, saving opens the share sheet.
5. Lock one phone, and confirm the other shows the chat ended and is wiped.
6. Turn on airplane mode with Wi-Fi only and relaunch from the Home Screen, to confirm offline install works.

If step 1 can't connect, the most likely cause is iOS Safari's candidate handling on hotspot interfaces. The fallback is a tiny optional LAN signaling helper; the rest of the design is unaffected.

## License

[MIT](LICENSE). The build also writes `dist/THIRD_PARTY_LICENSES.txt`, which holds the licenses of the bundled dependencies (MIT, ISC, BSD, Apache-2.0 and MPL-2.0/Apache-2.0). It is served at `/THIRD_PARTY_LICENSES.txt`.

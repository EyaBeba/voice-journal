# Voice Journal

A private voice journal that works offline. It installs like an app on your phone or computer, and recordings never leave your device.

## Features

- **One-tap recording** with a live waveform. Each recording is saved as soon as you stop, so nothing gets lost.
- **Daily prompts** to get you talking, with an "Another one" button for a different prompt.
- **Mood and tags** on every entry, plus search and filters in the Journal tab.
- **Streaks and a calendar heatmap.** Tap a day to see its entries. A chart shows your moods over the last 30 days.
- **PIN lock.** The app locks when you open it and after 1 minute in the background.
- **Zip backup and restore.** A backup holds every recording plus `journal.json`. Importing skips entries you already have.
- **Works offline.** A service worker keeps the app available without internet. Your data stays in IndexedDB on your device.

## Run it

It's plain HTML, CSS and JavaScript, with no build step and no dependencies.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The microphone, service worker and PIN lock need a secure context: `localhost` or HTTPS. To use it on your phone, host it on GitHub Pages (Settings → Pages → Deploy from branch `main`, root). It is then at https://eyabeba.github.io/voice-journal/. Then open it once and choose **Install app** in Settings, or **Add to Home Screen** on iOS. After that it works with no internet.

## Files

| File | Purpose |
| --- | --- |
| `index.html` / `styles.css` | UI (light and dark themes, mobile-first) |
| `app.js` | Recording, playback, journal, calendar, PIN, backup |
| `db.js` | IndexedDB storage |
| `zip.js` | Dependency-free zip writer and reader for backups |
| `prompts.js` | Daily journaling prompts |
| `sw.js` | Service worker for offline use |

## Notes

- The PIN keeps people who pick up your device out of the app. It does **not** encrypt the stored audio.
- Browsers can clear site data when storage runs low. Use **Keep my data safe** in Settings, install the app, and export backups now and then.
- If you update the app files, bump `CACHE` in `sw.js` so installed copies pick up the new version.

## Ideas for later

- Offline transcription with Whisper (via WebAssembly) so entries can be searched by what you said
- Encrypting stored entries with a key derived from the PIN
- Reminders to record, and "On this day" playback

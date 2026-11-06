# Voice Journal

A private voice journal that works offline. It installs like an app on your phone or computer, and recordings never leave your device.

## Features

- **One-tap recording** with a live waveform. Each recording is saved as soon as you stop, so nothing gets lost.
- **Daily prompts** to get you talking, with an "Another one" button for a different prompt.
- **Mood and tags** on every entry, plus search and filters in the Journal tab.
- **Offline transcription.** Speech-to-text runs on your phone with Whisper (English). Turn it on in Settings and pick Tiny (~65 MB), Base (~80 MB) or Small (~250 MB). The model downloads once; after that every note is transcribed automatically, with no internet, and you can search by what you said. You can edit the transcript, and **Word fixes** in Settings corrects words it keeps mishearing (for example "Jonah" to "journal").
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
| `transcribe.js` / `transcriber.worker.js` | Offline speech-to-text (runs in a background thread) |
| `fonts/` | Cormorant Garamond and Inter, bundled so the design works offline (SIL Open Font License) |
| `vendor/` | Bundled [Transformers.js](https://github.com/huggingface/transformers.js) 3.8.1 and its ONNX Runtime WebAssembly engine (Apache-2.0) |
| `sw.js` | Service worker for offline use |

## Notes

- Transcription models come from Hugging Face (`Xenova/whisper-*.en`) and are stored in the browser's Cache Storage. **Delete downloaded models** in Settings frees that space.

- The PIN keeps people who pick up your device out of the app. It does **not** encrypt the stored audio.
- Browsers can clear site data when storage runs low. Use **Keep my data safe** in Settings, install the app, and export backups now and then.
- If you update the app files, bump `CACHE` in `sw.js` so installed copies pick up the new version.

## Ideas for later

- Encrypting stored entries with a key derived from the PIN
- Reminders to record, and "On this day" playback

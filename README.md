# A Google Sheet and Google App Script based Hifdh Tracker
## Students progress are tracked in a Central Sheet
## New Students can be registered providing image

This is the offline SPA in `claude-hifdh-spa/hifdh-spa` rebuilt as an Apps Script web app. The pages, CSS and behaviour are the SPA's. The records live in the Google Sheet the script is bound to, and all reading and writing happens in `Code.js`. The browser stores nothing.

The project metadata comes from `../clasp`. `.clasp.json` is an exact copy, so it has the same script ID. `appsscript.json` keeps the same time zone, runtime, logging, web app settings and Sheets scope. It drops two things: the `sheets.macros` entries, which pointed at the old implementation's functions, and the unused `script.external_request` scope.

## Files

| File | Runs in | What it is | Source in the SPA |
|---|---|---|---|
| `Code.js` | Google server | Router (`doGet`), **Google Sheet persistence layer**, API for the pages | replaces `localStorage` (`loadDB` / `saveDB`) |
| `Styles.html` | browser | Stylesheet, plus a few rules for loading and dialogs | the `<style>` block, lines 9–341 of every page, copied as-is |
| `Header.html` | browser | Top bar and nav container | the header markup shared by every page |
| `Common.html` | browser | Shared client code, adapted to Apps Script (see below) | the "Shared code" block in every page |
| `Quran.html` | browser | Quran metadata, surah autocomplete, portion and assessment editors | `progress.html` lines 607–898, copied as-is |
| `Index.html` … `Backup.html` | browser | One template per page: markup plus page script | `index.html` … `backup.html` |
| `appsscript.json`, `.clasp.json` | – | Project metadata | from `../clasp` |

Pages are opened as `<web app URL>?page=index|register|profile|progress|murajah|history|backup`, with `&id=<student>` where needed.

## Deploy

1. **Upload the files.** Use either method:
   - **clasp:** run `clasp push` from this folder. This **replaces every file** in the Apps Script project with this folder's files. For example, the old `Navbar.html` is deleted. The old version stays in `../clasp` if you want to push it back.
   - **By hand:** open the Sheet, then Extensions ▸ Apps Script. Create each file with the same name (HTML files without the `.html` extension) and paste its contents. Replace `appsscript.json`; to see it, turn on Project Settings ▸ "Show appsscript.json".
2. **Run `setup` once from the editor.** This grants access and creates the **Students**, **Sessions** and **Config** tabs.
3. **Deploy.** Choose Deploy ▸ Manage deployments ▸ edit the web app ▸ Version: *New version*. (For a first deployment: Deploy ▸ New deployment ▸ Web app.) The `/exec` URL only serves new code after you create a new version.

**Moving data over from the offline app:** in the SPA, open Backup ▸ *Download backup*. In this app, open Backup ▸ *Restore from backup*. Photos too big for a Sheets cell are shrunk in the browser first.

## The Google Sheet

- **Students:** ID, Name, Contact Number, Contact, Date Started, Teacher Notes, Created At, Updated At, Photo
- **Sessions:** ID, Student ID, Date, Type, New Memorisation, Revision, Grade, Memory / Tajweed Mistakes, Prompts, Note, Overall %, Juz % (JSON), Juz Revised (JSON), Revision Share (JSON), Ranges (JSON), Created At
- **Config:** `seq` (next record ID), `version`, `exampleHidden`

`Code.js` finds columns **by header name**. You can reorder columns or add your own, and a missing column is appended automatically. It also recognises the headers used by the earlier `../clasp` version, so a Sheet that version created still loads.

Text is written with a leading apostrophe, so Sheets keeps it exactly as typed. `07700…` keeps its leading zero, `+44…` isn't read as a formula, and a name starting with `=` stays text.

Every change runs under `LockService`, so two teachers saving at once can't get the same ID or overwrite each other. The server re-validates everything it receives:
- lengths, dates, contacts and grades
- juz % between 0 and 100
- ayah and page ranges
- photos: type, and a size limit of one cell (48,000 characters)
- the 100-student limit

## What was adapted for Apps Script, and why

| In the SPA | Here | Why |
|---|---|---|
| `localStorage`, the `storage` event, Firefox storage check | `DB` loaded from `loadDatabase()`; each save calls `Code.js` and updates `DB` with the returned record | The Sheet is the only store |
| `nextId(db)` in the browser | IDs assigned in `Code.js` under a lock, never reused | Several teachers can save at once |
| Photos inside every record | `getPhotos()` loads after the page appears, and initials are swapped for photos in place | Photos are large, so the page shows quickly without them |
| `location.search` / `param()` | Parameters are passed in by `doGet` (`BOOT.params`) | The page runs in an iframe that can't see the real URL |
| `history.replaceState` | `google.script.history.replace` | Updates the real address bar |
| Links like `profile.html?id=3`, `location.href = …` | `pageUrl()` / `link()` build `<web app URL>?page=profile&id=3`; `<base target="_top">`; `go()` = `window.open(url, "_top")` | Navigating inside the iframe would load the app inside itself |
| `confirm()` / `prompt()` / `alert()` | In-page dialog (`ask()`), including "type ERASE to confirm" | Browsers may block dialogs from the sandboxed iframe |
| `<a download>` | Same, plus a "Didn't download? Show the contents" fallback | Some browsers block downloads from sandboxed iframes |
| `<meta name="viewport">`, `<title>` | `addMetaTag('viewport', …)` and `setTitle()` in `doGet` | Apps Script ignores these tags inside the page |
| Photos resized to 320 px JPEG | Reduced step by step until they fit in one cell (≤ 48,000 characters) | Sheets allows at most 50,000 characters per cell |

## Security

As in `../clasp`, `appsscript.json` sets `"access": "ANYONE_ANONYMOUS"` and `"executeAs": "USER_DEPLOYING"`. **Anyone with the link can read and change the class records, including children's names and parents' phone numbers.** The server validates every input, but it can't tell who is calling.

To restrict access, change `webapp` to one of these:
- `{"executeAs": "USER_ACCESSING", "access": "ANYONE"}`: only people you share the Sheet with can use the app.
- `"access": "DOMAIN"`: only accounts in your Google Workspace.

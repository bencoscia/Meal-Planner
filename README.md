# Pantry Planner — Project Index

**This is the orientation document.** Read this first for what the project is and why it's built the way it is. For the exhaustive technical reference (data model, sync internals, every function, known bugs and fragility points) needed to actually audit or rebuild the code, see **AUDIT.md**.

---

## 1. Product Overview

A household meal-planning tool for a family of two adults + two young children. Single household, two users (spouses) on separate phones, kept in sync. Core loop: track what's in the pantry → generate a week of AI-suggested dinners → maintain a shared, store-aware grocery list that can also be updated by voice via Siri.

Three peer views (not a wizard): **Meal Plan** (home), **Inventory**, **Grocery**. Preferences and Settings are modals reachable from the header, not steps in a flow.

---

## 2. Non-Negotiable Architectural Constraints

- **Single HTML file.** No build step, no bundler, no npm, no framework. Everything — HTML, CSS, JS — lives in one `index.html`. This is deliberate: it's hosted on GitHub Pages by a non-developer end user who edits and redeploys by hand.
- **No dependencies beyond a Google Fonts `@import`.** Vanilla JS, string-concatenation templating (`innerHTML` replacement), no virtual DOM, no JSX.
- **Deployment target:** GitHub Pages (static hosting) at `<user>.github.io/<repo>`, file must be named `index.html` at repo root.
- **Backend:** a single Google Apps Script (`apps-script.js`) deployed as a Web App, backed by one Google Sheet. This is the entire sync layer — there is no real database.
- **AI provider:** Google Gemini API, called directly from the client with a user-supplied API key (no server-side proxy). This was a deliberate choice after the Anthropic API was tried first and failed — direct Anthropic API calls from inside an artifact/editor sandbox were categorically blocked, which is what motivated moving to a fully standalone HTML file in the first place. See AUDIT.md §9 for detail.
- Any rebuild must preserve the single-file constraint. Do not suggest splitting into modules/bundling unless explicitly asked — that would break the deployment model this was built for.

---

## 3. File Manifest

| File | Role |
|---|---|
| `index.html` | The entire application — all HTML/CSS/JS |
| `apps-script.js` | Backend, pasted into Google Apps Script's editor, bound to a Google Sheet |
| `AUDIT.md` | Deep technical reference: data model, sync architecture, feature internals, known bugs and gaps |

The Google Sheet has one tab named `sync`. Cell **A1** holds the *entire app state* as a single JSON blob. There is no relational structure — see AUDIT.md §5.

---

## 4. Where to Go Next

- **Auditing or modifying the code?** → AUDIT.md, all of it. It's written specifically so odd-looking patterns (guards inside `render()`, `text/plain` content-type on sync POSTs, the shallow-merge-vs-atomic-append split in the Apps Script) aren't mistaken for bugs — they're fixes for real, reproduced failures.
- **Just orienting yourself on what this app is?** → this document is enough.
- **Setting up the Siri integration or redeploying the backend?** → AUDIT.md §8 and §10.

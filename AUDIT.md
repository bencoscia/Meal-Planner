# Pantry Planner — Audit Reference

**This is the deep technical reference.** For product background and the "why" behind the architecture, see **INDEX.md** first. This document gives a model with zero prior context enough detail to either (a) rebuild the app from scratch in one shot, or (b) audit the existing code intelligently — including recognizing which odd-looking patterns are intentional fixes for real bugs, not accidents. §8 (Known Fragility Points) and §9 (Known Gaps) are written by the original author and should be trusted over anything an audit "discovers" that overlaps with them.

---

## 1. Data Model — the `S` object

Everything is one global mutable object, `S`. There is no framework-managed state; every mutation is a direct assignment followed by an explicit `render()` call (or a deliberate *skip* of render — see §2).

```js
const S = {
  // Navigation
  view: "plan",              // "plan" | "inventory" | "grocery" — peer tabs, not a wizard
  showSettings: false,        // modal toggle
  showPreferences: false,     // modal toggle
  theme: "slate",              // one of THEMES[].id — local-device only, NOT synced

  // Inventory (pantry checklist)
  inventory: [],               // [{id, name, qty, category, stocked}]
  newItem: {name:"", qty:"", category:"Produce"},

  // Preferences
  dietPrefs: [],                // array of DIET_OPTIONS[].id strings
  household: [ /* see below */ ],
  avoid: "banana, avocado",     // free-text comma list
  fixedMeals: [{id, day, mealType, description}],
  showFixedForm: false, newFixed: {day, mealType, description},
  quickMeals: {breakfast:[...strings], lunch:[...strings]},
  newQuick: {breakfast:"", lunch:""},

  // Meal plan
  mealPlan: null,               // {days:[{day, dinner:{name,ingredients,recipe,nutrition}}], shopping_list:[...]}
  loading: false,
  regenDay: null,                // day name currently regenerating, for UI lock
  generateError: "",
  expandedDay: null,             // accordion state for non-hero day cards
  dayInstructions: {},           // {[dayName]: freeText} — per-day steering note, EPHEMERAL (not persisted/synced)
  missingIngredients: [],        // [{text, invId|null}] — recipe ingredients the user marked "don't have";
                                 // EPHEMERAL like dayInstructions. invId records which pantry item the
                                 // action unstocked, so undo restores exactly that item and nothing else.
  generation: null,              // generate-preview-commit slot (see §4a) — EPHEMERAL, never persisted/synced:
                                 // {id, day, steering, candidate:{dinner,shopping_list}, status:"preview"|"committed", createdAt}

  // Grocery
  groceryList: [],               // [{id, text, checked, source, store}]
  newGroceryItem: "",
  newGroceryStore: "grocery",    // sticky selector for the add-row — does NOT reset after add

  // Settings (draft object used while modal is open, so typing doesn't
  // commit until you tap Save — API keys especially should not "live save")
  settingsDraft: {geminiKey, scriptUrl, userName, promptWeek, promptDay},

  // Sync
  scriptUrl: "", userName: "",
  syncing: false, lastSynced: null, syncError: "",
};
```

**Household member shape:**
```js
{id, name, type, age, sex, height, weight, unit, activity, goal}
// type: "adult" | "child" | "toddler" | "infant"
// unit: "imperial" | "metric"
// activity: "sedentary" | "light" | "moderate" | "active" | "very_active"
// goal: "lose" | "maintain" | "gain"
```
`calcTDEE(member)` computes a rough daily calorie target (Mifflin-St Jeor for adults, a flat age-based estimate for all non-adults) and feeds a summary into the AI prompt context. **Contract: it returns `null` — rendered as "unknown" by `householdNutritionSummary` — whenever the inputs can't support a real number** (adult missing weight/height, non-adult missing age, or any computed value below a 500 kcal sanity floor). It must never emit a garbage number: an earlier version routed toddlers ≥2 through Mifflin-St Jeor via an operator-precedence bug (`a||b&&c`) and computed *negative* targets for members lacking biometrics, which went straight into the AI prompt. `addMember()` seeds the full member shape (blank biometrics) for the same reason — one object shape everywhere. **See §9 — the UI to edit sex/height/weight/activity/goal was lost at some point; only name/type/age are currently editable in `renderPreferencesModal`, even though the data model and calculation still support the full set.**

**Grocery item shape:**
```js
{id, text, checked, source, store}
// source: "manual" | "siri" | "plan" | "pantry"  (where it came from — display only)
// store:  "grocery" | "costco" | "either"          (where to buy it — user-editable, cycles on tap)
```
Items with `store:"either"` are rendered in **both** store sections simultaneously (same underlying object, same `id` — checking it off in one place checks it off everywhere). New items from `plan`/`pantry`/`siri` sources default to `store:"either"` since the system has no signal about user intent; manual adds default to `store:"grocery"` but the add-row has a cycling selector.

**Inventory item shape:**
```js
{id, name, qty, category, stocked}
```
`stocked` defaults to **stocked** when absent (`isStocked(item) => item.stocked !== false`) — this matters because inventory data synced before this field existed has no `stocked` key at all, and it must not suddenly render as "everything is out of stock."

---

## 2. Rendering Architecture

There is no diffing. `render()` rebuilds the visible view via `innerHTML` string replacement every time it's called. Two non-obvious guards exist inside it and **must be preserved in any rebuild** — both were added to fix real, reproduced iOS bugs, not defensive paranoia:

```js
function render(){
  const active = document.activeElement;
  const isTyping = active && (active.tagName==="INPUT"||active.tagName==="TEXTAREA");
  if(isTyping){ S._pendingRender=true; return; }   // ← Guard 1
  S._pendingRender=false;
  const scrollY = window.scrollY;                   // ← Guard 2 (save)
  let html = renderHeader()+renderTabs()+renderError();
  /* ...view routing... */
  document.getElementById("app").innerHTML = html;
  window.scrollTo(0, scrollY);                       // ← Guard 2 (restore)
}
```
- **Guard 1 (focus guard):** replacing `innerHTML` while an `<input>`/`<textarea>` has focus dismisses the iOS keyboard mid-keystroke. The fix: if the user is actively typing, *skip* the render and set a flag; a `focusout` listener flushes the pending render ~100ms after the field blurs. **Consequence for any new input field:** it must update `S` directly on `oninput` (no render call) and only trigger the real mutation/sync/render on `onchange` (blur) or an explicit action like pressing Enter. Every text input in this app follows that split. Violating it reintroduces the keyboard-dismissal bug.
- **Guard 2 (scroll restore):** an `innerHTML` swap resets scroll position to the top. Saving and restoring `window.scrollY` around the swap was the fix for "the page keeps snapping to the top while scrolling."
- **Guard 3 (modal scroll):** `.settings-panel` (Settings AND Preferences modals) is an inner scroll container (`max-height:90vh; overflow-y:auto`). Guard 2 preserves page scroll, but the `innerHTML` rebuild recreates the panel and resets its `scrollTop` to 0 — any onchange-triggered render snapped the modal to the top. Fix: capture each panel's `scrollTop` by index before the swap, restore after (indices are stable: render always emits Settings then Preferences).
- **Composer focus restore (`renderKeepComposer(day)`):** a targeted wrapper around `render()` used only by `generateCandidate`. The steering composer input has a stable `id="composer-<day>"`. Two problems it solves: (1) if the composer is focused when generation starts (Enter-key path, or an iOS tap that has not blurred yet), Guard 1 would silently *skip* the render and the "Regenerating…" state would never paint — so it blurs first; (2) the `innerHTML` swap destroys the focused input, dismissing the keyboard mid-edit — so it restores focus + cursor onto the rebuilt element. Net effect: steering text survives generation, stays editable throughout, and can be tweaked and re-run without re-tapping into the field.

**View routing** is a simple if/else on `S.view`, with `S.loading` taking priority (shows a spinner state), and Settings/Preferences modals appended unconditionally at the end (they self-hide via `if(!S.showX) return ""` inside their own render functions). There is **no** router library, no history/back-button integration — `S.view` changes don't touch the URL.

**Historical note:** this used to be a 3-step numbered wizard (`S.step`, 1→2→3, with a `goToStep()` and `renderStepper()`) gating Inventory → Preferences → Meal Plan in sequence. It was deliberately torn out in favor of peer tabs because the actual usage pattern isn't sequential — Preferences is touched rarely, Inventory/Grocery are touched constantly, and forcing a detour through Preferences just to reach "what's for dinner" was bad UX for a tool used daily. If an audit finds no trace of stepper logic, that's correct — it was fully removed, not hidden.

---

## 3. Persistence & Sync Architecture

### Local storage helper
```js
function ls(k, v) {
  if (v === undefined) { /* read + JSON.parse, or null */ }
  else { /* v===null removes the key; otherwise JSON.stringify + set */ }
}
```
Every persisted key goes through this. Full list of keys currently written: `inventory, dietPrefs, household, avoid, fixedMeals, mealPlan, quickMeals, promptWeek, promptDay, groceryList, geminiKey, scriptUrl, userName, theme`.

### What syncs between devices vs. what's local-only
```js
const SYNC_KEYS = ["inventory","dietPrefs","household","avoid","fixedMeals",
                   "mealPlan","quickMeals","promptWeek","promptDay","groceryList"];
```
**Local-only, never synced:** `geminiKey` (secret, per-device), `scriptUrl`/`userName` (bootstrap config, per-device), `theme` (visual preference, deliberately per-device so spouses can pick differently), `dayInstructions` (ephemeral one-off steering note, not even persisted to localStorage), `missingIngredients` (ephemeral for the same reason — once you shop, the exclusion should evaporate rather than silently haunt future prompts; the inventory *unstock* side-effect it triggers IS synced, via the normal inventory path), and `generation` (the preview slot — by design, a rejected preview must leave zero trace anywhere; see §4a).

### The sync loop
- `setAndSync(key, value)` — the standard mutator used everywhere: sets `S[key]`, mirrors to `ls()`, calls `pushSync()`, then `render()`.
- `pushSync()` — **debounced 1000ms**. Builds `{updatedBy: S.userName, ...every SYNC_KEYS value}` and `POST`s it as `Content-Type: text/plain` (see §8 for why `text/plain` and not `application/json`) to `S.scriptUrl`.
- `fetchSync()` — `GET`s `S.scriptUrl`, and for every key in `SYNC_KEYS` present in the response, overwrites `S[key]` and mirrors to `ls()`. Runs on load, on a 60-second `setInterval` (`startPolling`), and on a manual ↻ button.
- **Lost-update guard in `fetchSync` — checked TWICE, at start and at apply time:** if a debounced push is armed (`syncTimer` non-null) or a push POST is in flight (`pushInFlight`), `fetchSync` returns without applying anything. Without this, a poll landing inside the 1s debounce window would overwrite a fresh local edit with stale remote state, and the pending push would then persist that stale state to both devices — a silent lost update. `syncTimer` is nulled when the debounce fires; `pushInFlight` brackets the actual POST. **The start-time check alone was insufficient**: the poll's GET takes real time, and edits made *while it was in flight* (reproduced: rapidly unchecking inventory boxes, which then visibly re-checked themselves when the stale response applied) slipped through if the debounce had already fired and the push completed before the GET returned. Fix: a monotonic `editSeq` counter bumped in `setAndSync`; `fetchSync` snapshots it before the fetch and discards the response if `syncTimer || pushInFlight || editSeq` changed by apply time. Skipping a poll cycle is harmless (the next one catches up); do not remove either check.
- Sync status is shown via a colored dot + text in the header (`renderHeader`), and that text is refreshed on a separate **30-second** timer **without a full re-render** — a targeted DOM patch was necessary here specifically so the periodic tick doesn't dismiss the keyboard via Guard 1 above. (The state-sync poll itself remains 60s; these are two different intervals.)

### Google Apps Script contract (`apps-script.js`)
One sheet tab `sync`, cell A1 = the entire JSON state blob.
```
doGet(e)  → returns cell A1's raw content as JSON
doPost(e) → parses e.postData.contents as JSON, then:
              if incoming.action === "addGrocery": atomic server-side append (see below)
              else: shallow Object.assign(existing, incoming, {lastUpdated, lastUpdatedBy})
```
**Every `doPost` call is wrapped in `LockService.getScriptLock()`.** This exists specifically because a Siri-triggered `addGrocery` call and a normal app `pushSync()` can land within the same second, and without a lock, a naive read-modify-write race could let one silently clobber the other's write.

`addGrocery` action (used exclusively by the Siri Shortcut) does **not** go through the shallow-merge path — it reads the current `groceryList`, appends new item(s) server-side, and writes back, all inside the lock. It also splits on commas (`"milk, eggs, bread"` → 3 separate items) and dedupes case-insensitively against existing items. New items get `store: "either"`.

---

## 4. Feature Modules

### Inventory (`renderInventory`)
A **persistent checklist**, not an add/delete list. Items never disappear when you run out — you uncheck them (`stocked:false`), and they stay visible (italic, "Out" badge) so you can restock later. **Every** item row has a **"+ Grocery"** button (disabled "✓ In list" when already present) — stocked items included, so a repurchase can be queued before actually running out. Unchecking additionally surfaces the bulk **"🛒 Add N unstocked"** button in the toolbar. Name and quantity are inline-editable `<input>`s styled to look like plain text until focused (same oninput/onchange split as Guard 1 requires).

**Load-bearing correctness detail:** the AI meal-plan generator only considers `isStocked(item)===true` inventory as "what's in the pantry." Unchecking an item isn't just cosmetic — it changes what the AI assumes you have.

Wide-screen layout: pantry categories render into `.pantry-grid` (`grid-template-columns:repeat(auto-fit,minmax(260px,1fr))`), letting multiple category cards sit side-by-side on desktop while collapsing to one column on narrow viewports automatically (no separate media query needed for the column count — `auto-fit` handles it).

### Grocery (`renderGrocery`)
One data list, rendered into **two overlapping sections** — "🏪 Grocery Store" and "📦 Costco" — by filtering on the `store` field. An item tagged `either` appears in both. Each item has a cycling pill (`cycleGroceryStore`, order: grocery → costco → either → …) instead of a dropdown, for one-tap mobile changes. Checked items collapse into a single flat "Checked off" section at the bottom (not split by store — once purchased, the distinction stops mattering) with a "Clear checked" bulk action.

Voice input arrives via the Siri Shortcut → Apps Script `addGrocery` action (see §3) and appears here on the next sync poll.

### Meal Plan (`renderPlanTab`) — the home view
- If `S.mealPlan` is null: shows a config summary line + a centered "✨ Generate Meal Plan" CTA.
- If a plan exists: a **preferences summary bar** at the top (`renderPrefsSummary` — "2 adults, 2 kids · avoiding banana, avocado · 1 fixed meal — Edit", the "Edit" link opens the Preferences modal), then:
  - **Hero card** — `heroDayName()` picks the featured day: today's weekday name until `HERO_ROLLOVER_HOUR` (a code constant, currently 20:00 local — deliberately no Settings knob), after which it rolls to the *next* day, because by evening tonight's dinner is settled and the useful glance is tomorrow's. Week wrap is free: the rollover adds a day to a `Date` and reads its weekday name, and plan days are floating weekday labels, not calendar dates (no date-tracking anywhere in the app). The section label and the card's "Today · "/"Tomorrow · " prefix follow `heroDayName()` vs `todayDayName()` — the state is carried in text. Always expanded, visually distinguished (`.hero-day` — thicker accent border, larger day name).
  - **"This Week"** — the other 6 days, in a `.week-grid` (same `auto-fit` grid pattern as Inventory), each collapsible, each with its own small ↻ regenerate button.
  - **Ingredients render as a column list** (`.ing-list`, `auto-fit` grid of one-per-row `.ing-row`s), not wrapping pill tags. Each row has an **"∅" toggle** ("don't have this"): tapping it (1) fuzzy-matches the ingredient against inventory (case-insensitive substring either direction, both sides ≥3 chars) and marks the matched item unstocked (synced — which also drops it from the PANTRY prompt line automatically), and (2) records it in `S.missingIngredients`, injected into both the `{CONTEXT}` AVOID line and the hard-constraint system prompt (§5) on the next generation. Marked rows show strikethrough + italic + a "✕ excluded" badge (glyph/text carries the state, per the protanopia rule). Tapping again undoes both — including restocking *only* the exact item the original tap unstocked (`invId`). **Security invariant preserved:** the row's `onclick` interpolates only the whitelisted day name and a numeric index — never AI-supplied ingredient text (same reasoning as `normalizeDays`).
  - Every day card (hero or not) has an inline **steering composer**: a text field + "↻ Redo" button ("Want something different for Tuesday?"). Text typed here is folded into that single day's generation prompt as `SPECIAL REQUEST FOR THIS MEAL`. **This state (`S.dayInstructions`) is intentionally ephemeral** — not persisted, not synced, resets on reload. It's a one-off nudge, not a standing preference. The field is never cleared or disabled by a generation, and `renderKeepComposer` (§2) keeps it focused across the generation renders. **As of the steering rework, Redo no longer writes directly — it produces a preview (§4a).**

### §4a. Generate → Preview → Commit steering (per-day)

**Invariant, enforced in one place:** the committed plan (`S.mealPlan`) is the only persisted state, and `commitGeneration(id)` is the **only** code path that moves a candidate into it. `regenSingleDay`'s old write-through behavior was deleted, not wrapped — grep for any other writer of `S.mealPlan` from candidate data; finding one is a regression.

**Flow:** ↻ Redo / ↻ header button / Enter in the composer → `generateCandidate(day)` → Gemini call → `cleanJson` → **`validateCandidate` schema gate** (dinner.name string, ingredients/recipe arrays, nutrition object-or-null; anything else throws → user-facing error, current plan untouched — a candidate validates completely or not at all, never a partial write) → the validated candidate lands in `S.generation`:

```js
{ id, day, steering, candidate:{dinner, shopping_list}, status:"preview"|"committed", createdAt }
```

- `id` is generated **locally** (`"gen-<ts>-<rand>"`), never derived from AI output — it is interpolated into the Accept/Discard `onclick`s.
- One slot only: a new generation (same day or another) replaces the open preview, which is what makes "steer, reject, steer again, commit" a linear loop.
- **Preview renders as a diff** (`renderPreview`, inside the day card): current meal struck through → candidate name, full candidate detail (rendered *without* ∅ buttons — their indices would target the committed plan, not the candidate), the steering text that produced it, and the shopping-list delta. State is carried by a dashed border + "PREVIEW — NOT SAVED" label + strikethrough/arrow, never color alone. **The preview REPLACES the committed meal display in the card** (the diff line still names the old meal) and **forces the card open** regardless of accordion state — accept/reject is a decision the user must be able to see. On completion, `generateCandidate` calls `scrollIntoView({block:"nearest"})` on the panel so the "it finished" signal comes to the user; `nearest` makes it a no-op when already visible, so it never fights Guard 2's scroll restore.
- **The composer input is `disabled` while its day is regenerating.** The steering text is snapshotted into the generation record when the request launches, so mid-flight edits cannot affect the pending candidate — an editable field would lie about that. Consequence: `renderKeepComposer`'s refocus leg is effectively inert at regen *start* (you can't focus a disabled input); its load-bearing job there is the blur-before-render that stops Guard 1 from swallowing the "Regenerating…" paint.
- **`commitGeneration(id)`** no-ops unless `S.generation.id === id && status === "preview"`; on success it swaps the candidate's dinner into the day **by reference** (byte-for-byte — no re-serialization), merges only *new* shopping items, does exactly one `setAndSync`, and nulls the slot. Idempotency is via absence: a double-tap's second call finds no matching preview. Atomicity at the persistence layer is structural (whole app state is one JSON blob).
- **`rejectGeneration(id)`** nulls the slot. Zero trace: nothing was ever written to localStorage or the sync blob.
- A full-week generate discards any open preview (a diff against a plan that no longer exists is meaningless). A sync poll changing `mealPlan` under an open preview is harmless: commit replaces the target day wholesale by day name, and the diff's "current" side re-renders from live state.
- Shopping-list parity note: like the old flow, commit only *adds* items (§9's known gap about per-day provenance still applies).
  - Shopping list, then the **Quick Meals** bank (breakfast/lunch idea lists — these are NOT AI-generated; they're a manually-curated pick-list since breakfast/lunch don't need the same planning weight as dinner).

### Preferences (`renderPreferencesModal`)
A modal (same visual pattern as Settings — `.overlay` + `.settings-panel`), reached via a header button, **not** a step in the flow. Contains: dietary toggles, household member editor (name/type/age only — see §9), avoid-ingredients free text, fixed-meals list/editor. All fields **live-save** via `setAndSync` on change — there's no separate "Save" step for this data (only the "Done" button, which just closes the modal). Contrast with Settings, which uses a `settingsDraft` object specifically so typing an API key doesn't commit/sync every keystroke.

### Settings (`renderSettings`)
Modal: Appearance (theme picker), AI (Gemini key), Sync (script URL + display name), Prompts (editable `promptWeek`/`promptDay` textareas — see §5), Data (a "Reset household to defaults" button, added because a corrupted/incompletely-migrated household object had no other recovery path).

---

## 5. AI Integration

**Provider:** Gemini, called directly from the browser:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}
```
No server proxy — the key lives in the user's `localStorage` only, entered via Settings, never committed to the repo. **Model name is a known fragility point** — Gemini 1.5 models were fully retired mid-project and returned 404s; `gemini-2.5-flash` is current as of this build but model names churn and this is a hardcoded string with no fallback/discovery logic.

**Why full-week generation is split into two parallel calls** (`generatePlan`): a single 7-day request with full recipes/nutrition JSON reliably hit the token ceiling and returned truncated, unparseable JSON. The fix was splitting into Monday–Thursday and Friday–Sunday, requested via `Promise.all`, then merged and day-sorted client-side. `maxOutputTokens` is set to Gemini 2.5 Flash's ceiling (65536) as additional headroom.

**Hard-constraint system prompt:** `hardConstraintsSystem()` builds a `systemInstruction` for every Gemini call (per-day and full-week) carrying DIET, AVOID, and MISSING as "non-negotiable — override anything in the user message." This exists so free-text steering in the user turn ("make it cheesier", or worse, "ignore the allergy list") cannot silently override allergies/diet. The same constraints intentionally remain inside `{CONTEXT}` — the redundancy keeps user-saved custom templates working unchanged and costs nothing.

**Prompt template system:** two editable templates, `DEFAULT_PROMPT_WEEK` and `DEFAULT_PROMPT_DAY`, stored as constants but **overridable per-user** via `S.promptWeek`/`S.promptDay` (synced, editable in Settings → Prompts, with a "Reset to default" link each). Placeholders are simple string `.replace(/\{TOKEN\}/g, ...)` substitution, not a templating engine:

- `{DAYS}` — comma list of day names for this batch
- `{CONTEXT}` — pantry/diet/avoid/household/nutrition-target block, assembled in JS before substitution
- `{DAY}` / `{FIXED}` / `{EXISTING}` / `{INSTRUCTION}` — single-day-regen only: the target day, its fixed-meal constraint if any, a "don't repeat these" list of the week's other dinners, and the per-day steering note from §4
- If a *saved custom* `promptDay` predates the `{INSTRUCTION}` placeholder (i.e., doesn't contain the token), `regenSingleDay` **appends** the instruction line rather than silently dropping it — a defensive fallback for prompt-template drift.

Both templates end with an explicit JSON schema and "no markdown" instruction. This is load-bearing, not decoration — Gemini reliably drifts into prose or malformed JSON without it. **The two schemas must stay in parity for the `dinner` object** (including `nutrition`): `regenSingleDay` replaces a day's dinner wholesale, so any field present in the week schema but missing from the day schema silently disappears from that day on regeneration. (This happened with `nutrition`; it's fixed in the default, but a *saved custom* `promptDay` predating the fix still has the old schema — "Reset to default" in Settings → Prompts cures it.)

**`normalizeDays(days)`** — validation of AI-supplied day names at the single point where they enter the plan (`generatePlan`, after `cleanJson`). Every `day` string is matched case-insensitively against the `DAYS` whitelist and rewritten to canonical casing; non-matching days are dropped, and an empty/missing array throws a user-facing error. This is load-bearing for two reasons: (1) **security** — day strings are later interpolated into single-quoted inline `onclick` handlers and used as `dayInstructions` object keys, contexts `esc()` doesn't fully cover, so validation (not escaping) is the invariant; (2) **correctness** — a lowercase `"monday"` from Gemini previously sorted to the end (`indexOf === -1`) and never matched the hero "Today" card. Days coming through `regenSingleDay` don't need re-validation — the day parameter originates from the already-normalized local plan. (Residual: a plan synced from *before* this existed isn't re-validated; a full-week regenerate clears it.)

**`cleanJson(text)`** — a top-level defensive parser (must stay top-level; it was once nested inside `generatePlan` and broke when `regenSingleDay` tried to call it from outside that scope). Strips ` ```json ` fences, extracts the first `{...}` span if there's surrounding prose, converts literal `\n`/`\t`/`\r` escape sequences and raw control characters to spaces, and strips trailing commas before `}`/`]`. Throws a clean user-facing error ("Could not parse AI response. Please try regenerating.") rather than surfacing a raw `JSON.parse` position error if all of that still fails.

---

## 6. Design System

**Typography:** IBM Plex Sans (headers/body, weights 400–700) + IBM Plex Mono (anything measured: quantities, macros, day labels, sync timestamps). Deliberately chosen to move away from the "warm cream + terracotta + serif-italic" look, which is a well-documented generic-AI-design default.

**Theme system:** CSS custom properties on `:root` (default = Slate) with `[data-theme="x"]` override blocks. `document.body.dataset.theme` is set by `applyTheme()` on load and by `setTheme(id)` on user selection. Token set per theme (15 variables): `--bg --surface --border --text --muted --accent --accent-light --accent2 --accent2-light --danger --danger-bg --danger-border --warn --warn-bg --warn-border --header-bg --header-text --header-muted`. **Every** color in every component rule derives from these tokens — there are no hardcoded hex literals in component CSS **or in JS-generated inline styles** (audit note: if you find one, it's a regression — the last four found were `#b8a898` remnants of the old warm theme, hiding in `renderHeader` and the 30s header patch, not in the stylesheet; there was a deliberate pass to eliminate hardcoded pastel colors from the nutrition badges, error banners, and status dots specifically because they broke visually under the dark themes otherwise).

Seven themes ship: **Slate** (cool default), **Ink** (warm dark), **Cobalt** (cool dark), **Citrus** (bright/warm), **Clay** (muted/warm-sophisticated), **Birch** (soft/minimal-violet), **Fog** (minimal/denim). **Deliberately avoid pairing red and green as a meaningful signal anywhere**, in any theme — the end user has protanopia. State (checked/unchecked, stocked/out, sync live/error) is always carried by a glyph, badge text, italics, or strikethrough *first*, with color as reinforcement only, never the sole signal.

**Signature interactive element:** the checkbox (Pantry + Grocery). An empty bordered square that fills solid with `var(--accent)` and reveals a white inline-SVG checkmark (not a Unicode glyph — font-dependent glyph weight/shape was inconsistent) on check, with a quick scale-in transition. (An earlier version tried a rotated Unicode ✓ with a text-shadow to fake a "rubber stamp" look; it read as visually broken rather than intentional and was replaced.)

**Layout:** `.content` max-width 1140px, but individual form-style `.card`s (add-item rows, quick-add) are separately capped at 720px and centered — widening the outer container without this would have stretched text inputs across the full page width. Multi-item lists (`.week-grid`, `.pantry-grid`) use `grid-template-columns:repeat(auto-fit,minmax(Npx,1fr))` specifically so they reflow to the right column count at any width without extra breakpoints.

**Tab bar:** styled as bold "index tabs" (folder-tab metaphor — raised/bordered when active, flush otherwise), not thin underlines, matching the app's "labeled kitchen system" identity.

---

## 7. Siri / Shortcuts Integration

An iOS Shortcut named **"Groceries"** (so "Hey Siri, Groceries" invokes it): Ask for Input (text) → "Get Contents of URL" POST to the Apps Script URL with JSON body `{action:"addGrocery", text:<input>}`. The Shortcut has no knowledge of the app's internal data model beyond that one action contract. See §3 for the server-side atomicity guarantee this relies on.

**Operational discipline required:** updating `apps-script.js` must go through **Deploy → Manage deployments → edit (pencil) the existing deployment → Version: New version → Deploy**, never "New deployment" — the latter generates a new URL and silently breaks both the app's `scriptUrl` setting and the Shortcut, which have the old URL baked in.

---

## 8. Known Fragility Points (from direct build experience, not speculation)

These aren't guesses — every one of these caused a real, reproduced failure during development:

1. **Model name churn.** Gemini model strings are hardcoded and have already changed once (1.5 → 2.5) mid-project with no warning beyond a 404. No version-discovery fallback exists.
2. **CORS requires `Content-Type: text/plain`** on the sync `POST`, not `application/json` — Apps Script web apps otherwise trigger a preflight that fails. This is easy to "fix" by reverting during future edits without realizing why it breaks.
3. **The Claude/editor preview sandbox blocks outbound fetches to `api.anthropic.com` and third-party APIs entirely** — this app's Gemini calls and Google Sheets sync only work on the actual deployed GitHub Pages URL, never in an in-editor preview. (This is also *why* Gemini is used instead of the Anthropic API at all — see INDEX.md §2.)
4. **String-concatenation templating is fragile to hand-edit.** Several real bugs during development were stray extra `+`, mismatched quotes, or a nested template-literal backtick inside an outer backtick string. Any edit to the render functions should be followed by extracting the `<script>` block and running `node --check` on it before considering the change done.
5. **`isStocked()`'s "undefined means stocked" default is load-bearing**, not a style choice — it exists specifically so inventories synced before the `stocked` field existed don't all render as suddenly out-of-stock.

## 9. Known Gaps / Things an Audit Should Actually Flag

Being direct about real debt, as opposed to the fragility points above (which are handled, just worth knowing about):

- **Household nutrition editing UI is incomplete relative to the data model.** `calcTDEE`, `toKg`, `toCm`, `householdNutritionSummary` all exist and are fed into the AI prompt context, and the default household objects carry `sex/height/weight/unit/activity/goal` — but `renderPreferencesModal`'s member editor only exposes `name`/`type`/`age`. There's no UI path to actually set or change the other fields for a real (non-default) household member. This should either be restored or the unused calculation code should be removed. (`calcTDEE` now at least fails honest — members with missing biometrics produce "unknown" in the prompt instead of a computed-from-defaults or garbage number — but the editor gap itself remains.)
- **Single-day regeneration only grows the shopping list.** `regenSingleDay` merges the new meal's `shopping_list` items in but never removes the replaced meal's items — regenerate the same day a few times and ingredients from every discarded version coexist. Fixing it properly needs per-day provenance on shopping items; low value for the cost. Practical rule: the shopping list is authoritative right after a full-week generate, advisory after per-day regens (users can delete rows by hand).
- **API key stored in plaintext in `localStorage`**, readable by any script that runs in that origin. Acceptable for a single-family personal tool, worth flagging in any general-purpose security audit.
- **No input validation on the Apps Script side** beyond `JSON.parse` succeeding — a malformed payload from anywhere (not just the two known clients) would silently corrupt the shared state blob with no schema check.
- **`dayInstructions` and `theme` are the only two pieces of "preference-shaped" state that are deliberately not synced.** This was a judgment call (steering notes are one-off; theme is personal taste), not an oversight — but worth confirming still matches user intent if requirements evolve.

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
  mealPlan: null,               // {days:[{day, dinner:{name,ingredients,recipe,nutrition}}], shopping_list:[{text,day|null}]}
                                 // shopping items carry provenance: day = the steering commit that produced it,
                                 // day:null = full-week generate. Legacy plans hold plain strings — shopText()
                                 // is the single read-side normalizer; no migration pass (see §4a).
  loading: false,
  regenDay: null,                // day name currently regenerating, for UI lock
  generateError: "",
  expandedDay: null,             // accordion state for ALL day cards incl. Today (one open at a time)
  recipeOpen: {},                // {[day | "preview"]: true} — recipe steps expanded; session-only, default collapsed
  dayInstructions: {},           // {[dayName]: freeText} — per-day seed/steering text. ONE source for both the
                                 // "Seed the week" panel and each day card's composer. PER-DEVICE localStorage,
                                 // NOT synced (was ephemeral; persisted so an iOS reload can't eat 7 typed ideas).
                                 // Keys whitelisted against DAYS on load (sanitizeDayInstructions).
  showSeeds: false,              // seed panel expanded (plan-exists view) — session-only
  invSearch: "",                 // inventory search query — session-only
  invReview: {},                 // {[itemId]: "check"} — "? Check" flags only (Need is derived from the grocery list). PERSISTED + SYNCED.
  invReviewMode: false,          // Inventory tab in review mode — PER-DEVICE localStorage
  invEdit: null,                 // {id,name,qty,category} drafts for the inventory row being edited — session-only
  invUndo: null,                 // {item,index} last deleted pantry item (undo toast) — session-only
  showInvAdd: false,             // inventory add form expanded — session-only
  invReviewFilter: "all",        // "all"|"check"|"onlist" — PER-DEVICE localStorage (invReviewMode too)
  invOpenCats: [],               // expanded inventory category names — PER-DEVICE localStorage
  invStockFilter: "all",         // "all"|"have"|"out" — normal-mode Inventory filter — session-only
  missingIngredients: [],        // [{text, invId|null, gid|null}] — recipe ingredients the user marked
                                 // "don't have". PERSISTED + SYNCED (originally ephemeral; iOS PWA reloads
                                 // wiped it between regens, so excluded items came back — the "salmon
                                 // returns" bug). invId = pantry item the mark unstocked; gid = grocery
                                 // entry the mark created. Both exist so undo reverses exactly what the
                                 // mark did. An entry auto-clears when its invId item is restocked.
  editingGrocery: null,          // {id,text,qty} in-progress grocery row edit — session-only draft
  scanning: false,               // paper-list photo → Gemini vision call in flight
  scanResult: null,              // [{text,qty,include}] parsed scan awaiting review — session-only
  scanError: "",                 // scan failure banner text
  scanReview: true,              // PER-DEVICE setting (localStorage, not synced): review scans before adding
  groceryFilter: "all",          // "all"|"grocery"|"costco" — PER-DEVICE trip-mode view filter, persisted
  groceryUndo: null,             // single-slot grocery undo {label,type:"added"|"removed",ids|items} —
                                 // session-only, deliberately NOT synced (the other phone must not be
                                 // able to undo your action). See §4 Grocery.
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
Every persisted key goes through this. Full list of keys currently written: `inventory, dietPrefs, household, avoid, fixedMeals, mealPlan, quickMeals, promptWeek, promptDay, groceryList, missingIngredients, invReview, dayInstructions, scanReview, groceryFilter, geminiKey, scriptUrl, userName, theme`.

### What syncs between devices vs. what's local-only
```js
const SYNC_KEYS = ["inventory","dietPrefs","household","avoid","fixedMeals",
                   "mealPlan","quickMeals","promptWeek","promptDay","groceryList",
                   "missingIngredients","invReview"];
```
**Local-only, never synced:** `geminiKey` (secret, per-device), `scriptUrl`/`userName` (bootstrap config, per-device), `theme` (visual preference, deliberately per-device so spouses can pick differently), `dayInstructions` (per-day seeds/steering text — persisted to localStorage per-device, deliberately not synced: it's draft input, and syncing half-typed text between phones invites confusion), `invSearch`/`showSeeds` (session-only UI state), and `generation` (the preview slot — by design, a rejected preview must leave zero trace anywhere; see §4a).

**`missingIngredients` moved from local-ephemeral to synced.** The original "evaporates when you shop" lifetime was implemented as page-lifetime — wrong: iOS PWA reloads wiped it mid-week and ∅-excluded ingredients reappeared in regens (the "salmon returns" bug). It now persists and syncs (both people share "we don't have salmon"), and the evaporate intent is tied to explicit events instead: restocking the linked pantry item (via `cycleInventoryState` Skip→In stock transition, or the recipe ∅ undo path) or manual ∅ undo clears the entry. Old-version compat is safe in both directions: old `fetchSync` ignores unknown keys, and the Apps Script shallow merge preserves keys absent from an old client's push.

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

**Duplicate policy: every path into the grocery list dedupes case-insensitively** — manual add, plan import, scan add, ∅ mark, bulk-unstocked, undo re-add, and the Siri path (server-side). The one historical hole was the ✎ edit: renaming could mint a duplicate ("chikn"→"chicken" with "chicken" already present). `commitGroceryEdit` now **merges on rename collision**: the edited row wins (its id, checked state, source, store), the other copy is dropped, and a non-empty qty is inherited from either side.

**Store filter (`S.groceryFilter`, per-device, persisted):** a segmented All / 🏪 Grocery / 📦 Costco control with live counts at the top of the Grocery tab — "I'm at Costco, show me only that list." `"either"` items appear under both single-store views (same membership rule the two sections always used). Filter state survives PWA reloads mid-trip; it's never mysterious because the control, its counts, the "N to get at Costco" toolbar text, and a filtered-empty hint ("tap All to see everything") all carry it. Switching to a single-store filter also points the add-row's store selector at that store, so a newly added item can't silently land on the hidden list. **`clearCheckedGroceries` respects the filter** — clearing while viewing Costco never deletes checked items hidden on the other list (and is undoable regardless).

**Grocery items now carry an optional `qty` field** (free text, e.g. "2 lbs"), rendered muted after the name ("salmon · 2 lbs"); absent on old items and harmless to old clients. **Inline edit:** the ✎ button on each row opens name + qty inputs bound to the session draft `S.editingGrocery` (no render while typing — Guard 1); Enter/✓ commits via one `setAndSync`, ✕/Escape cancels. Guards: an empty name never commits; an item deleted remotely mid-edit is not resurrected (edit silently closes).

**Paper-list scanner (photo → Gemini vision → grocery items).** A "📷 Scan paper list" button on the Grocery tab opens a hidden `<input type="file" accept="image/*" capture="environment">` (camera or library; no getUserMedia, works in the PWA). `handleScanFile` downscales the photo on a canvas to ≤1600px JPEG q0.8 (phone photos are 3–12 MB; handwriting OCR needs nowhere near that) and hands base64 to `scanImage`, which calls `callGemini` with a new optional 4th `image` argument (`inline_data` part ahead of the text — `gemini-2.5-flash` is multimodal). The transcription prompt demands strict JSON `{"items":[{"text","qty"}]}`, ignores crossed-out entries, and `validateScan` gates it completely-or-not-at-all (cap 80 items, empty texts dropped). Routing honors the **`scanReview` per-device setting (Settings → AI, default ON — the safe default)**: ON → `S.scanResult` renders a review panel (dashed border, same not-yet-saved language as meal previews) where every row is editable (text + qty) and individually excludable (checkbox with add/skip **text** label plus strikethrough — not color) before "✓ Add N" commits; OFF → items add immediately. Both paths funnel through `addScannedItems` — the single writer: case-insensitive dedupe, `source:"scan"`, one `setAndSync`, and a standard grocery-undo record, so even review-off scans are one tap from reversal. Failures (unparseable JSON, no legible items, all duplicates) surface as an explicit banner and mutate nothing.

**Single-slot undo (`S.groceryUndo` + `undoGroceryAction`)** covers the batch/destructive operations: plan import, bulk-unstocked add, row delete, clear-checked, and scanned-list adds. "added" records the new ids (undo filters them out); "removed" records the full item objects (undo re-appends them with original ids — checked state, qty, and provenance survive the round trip; re-add dedupes by text in case the user re-created one by hand). One level deep by design; each undoable action replaces the slot. Session-only and deliberately not synced. Single adds, ∅ marks, and checkbox toggles are not covered — each already has a one-tap reversal.

**Quantity normalization** happens at two levels. Primary: both default prompt templates now demand `shopping_list` entries be bare base ingredient names ("salmon", not "4 salmon fillets") — the AI does the normalization. Fallback: `stripQty()` at the grocery entry points (`importPlanGroceries`, the ∅ mark's no-pantry-match branch) strips a *leading* count/amount/unit — "2 eggs"→"eggs", "1/2 cup rice"→"rice" — but deliberately never touches trailing form-nouns ("4 salmon fillets"→"salmon fillets", not "salmon"; that judgment call belongs to the AI). It never strips to empty. **Trap: saved custom prompts in localStorage do not pick up the new default wording** — reset prompts in Settings (or hand-edit) to get bare names at the source. Import dedupe now compares post-strip text.

`addGrocery` action (used exclusively by the Siri Shortcut) does **not** go through the shallow-merge path — it reads the current `groceryList`, appends new item(s) server-side, and writes back, all inside the lock. It also splits on commas (`"milk, eggs, bread"` → 3 separate items) and dedupes case-insensitively against existing items. New items get `store: "either"`.

---

## 4. Feature Modules

### Inventory (`renderInventory`)
A **persistent catalog**, not a real-time stock tracker. Items never disappear — they're always visible as a scannable reference.

**Explicit stock (replaces the 3-state In stock → Need → Skip cycle).** Each row has two independent controls: **✓ Have / — Out** (`toggleStock`) and **🛒** (`toggleOnList`). Out = dashed border + italic + "— Out" text; 🛒 on = filled + "✓🛒" (not hue alone).
- **What the planner sees — ONE source:** `plannerPantryItems()` = items that are **on hand** and in a food category; `plannerPantryLine()` builds the PANTRY prompt line from it (both prompt builders), and every on-screen count uses it.
- **On hand is DERIVED:** `onHand(item) = stocked !== false && !onGroceryList(item)`. Items reach the list by paths that never touch stock (manual add, plan import, scan, Siri), so "on the list ⇒ Out" holds by definition, not by trusting every writer. (Caught in a screenshot: Dairy showed "3 on list · 2 out" before this.) Checking an entry off (bought) makes the item on hand again if its stored flag is true.
- **Writers:** `setOnList(id,true)` → `stocked:false` + list entry (re-opens a checked one; clears ? Check). `setOnList(id,false)` → removes unchecked entries, **stock untouched** (taking it off the list ≠ having it). `setStock(id,true)` → `stocked:true` + unchecked entries removed + ∅ links cleared. `setStock(id,false)` → **list untouched** ("don't have it, not buying it" — one tap; previously two taps through Need). Review-mode 🛒 Need calls the same `toggleOnList` (one meaning everywhere).
- **Out is not a ban.** Out items are simply absent from PANTRY; the model may still use one, marked * / 🛒 to buy ("Prioritize pantry" pushes against it). Only ∅ (`missingIngredients`) and Avoid exclude. The old UI text claiming Need/Skip were "excluded from AI meal planning" was wrong and is gone.
- **Non-food categories** (`NON_FOOD_CATEGORIES`: Household, Health & Baby) are never sent to the planner regardless of stock; their open category says "Not used by the meal planner".
- **Empty-pantry trap fixed:** the PANTRY line used to fall back to "assume a well-stocked kitchen" whenever nothing was stocked — so marking everything Out told the model you had everything. Now that fallback applies only to an empty inventory; all-Out sends "Nothing on hand except salt, pepper and cooking oil".
- **Visibility:** a card at the top reads "The meal planner assumes you have N of M food items" with filter chips All / ✓ Have / — Out (`S.invStockFilter`, session-only; forces categories open like any filter). Category heads show "· N out". The Meal Plan prefs summary shows "N pantry items on hand".
- **Bulk per category:** an open category (normal mode) has "All ✓ Have" / "All — Out" (`setCatStock(idx, have)`, index not name). Undo via the toast is **targeted** — restores each item's prior flag, re-adds the grocery entries and ∅ links that call removed — never a whole-array snapshot, so edits synced in between survive. `S.invUndo` is now `{type:"delete",…}|{type:"bulk",…}`; `undoInvDelete` dispatches.
- Removed: the "🛒 Add N skipped" toolbar button (Out now means "not buying"). `cycleInventoryState` and `addUnstockedToGrocery` remain defined but are no longer wired to the UI.

**Rows are read-only; editing and delete live behind the name (Session A).** A row is a name button (name + muted qty) and the state button — no inputs, no ×. Previously every row was two live text inputs plus a 20px × right beside 🛒 Need: a scroll that landed on a name popped the keyboard (and zoomed, §10), and one stray tap deleted an item with no confirm and no undo, synced to both phones. Now:
- **Tap the name → inline editor** (`openInvEdit`): name, qty, category select, ✓ Save / Cancel / 🗑 Delete. No autofocus (opening to delete shouldn't pop the keyboard). Drafts live in `S.invEdit` (oninput, no render — Guard 1); `commitInvEdit` trims, refuses an empty name with an alert (editor stays open), coerces an unknown category to "Other", and is a no-op if the item was deleted remotely mid-edit. All three handlers blur first so Guard 1 can't swallow the render.
- **Delete → undo toast** (`deleteInvItem` / `undoInvDelete`): single slot `S.invUndo = {item, index}`; undo re-inserts at the original index and is a no-op if the item already came back (e.g. via sync). The slot is dropped on tab switch. Session-only by design.
- **Add form collapsed** behind a "+ Add item" button (`S.showInvAdd`); always open when the inventory is empty. Search's "+ Add “q”" opens it.
- Renaming still doesn't follow the grocery-list name link (pre-existing: the Need/Skip state matches grocery entries by name).

State is conveyed by text style (normal vs italic) + badge text ("On list" / "Skip" / "Need"), never color alone (protanopia rule). Skip state is derived (`stocked===false && not on grocery list`), not a new field. A bulk **"🛒 Add N skipped"** button in the toolbar converts all Skip items to Need (adds them to grocery). Name and quantity remain inline-editable `<input>`s (same oninput/onchange split as Guard 1 requires).

**Categories** expanded from 7 to 11: Produce, Protein, Dairy, Grains, Pantry, **Snacks**, Frozen, **Beverages**, **Health & Baby**, **Household**, Other. Non-food items (toiletries, cleaning supplies, etc.) sit in the inventory grid; the AI ignores them naturally since they're not ingredients.

**Costco migration (`migrateInventory`):** a one-time merge on load (gated by `seedMigrated_v2` localStorage flag) adds any SEED items not already present in the running inventory, case-insensitive name dedup. The SEED array is now a comprehensive ~247-item catalog covering all Costco categories plus kitchen staples.

**Load-bearing correctness detail:** the AI meal-plan generator only considers `isStocked(item)===true` inventory as "what's in the pantry." The Need and Skip states both set `stocked:false` — this isn't cosmetic, it changes what the AI assumes you have.

**Search (`S.invSearch`, session-only).** A search field above the add row filters the catalog by case-insensitive name substring. **Invariant: one matcher, `invMatches(item,q)`, used by both paths** — `renderInventory` emits *every* row with `hidden` on non-matches (and on category cards with no visible rows), and typing calls `setInvSearch` → `applyInvSearchDom`, which re-toggles `hidden` on the existing DOM **without calling `render()`** (Guard 1 would skip it, and an innerHTML swap would dismiss the iOS keyboard). Because rows are never removed from the DOM, deleting characters can always un-hide them, and the filter survives every render triggered by state cycles or sync polls. **CSS trap:** `.pantry-item{display:flex}` overrides the UA `[hidden]` rule, so `.pantry-item[hidden], .cat-group[hidden]{display:none!important}` is load-bearing. A status line ("Showing N of M · Clear search") makes a filtered view impossible to mistake for missing data; on zero matches it offers "+ Add “q”", which moves the query into the add row (`prefillAddFromSearch`, blurs first so the render isn't swallowed) and focuses it. The query is displayed via `esc()` and **never interpolated into an onclick** — the handlers read `S.invSearch` themselves.

**Weekly review mode (Session C redesign).** "📋 Review" swaps each row for a read-only name + two independent toggles: **🛒 Need** and **? Check**. **Unmarked = "don't need"** — you only tap exceptions (the earlier three-way Need/Don't need/Check design made you decide every one of 247 items). Selected = filled accent + white bold text + a "✓ " prefix + `aria-pressed` (not hue alone).
- **Need is derived, never stored:** `onGroceryList(item)` = an *unchecked* grocery entry with the item's exact normalized name. A Need added by ∅, Siri, or by hand shows up; removing the entry anywhere clears it. No stale marks.
- **`toggleReviewNeed` = `toggleOnList`** (one writer, one meaning in both modes): on → Out + on the list + clears that item's Check; off → off the list, **stock left Out** (changed with explicit stock — taking it off the list isn't a claim you have it; the row shows "· out" so a mis-tap is visible). Clear checked restocks bought items (below).
- **Check** is the only stored mark (`S.invReview`, synced, values validated on every read; old need/dont marks dropped on load). `toggleReviewCheck` flips it. "Clear ? Check flags" (confirm) wipes them — grocery list and stock untouched.
- Review bar: "6 on list · 4 to check"; filters **All / ? To check / 🛒 On list**. Review mode and filter persist per device (`invReviewMode`, `invReviewFilter` in localStorage). Normal-mode `cycleInventoryState` still clears that item's Check.
- **Visibility invariant:** `invVisible(item) = invMatches(search) && reviewFilterMatches(item)` is the single predicate for both the render path and the typing DOM patch.

**Collapsible categories (Session C).** Every category renders as a `.cat-head` button ("▸ PRODUCE · 37 items · 2 on list", "· N to check" in review mode) and starts **collapsed**; open set is per-device (`S.invOpenCats`, localStorage, sanitized against `CATEGORIES`). Expand all / Collapse all link above the grid. Landing height went from ~13,500px to ~1,100px at 390px wide. Handlers take an **index into `CATEGORIES`**, never the name ("Health & Baby" in an onclick).
- **Trap handled: collapse vs filtering.** Collapsing is CSS only (`.cat-group.collapsed .pantry-list{display:none}`) — every row is always in the DOM, because search filters by toggling `[hidden]` on existing rows without a render (Guard 1). **Any active narrowing (`invFilterActive()`: search text, or a review filter other than All) forces every category with a match open**; `applyInvSearchDom` updates `collapsed`/`aria-expanded`/▸▾ in the same pass, so clearing the search restores the saved collapse state. The category of the row being edited is forced open too.

Wide-screen layout: pantry categories render into `.pantry-grid` (`grid-template-columns:repeat(auto-fit,minmax(260px,1fr))`), letting multiple category cards sit side-by-side on desktop while collapsing to one column on narrow viewports automatically (no separate media query needed for the column count — `auto-fit` handles it).

### Grocery (`renderGrocery`)
**Layout (Session B — built for use in the store):** one compact add row (input + store pill + "+ Add") → store filter chips → the list → "Checked off" → a separate **"More ways to add"** card (📷 Scan paper list, ↓ Add items from meal plan, scan errors, the scan review panel, the Siri hint). The list starts ~⅓ screen down instead of ~½. Deliberately **not** a bottom-pinned add field: `position:fixed` inputs jump unpredictably when the iOS keyboard opens.

**Rows:** the **whole row is the check target** (`role="checkbox"`, `aria-checked`, `tabindex=0`, Enter/Space toggle; the 22px box is now decorative). One **⋯** button (44×40, `event.stopPropagation()`) replaces ✎, the per-row store pill and ×. It opens an inline editor: name, qty, store as three buttons (🏪 Grocery / 📦 Costco / 🔀 Either, `aria-pressed`), ✓ Save / Cancel / 🗑 Delete. No autofocus (the editor is also how you change store or delete). Store choice is a DOM patch (`setEditGroceryStore`, whitelisted) — no render, so a focused name/qty field survives. `commitGroceryEdit` now saves store too and keeps the rename-collision merge. **Clear checked restocks the pantry** (exact-name match, undoable — see §9). Delete goes through `removeGroceryItem` → the existing single-slot `S.groceryUndo`, now shown as a **toast** (with ✕ dismiss) instead of a button in the top card; the same toast covers "added N unstocked" and "cleared N checked". Not long-press: undiscoverable, fights iOS text selection/callout and scrolling. `cycleGroceryStore` is no longer called from the UI (kept; harmless).

One data list. **All view:** three disjoint sections — "🏪 Grocery Store" (store `grocery`), "📦 Costco" (`costco`), "🔀 Either store" (`either` or missing) — **each item appears exactly once.** (It used to render `either` items under both stores: 9 items to get showed as 15 rows.) **One-store views** (🏪 / 📦 filter) still include `either` items via `inStore()`, since you're in that store. Source badges (PANTRY / MEAL PLAN / SIRI) are no longer rendered — useless in the aisle; `source` is still stored and used for plan-swap provenance. Each item has a cycling pill (`cycleGroceryStore`, order: grocery → costco → either → …) instead of a dropdown, for one-tap mobile changes. Checked items collapse into a single flat "Checked off" section at the bottom (not split by store — once purchased, the distinction stops mattering) with a "Clear checked" bulk action.

Voice input arrives via the Siri Shortcut → Apps Script `addGrocery` action (see §3) and appears here on the next sync poll.

### Meal Plan (`renderPlanTab`) — the home view
- If `S.mealPlan` is null: shows a config summary line + a centered "✨ Generate Meal Plan" CTA.
- If a plan exists: a **preferences summary bar** at the top (`renderPrefsSummary` — "2 adults, 2 kids · avoiding banana, avocado · 1 fixed meal — Edit", the "Edit" link opens the Preferences modal), then:
  - **Hero card** — `heroDayName()` picks the featured day: today's weekday name until `HERO_ROLLOVER_HOUR` (a code constant, currently 20:00 local — deliberately no Settings knob), after which it rolls to the *next* day, because by evening tonight's dinner is settled and the useful glance is tomorrow's. Week wrap is free: the rollover adds a day to a `Date` and reads its weekday name, and plan days are floating weekday labels, not calendar dates (no date-tracking anywhere in the app). The section label and the card's "Today · "/"Tomorrow · " prefix follow `heroDayName()` vs `todayDayName()` — the state is carried in text. Visually distinguished (`.hero-day` — thicker accent border, larger day name). **Collapsed by default like every other day (Session B)** — the Meal Plan tab lands on the whole week at a glance; tap to open.
  - **Collapsed day header = day label over the dish name** (`.day-title` / `.day-dish`, sans, up to 2 lines). It replaced the small mono `.meal-badge` pill, which wrapped and misaligned. The header dish line is hidden when the card is open (the body names it) and shows "Regenerating…" while a redo is in flight. The whole header is the toggle (`role=button`, `aria-expanded`); ↻ stops propagation. At 390×844, Today + Tue–Sat fit on the landing screen; Sunday needs a short scroll (the prefs summary, legend and seed panel take the rest).
  - **Recipe steps collapsed by default** behind "▸ Recipe · N steps" (`toggleRecipe(key)`, `.recipe-toggle`, `aria-expanded`). State lives in `S.recipeOpen`, **not `<details>`**: render() rebuilds the DOM on every sync poll, which would snap a native `<details>` shut while you're reading. Keys are whitelisted (`DAYS` or `"preview"`) because they're interpolated into the onclick. Previews pass `recipeKey="preview"` (they have no `day`, so ∅ buttons stay omitted as before). Ingredients and nutrition stay visible when a card is open.
  - **"This Week"** — the other 6 days, in a `.week-grid` (same `auto-fit` grid pattern as Inventory), each collapsible, each with its own ↻ regenerate button. An open preview forces its card open regardless of `expandedDay`; `generateCandidate` also sets `expandedDay` to the redone day.
  - **Ingredients render as a column list** (`.ing-list`, `auto-fit` grid of one-per-row `.ing-row`s), not wrapping pill tags. Each row has an **"∅" toggle** ("don't have this"): tapping it (1) fuzzy-matches the ingredient against inventory (case-insensitive substring either direction, both sides ≥3 chars) and marks the matched item unstocked (synced — which also drops it from the PANTRY prompt line automatically), (2) records it in `S.missingIngredients` (persisted + synced, §3), injected into both the `{CONTEXT}` AVOID line and the hard-constraint system prompt (§5) on the next generation, and (3) **queues it on the grocery list** (deduped case-insensitively; uses the pantry item's clean name over the recipe's quantity-laden text; the created entry's `gid` is stored). Undo reverses exactly what the mark did — exclusion removed, exact pantry item restocked, grocery entry removed *only if still unchecked* (checked-off means bought; kept). Restocking the pantry item directly also clears the linked exclusion. Marked rows show strikethrough + italic + a "✕ excluded" badge (glyph/text carries the state, per the protanopia rule). Tapping again undoes both — including restocking *only* the exact item the original tap unstocked (`invId`). **Security invariant preserved:** the row's `onclick` interpolates only the whitelisted day name and a numeric index — never AI-supplied ingredient text (same reasoning as `normalizeDays`).
  - **"🌱 Seed the week" panel (`renderSeedPanel`)** — seven inputs, one per day, for dish ideas ("Southwest skillet"); blank days are the AI's pick. Shown open above the Generate CTA when no plan exists, and as a collapsible card (count visible when collapsed: "3 of 7 days seeded") above the week grid otherwise. **Seeds ARE `S.dayInstructions`** — the same text the day-card composers show; there is no second store. `setDayText(day, el)` is the single oninput writer for every field bound to a day (`data-day-text` attribute): updates S, persists to localStorage immediately, mirrors the value into any other visible field for that day (panel ↔ composer can never disagree), and patches the count — no render (Guard 1). Enter in a seed row jumps to the next day. "Clear all ideas" asks `confirm()` first. Seeds persist after generation (so you can re-roll); clear them for next week. Seeds are consumed by `generatePlan` (see §5) and, through the composer, by per-day Redo.
  - Every day card (hero or not) has an inline **steering composer**: a text field + "↻ Redo" button. Label reads "Want something different for Tuesday?" when empty, or "🌱 Idea for Tuesday — ↻ Redo builds from this text" when a seed/steer is present (state carried in text). Text is folded into that single day's generation prompt as `SPECIAL REQUEST FOR THIS MEAL`. **`S.dayInstructions` is persisted per-device (localStorage), not synced** — it was originally ephemeral; it became persistent when it became the seed store. The field is never cleared or disabled by a generation, and `renderKeepComposer` (§2) keeps it focused across the generation renders. **As of the steering rework, Redo no longer writes directly — it produces a preview (§4a).**

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
- **`commitGeneration(id)`** no-ops unless `S.generation.id === id && status === "preview"`; on success it swaps the candidate's dinner into the day **by reference** (byte-for-byte — no re-serialization), does exactly one `setAndSync`, and nulls the slot. Idempotency is via absence: a double-tap's second call finds no matching preview. Atomicity at the persistence layer is structural (whole app state is one JSON blob).
- **Shopping-list provenance swap (in commit):** items are `{text, day|null}`. Commit *removes* items tagged with this day (the replaced meal's ingredients), keeps everything else (other days' tags, `day:null` week items, legacy strings), then appends the candidate's items tagged with this day, deduped case-insensitively against what remains. This is what stops repeated steer→commit cycles from accumulating every discarded dinner's ingredients. The preview panel shows both deltas ("+ adds" / "− removes") before you decide. **Backward compatibility is behavioral, not migratory:** legacy string items are simply never removed by a per-day commit — identical to the pre-provenance behavior — and are cured by the next full-week generate, which emits uniform `{text, day:null}` objects. `shopText(i)` is the one read-side accessor; every renderer and `importPlanGroceries` go through it. **Known limitation (accepted):** an item is tagged with the single day whose commit first added it; if two days' meals share an ingredient, re-steering the tagging day removes it even though the other meal still wants it. Multi-day tags weren't worth the complexity — the list is advisory between full generates (§9).
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

**Full-week generate never destroys the current plan (`generatePlan`).** The old code nulled `S.mealPlan` and its localStorage copy *before* the API call, so any failure (network, unparseable JSON, a dropped day) left a blank week. Now the current plan stays committed until a replacement validates **completely**: all 7 days present (after `normalizeDays`), each with a non-empty `dinner.name`, else it throws "AI returned N of 7 complete days — kept your current plan." Any other failure appends "(Your current plan is unchanged.)". `S.generation` (open preview) is discarded only on success. `generatePlan` also blurs the active element first so Guard 1 can't swallow the loading paint when triggered from a focused seed field.

**Seeds in the full-week prompt.** For each of the two parallel calls, seeded days *in that call's batch* are appended to `{CONTEXT}` as a `REQUESTED DINNERS` block (build that day's dinner around the idea; keep it recognizable; adapt only for diet/avoid/missing). Going through `{CONTEXT}` rather than a new placeholder means saved custom `promptWeek` templates pick it up unchanged. **Seed vs fixed meal, resolved client-side:** a seed beats a fixed *dinner* for its day — that fixed entry is dropped from the FIXED MEALS list before the call, so the model never sees two contradictory mandates (same lesson as FIXED-vs-MISSING below). Hard constraints still beat seeds via `hardConstraintsSystem()` — a "salmon tacos" seed with salmon marked ∅ will be adapted, not obeyed. Seed fidelity is not machine-checked; the composer shows the seed next to the generated meal, so drift is visible.

**Per-day Redo with a fixed meal + steering text.** Because seeds persist, a seeded day with a fixed dinner now collides on every Redo. The composer text may be a dish ("Southwest skillet") or a nudge ("make it cheesier"), which the client can't distinguish, so `generateCandidate` gives the model an explicit precedence rule instead of two flat mandates: "FIXED (default): normally X. If the SPECIAL REQUEST names a different dish, make that instead; if it only adjusts the meal, apply it to this fixed dinner." With no steering text, the plain `FIXED: must be X` line is unchanged; the missing-ingredient override (below) still takes priority over both.

**Why full-week generation is split into two parallel calls** (`generatePlan`): a single 7-day request with full recipes/nutrition JSON reliably hit the token ceiling and returned truncated, unparseable JSON. The fix was splitting into Monday–Thursday and Friday–Sunday, requested via `Promise.all`, then merged and day-sorted client-side. `maxOutputTokens` is set to Gemini 2.5 Flash's ceiling (65536) as additional headroom.

**FIXED vs MISSING conflict (deterministic client-side resolution):** a fixed meal ("Salmon…") and a ∅-excluded ingredient ("salmon") put two prompts in direct contradiction — the user turn mandates the dish, the system prompt forbids the ingredient. Gemini arbitrated nondeterministically (observed in the field: fixed-day regens sometimes returned the excluded ingredient, sometimes not). `generateCandidate` now resolves it before the call: if any ≥4-char word of a missing ingredient appears in the fixed-meal description (case-insensitive word-overlap heuristic — deliberately loose; a missing "rice" correctly conflicts with a rice-based fixed meal), the FIXED mandate is replaced with an explicit "do NOT make it, generate a different dinner" instruction. Unavailability wins for that generation; the fixed meal returns once the item is restocked (which auto-clears the exclusion). The override is recorded on the generation (`fixedOverridden`) and surfaced as a ⚠ line in the preview panel so a skipped fixed meal is never mysterious. Also: `commitGeneration` now fails loudly (error banner + preview cleared) if the plan vanished under an open preview, instead of a silent no-op Accept button.

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

Seven themes ship: **Slate** (cool default), **Ink** (warm dark), **Cobalt** (cool dark), **Citrus** (bright/warm), **Clay** (muted/warm-sophisticated), **Birch** (soft/minimal-violet), **Fog** (minimal/denim). **Deliberately avoid pairing red and green as a meaningful signal anywhere**, in any theme — the end user has protanopia. State (need/skip/stocked, grocery checked/unchecked, sync live/error) is always carried by a glyph, badge text, italics, or strikethrough *first*, with color as reinforcement only, never the sole signal.

**Signature interactive element:** the checkbox (Pantry + Grocery). An empty bordered square that fills solid with `var(--accent)` and reveals a white inline-SVG checkmark (not a Unicode glyph — font-dependent glyph weight/shape was inconsistent) on check, with a quick scale-in transition. (An earlier version tried a rotated Unicode ✓ with a text-shadow to fake a "rubber stamp" look; it read as visually broken rather than intentional and was replaced.)

**Layout:** `.content` max-width 1140px, but individual form-style `.card`s (add-item rows, quick-add) are separately capped at 720px and centered — widening the outer container without this would have stretched text inputs across the full page width. Multi-item lists (`.week-grid`, `.pantry-grid`) use `grid-template-columns:repeat(auto-fit,minmax(Npx,1fr))` specifically so they reflow to the right column count at any width without extra breakpoints.

**Tab bar:** on wide screens, bold "index tabs" (folder-tab metaphor — raised/bordered when active). **At ≤700px it becomes a fixed bottom bar** (thumb reach; the inventory is ~14 screens tall and the top tabs used to scroll away): icon over label, active = bold + filled `--accent-light` + a 3px top bar + `aria-current="page"` (not hue alone). Uses `env(safe-area-inset-bottom)` — requires `viewport-fit=cover` in the viewport meta. `body` gets matching bottom padding; the undo toast sits above the bar. `setView` now scrolls to top on an actual tab change (render() preserves scrollY, which landed the next tab mid-page) and drops edit/undo state.

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
- ~~Single-day regeneration only grows the shopping list.~~ **Fixed** via per-day provenance in `commitGeneration` (§4a) — steer→commit now swaps the day's items instead of appending. Residual: legacy string items (pre-provenance plans) and the shared-ingredient single-tag limitation described in §4a; a full-week generate remains the authoritative reset.
- **API key stored in plaintext in `localStorage`**, readable by any script that runs in that origin. Acceptable for a single-family personal tool, worth flagging in any general-purpose security audit.
- **No input validation on the Apps Script side** beyond `JSON.parse` succeeding — a malformed payload from anywhere (not just the two known clients) would silently corrupt the shared state blob with no schema check.
- **`dayInstructions` and `theme` are the only two pieces of "preference-shaped" state that are deliberately not synced.** `dayInstructions` is now persisted per-device (it doubles as the week's seeds) but still not synced — seeds typed on one phone don't appear on the other. Judgment call (draft input; theme is personal taste) — revisit if spouses want to seed the week together.
- **Restock on buy is exact-name only (Session C).** `clearCheckedGroceries` ("done shopping") restocks unstocked pantry items whose normalized name exactly matches a cleared item and drops their ∅ links; the undo record (`restockedIds`, `missingRemoved`) reverses both. Checking off alone never restocks. A meal-plan item like "Salmon fillets" won't restock pantry "Salmon" — those stay out of stock (and AI-excluded) until changed by hand. Fuzzy matching here would be the next step if it bites.
- **Full-week generate has no FIXED-vs-MISSING resolution** — only `generateCandidate` does the deterministic override; `generatePlan` still lists fixed meals alongside the missing-ingredient constraint and lets the model arbitrate.

---

## 10. Phone usability rules (Session A, from the Oct 2026 phone UX audit)

Enforced by one CSS block at the **end** of the stylesheet ("Phone usability") so it wins over earlier rules. Don't add per-component exceptions — fix the component.
- **All `input/select/textarea` are 16px (`!important`, beats inline styles).** iOS Safari zooms the page on focus of any field under 16px and stays zoomed. Any new field inherits this; never set a smaller font on a field.
- **16px alone did not stop the zoom on Ben's iPhone** (search field and day composer still zoomed after deploy), even though a headless check confirmed every field computes to 16px with no horizontal overflow at 375/390/430px. Most likely cause: iOS compares the *rendered* size, so anything that scales the page below 100% (e.g. Safari's aA page zoom) puts 16px back under the threshold. **Fix: `maximum-scale=1` in the viewport meta.** iOS (10+) ignores it for user pinch-zoom — accessibility is preserved — but honours it for focus auto-zoom, so this works regardless of cause. Tradeoff: Android Chrome *does* honour it and disables pinch-zoom there (Android never auto-zooms on focus, so it gains nothing). Keep the 16px rule too: it's the correct size for readability and the fix of record on browsers that ignore `maximum-scale`.
- **Tap targets ≥40px** in the smaller dimension (Apple's guideline is 44pt). `.btn`, header buttons, filter chips, review buttons, state buttons, `.fi`, `.link-btn`: `min-height:40px`. Icon buttons (`.rm-btn`, `.ged-open`): 40×40. Where the visual should stay small, the hit area is expanded instead: grocery checkbox via padding + negative margin, store pill via a `::after` with negative inset. Ingredient ∅ is 44×36 in a 40px row, borderless until `on`. Rows trimmed to 4px padding so the 40px control sets row height (~49px).
- **Verified by measurement, not by CSS reading:** a Playwright pass at 390×844 probes each visible control with `elementFromPoint` from its centre outward (effective hit area, including pseudo-elements and occlusion). Remaining under-40 hits: ∅ at 36px tall (by design), Quick-meal chip × at 32px wide, and one-offs at the viewport edge occluded by the fixed bar. Re-run after layout changes.
- **No destructive control on a list row.** Delete lives in an editor and has undo (inventory and grocery).
- **Session B measurement:** grocery tab 0 controls under 40px. Plan tab residuals: ∅ 36px tall (by design), Quick-meal chip × 32px wide, plus viewport-edge one-offs.

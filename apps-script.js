// ── Pantry Planner - Google Apps Script ──────────────────────────────────────
// Paste this entire file into your Apps Script editor, then deploy as a web app.
// Set "Execute as" to "Me" and "Who has access" to "Anyone".
//
// If you already have this script deployed: replace the contents, then
// Deploy → Manage deployments → edit (pencil) your existing deployment →
// Version: New version → Deploy. This keeps the SAME url — do NOT create a
// new deployment, that generates a different url and breaks the app + Shortcut.

const SHEET_NAME = "sync";

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange("A1").setValue("{}");
  }
  return sheet;
}

function readState(sheet) {
  return JSON.parse(sheet.getRange("A1").getValue() || "{}");
}

function writeState(sheet, state) {
  sheet.getRange("A1").setValue(JSON.stringify(state));
}

function doGet(e) {
  const sheet = getSheet();
  const data = sheet.getRange("A1").getValue();
  return ContentService
    .createTextOutput(data || "{}")
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // A script-wide lock makes read-modify-write safe: without it, a Siri
  // "addGrocery" call and a normal app sync landing at nearly the same
  // moment could both read the old state and the second write would
  // silently clobber the first. The lock serializes them.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const incoming = JSON.parse(e.postData.contents);

    if (incoming.action === "addGrocery") {
      return handleAddGrocery(sheet, incoming);
    }

    // Default path: the app's normal full/partial state sync (shallow
    // merge by top-level key — unspecified keys are left untouched).
    const existing = readState(sheet);
    const merged = Object.assign({}, existing, incoming, {
      lastUpdated: new Date().toISOString(),
      lastUpdatedBy: incoming.updatedBy || "unknown"
    });
    writeState(sheet, merged);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, lastUpdated: merged.lastUpdated }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Appends grocery item(s) directly to the stored groceryList, server-side.
// Supports comma-separated voice input ("milk, eggs, bread" -> 3 rows) and
// skips anything already on the list (case-insensitive match).
function handleAddGrocery(sheet, incoming) {
  const state = readState(sheet);
  const list = Array.isArray(state.groceryList) ? state.groceryList : [];

  const rawText = String(incoming.text || "");
  const parts = rawText.split(",").map(function(s){ return s.trim(); }).filter(Boolean);

  const existingNorm = {};
  list.forEach(function(i){ existingNorm[String(i.text || "").trim().toLowerCase()] = true; });

  const now = Date.now();
  const added = [];

  parts.forEach(function(text, i){
    const norm = text.toLowerCase();
    if (existingNorm[norm]) return;
    existingNorm[norm] = true;
    const item = { id: now + i, text: text, checked: false, source: "siri" };
    list.push(item);
    added.push(item);
  });

  state.groceryList = list;
  state.lastUpdated = new Date().toISOString();
  state.lastUpdatedBy = incoming.updatedBy || "Siri";
  writeState(sheet, state);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, added: added, count: list.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

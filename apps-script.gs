/**
 * ピアノれんしゅう記録 — Google スプレッドシートに記録を保存するための Apps Script。
 *
 * 使い方（くわしくは README）:
 *   1. 新しいスプレッドシートを作り、拡張機能 → Apps Script を開く
 *   2. このコードを全部貼り付けて保存
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *   4. 表示された「ウェブアプリの URL」(…/exec) を練習記録アプリの設定に貼り付ける
 *
 * シート「記録」に 1回の練習が 1行で入ります。設定（名前・目標）はスクリプトの
 * プロパティに保存され、端末を変えても引き継げます。
 */
const RECORDS = '記録';
const HEAD = ['id', '日付', '開始', '終了', '分', '秒', 'だれ', 'だれ(ID)', '終わり方', '保存日時'];
const FORMATS = ['@', '@', '@', '@', '0', '0', '@', '@', '@', '@'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'list') return out_({ ok: true, records: listRecords_(), settings: readSettings_() });
    return out_({ ok: true, app: 'piano-log' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'add') addRecord_(body.record);
    else if (body.action === 'delete') deleteRecord_(body.id);
    else if (body.action === 'settings') writeSettings_(body.settings);
    else throw new Error('unknown action');
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(RECORDS);
  if (!sh) {
    sh = ss.insertSheet(RECORDS, 0);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ids_(sh) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
}

function listRecords_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEAD.length).getDisplayValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return {
        id: r[0], date: r[1], start: r[2], end: r[3],
        min: Number(r[4]) || 0, sec: Number(r[5]) || 0,
        names: r[6], people: r[7] ? r[7].split(',') : [], how: r[8], savedAt: r[9],
      };
    });
}

function addRecord_(r) {
  if (!r || !r.id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error('bad record');
  const sh = sheet_();
  if (ids_(sh).indexOf(r.id) >= 0) return; // already saved
  const range = sh.getRange(sh.getLastRow() + 1, 1, 1, HEAD.length);
  range.setNumberFormats([FORMATS]);
  range.setValues([[
    String(r.id), r.date, String(r.start || ''), String(r.end || ''),
    Number(r.min) || 0, Number(r.sec) || 0,
    String(r.names || ''), (r.people || []).join(','), String(r.how || ''), String(r.savedAt || new Date().toISOString()),
  ]]);
}

function deleteRecord_(id) {
  const sh = sheet_();
  const i = ids_(sh).indexOf(String(id));
  if (i >= 0) sh.deleteRow(i + 2);
}

function readSettings_() {
  const s = PropertiesService.getScriptProperties().getProperty('settings');
  return s ? JSON.parse(s) : null;
}

function writeSettings_(s) {
  if (!s || !Array.isArray(s.people)) throw new Error('bad settings');
  PropertiesService.getScriptProperties().setProperty('settings', JSON.stringify(s));
}

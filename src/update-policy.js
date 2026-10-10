'use strict';
// Existing work may finish or be stopped. New jobs cannot start during a
// mandatory update; all accounting and AI permission checks still apply.
function allowsDuringUpdate(method, pathname, context = {}) {
  if (method === 'GET' || method === 'HEAD') return true;
  if(pathname==='/api/account/save')return (context.forms||[]).includes('mst-form');
  if(pathname==='/api/account/identifiers')return (context.forms||[]).includes('identifiers-form');
  if (/^\/api\/update\/(check|start|work)$/.test(pathname)) return true;
  if (/^\/api\/(app\/quit|window\/show|pause|support\/|billing\/activity|app-lock\/)/.test(pathname)) return true;
  if (/^\/api\/db\/(autosync\/(stop|run-all\/stop)|backfill\/cancel|bank\/(import-rows|category|categories))$/.test(pathname)) return true;
  if (/^\/api\/invoice-replacement\/(preview|mapping|process|metadata|confirm|results|detail|progress|export|report|stop|invalidate)$/.test(pathname)) return true;
  if (/^\/api\/(mst\/lookup\/stop|tokhai\/stop|account\/(save|identifiers|submit|captcha|check|visibility)|ai\/approvals)$/.test(pathname)) return true;
  return false;
}
module.exports = { allowsDuringUpdate };

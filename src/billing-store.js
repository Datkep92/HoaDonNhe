'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./core');
const rules = require('./billing-core');
class BillingStore {
  constructor(dataDir, support) {
    this.file = path.join(dataDir, 'billing.json'); this.support = support;
    try { this.data = JSON.parse(fs.readFileSync(this.file,'utf8')); } catch { this.data = {}; }
    this.data.usage ||= {}; this.data.events ||= {}; this.data.exports ||= {}; this.data.receipts ||= {};
    this.config = this.data.config || { commercial: false, revision: 0 };
    this.pending = new Set();
  }
  save() { atomicWrite(this.file,JSON.stringify(this.data,null,2)); }
  configure(value) {
    if (!value || typeof value.commercial !== 'boolean') return;
    if (Number(value.revision || 0) < Number(this.config.revision || 0)) return;
    this.config = value; this.data.config = value; this.save();
    if(this.support.data) {this.support.data.billing=value; if(this.support.save)this.support.save();}
  }
  status() {
    const license = this.support.publicLicense();
    const paid = String(license.status).toLowerCase()==='active';
    const firstInstall=Number(this.support.data?.device?.firstInstallAt||0);
    const initial = !license.keyName && this.config.launchAt && Date.now() < Math.max(Number(new Date(this.config.launchAt)),firstInstall)+30*86400000;
    return { commercial: this.config.commercial === true, revision: this.config.revision||0,
      freeAccess: this.config.commercial !== true || initial || paid && !license.entitlement,
      basic: this.config.commercial === true && !paid && !initial,
      entitlement: license.entitlement || null, plans: this.config.plans || rules.defaults,
      selectedMst: this.data.selectedMst || '', changes: this.data.changes || 0, usage: this.data.usage };
  }
  async remote(action, payload={}) {
    const result = this.support.gateway('/v1/billing', {...this.support.publicDevice(),action,...payload}, true);
    if (!result) throw new Error('Cần kết nối máy chủ để thực hiện.');
    return result;
  }
  async checkMst(mst) {
    const state=this.status(); if (!state.commercial || state.freeAccess) return;
    if (!/^\d{10}(?:-?\d{3})?$/.test(String(mst))) throw new Error('MST không hợp lệ.');
    const value=await this.remote('mst_use',{mst});
    if (value.allowed !== true) throw new Error(value.error || 'MST chưa được cấp quyền.');
    if (state.basic) { this.data.selectedMst=value.selectedMst; this.data.changes=value.changes; this.save(); }
  }
  async limited(kind, fingerprint, operation) {
    const state=this.status(), now=Date.now();
    const period=rules.month(now);
    const key=kind+':'+period, hash=crypto.createHash('sha256').update(String(fingerprint)).digest('hex');
    if (!state.basic || this.data.exports[key+':'+hash]) return operation();
    if (this.pending.has(key)) throw new Error('Đang xử lý lượt này; vui lòng chờ.');
    this.pending.add(key); let ticket;
    try {
      ticket=await this.remote('quota_reserve',{kind, fingerprint:hash});
      const result=await operation();
      if (result && result.billingNoChange) { await this.remote('quota_release',{ticket:ticket.ticket}); return result; }
      // Server receipt makes a retry idempotent, including after local restart.
      this.data.exports[key+':'+hash]=true;
      this.data.receipts[ticket.ticket]=true; this.save();
      try {await this.remote('quota_commit',{ticket:ticket.ticket});delete this.data.receipts[ticket.ticket];this.save();}
      catch { /* Keep a durable receipt; a network failure cannot undo imported data. */ }
      return result;
    } catch(error) {
      if(ticket) await this.remote('quota_release',{ticket:ticket.ticket}).catch(()=>{});
      throw error;
    } finally { this.pending.delete(key); }
  }
  record(feature, success=true, amount=1) {
    const key=rules.day(Date.now())+':'+String(feature).slice(0,60)+':'+(success?'ok':'error');
    this.data.usage[key]=(this.data.usage[key]||0)+Math.max(0,Number(amount)||0); this.save();
  }
  async flush(accounts) {
    if (this.flushing) return; this.flushing=true;
    try {
      for(const ticket of Object.keys(this.data.receipts)) {await this.remote('quota_commit',{ticket});delete this.data.receipts[ticket];this.save();}
      await this.remote('usage',{snapshot:this.data.usage, mst:accounts, reportId:this.support.data.device.installationId});
    }
    finally { this.flushing=false; }
  }
}
module.exports={BillingStore};

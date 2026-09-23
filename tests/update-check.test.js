'use strict';
// Test cho khâu KIỂM TRA bản mới (src/update-check.js): tách version thuần từ tag — kể cả tag
// có tiền tố thương hiệu `cntax-vX.Y.Z` — và so sánh version. Đây là điều kiện để bản
// CN Tax Tools v1.0.0 nhìn thấy đúng bản CN Tax Tools v1.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { latestFromTag, compareVersions } = require('../src/update-check');

test('latestFromTag: bỏ "v" và tiền tố thương hiệu "cntax-"', () => {
  assert.equal(latestFromTag('v1.0.0'), '1.0.0');
  assert.equal(latestFromTag('cntax-v1.0.1'), '1.0.1');
  assert.equal(latestFromTag('CNTAX-V2.3.4'), '2.3.4');
  assert.equal(latestFromTag('1.0.2'), '1.0.2');
  assert.equal(latestFromTag(''), '');
  assert.equal(latestFromTag(null), '');
});

test('v1.0.0 nhìn thấy v1.0.1 qua tag cntax-v1.0.1', () => {
  const latest = latestFromTag('cntax-v1.0.1');
  assert.equal(latest, '1.0.1');
  assert.ok(compareVersions(latest, '1.0.0') > 0, 'phải báo CÓ bản mới');
  assert.equal(compareVersions(latest, '1.0.1'), 0, 'đang ở 1.0.1 thì không báo nữa (không update loop)');
  assert.ok(compareVersions('cntax-v1.0.1', '1.0.0') > 0, 'so sánh nhận thẳng tag có tiền tố');
  assert.equal(compareVersions('cntax-v1.0.0', '1.0.0'), 0, 'không tự nhận là mới hơn chính mình');
  // Tag cũ vẫn phải hoạt động y như trước.
  assert.equal(latestFromTag('v1.0.4'), '1.0.4');
  assert.ok(compareVersions('v1.0.4', '1.0.0') > 0);
});

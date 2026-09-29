'use strict';

const PAYMENT_METHODS = Object.freeze({
  CASH: 'CASH',
  TRANSFER: 'TRANSFER',
  CASH_TRANSFER: 'CASH_TRANSFER',
  UNKNOWN: 'UNKNOWN',
});

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function normalizePaymentMethod(value) {
  const text = fold(value);
  if (!text) return PAYMENT_METHODS.UNKNOWN;
  const compact = text.replace(/\s+/g, '');
  const cash = /(^|\s)(TM|TIEN MAT|CASH)(\s|$)/.test(text) || compact === 'TM';
  const transfer = /(^|\s)(CK|CHUYEN KHOAN|TRANSFER|BANK)(\s|$)/.test(text) || compact === 'CK';
  if (cash && transfer) return PAYMENT_METHODS.CASH_TRANSFER;
  if (cash) return PAYMENT_METHODS.CASH;
  if (transfer) return PAYMENT_METHODS.TRANSFER;
  return PAYMENT_METHODS.UNKNOWN;
}

module.exports = { PAYMENT_METHODS, normalizePaymentMethod, fold };

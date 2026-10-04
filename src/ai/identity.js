'use strict';
const product = require('../version');
const packageInfo = require('../../package.json');
module.exports = Object.freeze({ productName: 'CNTaxTools', agentName: 'CNTaxTools', authorName: packageInfo.author, authorBrand: product.name, version: product.version });

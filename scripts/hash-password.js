#!/usr/bin/env node

const crypto = require('crypto');

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

console.log('Add the following lines to your .env file:');
console.log(`AUTH_PASSWORD_SALT=${salt}`);
console.log(`AUTH_PASSWORD_HASH=${hash}`);
console.log('# Then remove AUTH_PASSWORD to avoid storing plain text credentials.');

'use strict';
require('dotenv').config();
const { initDb, merchants } = require('./src/config/database');
const bcrypt = require('bcryptjs');

async function debug() {
    await initDb();
    const list = await merchants.list(100);
    console.log('--- Merchants List ---');
    for (const m of list) {
        const fullM = await merchants.findById(m.id);
        console.log(`Email: ${fullM.email}`);
        console.log(`  Live Prefix: ${fullM.api_key_live_prefix}`);
        console.log(`  Test Prefix: ${fullM.api_key_test_prefix}`);
        console.log(`  Live Hash:   ${fullM.api_key_live_hash.substring(0, 10)}...`);
    }
    
    // Test the user's specific key if possible
    const testKey = 'vp_live_d2bf45f41e9c2b6bf270e1bb5d319b7c';
    const prefix = testKey.substring(0, 16);
    console.log(`\n--- Testing Prefix: ${prefix} ---`);
    const merchant = await merchants.findByKeyPrefix(prefix);
    if (!merchant) {
        console.log('❌ FATAL: Prefix NOT found in database.');
    } else {
        console.log(`✅ Merchant found: ${merchant.email}`);
        const valid = await bcrypt.compare(testKey, merchant.api_key_live_hash);
        console.log(`   Hash match: ${valid ? '✅ YES' : '❌ NO'}`);
    }
    process.exit(0);
}

debug();

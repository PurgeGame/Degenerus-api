#!/usr/bin/env node
/**
 * Export pre-launch agent affiliate registrations for on-chain batch insertion.
 *
 * Usage:
 *   node export-agent-registrations.js              # export unexported only
 *   node export-agent-registrations.js --all        # export all registrations
 *   node export-agent-registrations.js --dry-run    # preview without marking exported
 *
 * Output: JSON to stdout with affiliateCodes and referralAssignments arrays.
 * These feed into the DegenerusAffiliate constructor bootstrap arrays.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';

const args = process.argv.slice(2);
const exportAll = args.includes('--all');
const dryRun = args.includes('--dry-run');

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'degenerette.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found at', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: dryRun });

const where = exportAll ? '' : 'WHERE exported = 0';
const registrations = db.prepare('SELECT * FROM agent_registrations ' + where + ' ORDER BY created_at ASC').all();

console.error(
  'Found ' + registrations.length + ' registration(s)' +
  (exportAll ? ' (all)' : ' (unexported)') +
  (dryRun ? ' [DRY RUN]' : '')
);

if (registrations.length === 0) {
  console.log(JSON.stringify({ affiliateCodes: [], referralAssignments: [] }, null, 2));
  process.exit(0);
}

// Build code-to-address map for referral resolution
const codeToAddress = {};
for (const reg of registrations) {
  codeToAddress[reg.code] = reg.address;
}

const output = {
  affiliateCodes: [],
  referralAssignments: [],
};

for (const reg of registrations) {
  const codeBytes32 = ethers.encodeBytes32String(reg.code);

  output.affiliateCodes.push({
    owner: ethers.getAddress(reg.address),
    code: reg.code,
    codeBytes32,
    rakebackPct: reg.rakeback_pct,
    pledgeEth: reg.pledge_eth,
    registeredAt: reg.created_at,
  });

  if (reg.referrer) {
    const referrerCode = reg.referrer.toUpperCase();
    if (codeToAddress[referrerCode]) {
      output.referralAssignments.push({
        player: ethers.getAddress(reg.address),
        referrerCode,
        referrerCodeBytes32: ethers.encodeBytes32String(referrerCode),
        referrerAddress: ethers.getAddress(codeToAddress[referrerCode]),
      });
    }
  }
}

console.log(JSON.stringify(output, null, 2));

if (!dryRun && registrations.length > 0) {
  const ids = registrations.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare('UPDATE agent_registrations SET exported = 1 WHERE id IN (' + placeholders + ')').run(...ids);
  console.error('Marked ' + ids.length + ' registration(s) as exported.');
}

db.close();

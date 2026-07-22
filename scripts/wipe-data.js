#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

function wipe() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('Created empty data directory');
    return;
  }

  for (const entry of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, entry);
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`Removed ${entry}`);
  }

  console.log('All saved data wiped');
}

wipe();

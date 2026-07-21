#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const releasesDir = path.join(root, 'releases');
const apkSource = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const apkDest = path.join(releasesDir, 'poll-scheduler.apk');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || root, env: { ...process.env, ...opts.env } });
}

if (!fs.existsSync(path.join(root, 'android'))) {
  run('npx cap add android');
}

run('npx cap sync android');

const gradlew = path.join(root, 'android', 'gradlew');
run(`chmod +x "${gradlew}"`);
run('./gradlew assembleDebug', {
  cwd: path.join(root, 'android'),
  env: {
    ANDROID_HOME: process.env.ANDROID_HOME,
    JAVA_HOME: process.env.JAVA_HOME,
  },
});

if (!fs.existsSync(apkSource)) {
  console.error('APK build failed — output not found');
  process.exit(1);
}

fs.mkdirSync(releasesDir, { recursive: true });
fs.copyFileSync(apkSource, apkDest);
console.log(`\nAPK ready: ${apkDest}`);

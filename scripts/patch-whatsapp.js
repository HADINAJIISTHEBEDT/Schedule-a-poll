const fs = require('fs');
const path = require('path');

const utilsPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js'
);

if (!fs.existsSync(utilsPath)) {
  console.log('whatsapp-web.js not installed, skipping patch');
  process.exit(0);
}

let content = fs.readFileSync(utilsPath, 'utf8');
let changed = false;

const patches = [
  {
    from: 'await groupMetadata.update(chatWid);',
    to: `if (groupMetadata?.update) {
                await groupMetadata.update(chatWid);
            }`,
  },
  {
    from: 'await newsletterMetadata.update(chat.id);',
    to: `if (newsletterMetadata?.update) {
                await newsletterMetadata.update(chat.id);
            }`,
  },
];

for (const patch of patches) {
  if (content.includes(patch.from)) {
    content = content.replace(patch.from, patch.to);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(utilsPath, content);
  console.log('Applied whatsapp-web.js getChats patch');
} else {
  console.log('whatsapp-web.js patch already applied or not needed');
}

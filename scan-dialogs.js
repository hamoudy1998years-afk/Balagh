const fs = require('fs');
const path = require('path');

function scanDir(dir, results = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() && file !== 'node_modules' && file !== '.git') {
      scanDir(fullPath, results);
    } else if (file.endsWith('.js') && !file.includes('node_modules')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/Modal|Alert\.alert|ModernDialog/.test(line)) {
          results.push({
            file: fullPath.replace(process.cwd() + '\\', ''),
            line: idx + 1,
            code: line.trim()
          });
        }
      });
    }
  });
  return results;
}

const results = scanDir(process.cwd());
console.log('=== DIALOG USAGE SCAN ===\n');
results.forEach(r => {
  console.log(`${r.file}:${r.line}`);
  console.log(`  ${r.code}`);
  console.log('');
});
console.log(`\nTotal: ${results.length} dialog usages`);
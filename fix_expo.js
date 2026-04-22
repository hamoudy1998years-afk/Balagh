const fs = require('fs');
const file = 'node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt';
let c = fs.readFileSync(file, 'utf8');
if (!c.includes('@file:Suppress')) {
  c = '@file:Suppress("OPT_IN_USAGE")\n' + c;
  fs.writeFileSync(file, c);
  console.log('Done');
} else {
  console.log('Already fixed');
}
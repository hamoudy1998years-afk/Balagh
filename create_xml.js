const fs = require('fs');
const path = 'android/app/src/main/res/xml';

if (!fs.existsSync(path)) {
  fs.mkdirSync(path, { recursive: true });
}

fs.writeFileSync(path + '/secure_store_data_extraction_rules.xml', 
`<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" path="."/>
  </cloud-backup>
</data-extraction-rules>`);

fs.writeFileSync(path + '/secure_store_backup_rules.xml',
`<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <exclude domain="sharedpref" path="."/>
</full-backup-content>`);

console.log('Done');
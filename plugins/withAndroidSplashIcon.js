const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withAndroidSplashIcon(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;

      const filesToPatch = [
        path.join(platformRoot, 'app/src/main/res/values/styles.xml'),
        path.join(platformRoot, 'app/src/main/res/values-v31/styles.xml'),
      ];

      for (const filePath of filesToPatch) {
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf8');
          content = content.replace(
            '<item name="windowSplashScreenAnimatedIcon">@android:color/transparent</item>',
            '<item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>'
          );
          fs.writeFileSync(filePath, content);
        }
      }

      return config;
    },
  ]);
};

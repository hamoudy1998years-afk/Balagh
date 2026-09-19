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

      const searchString = '<item name="windowSplashScreenAnimatedIcon">@android:color/transparent</item>';
      const replaceString = '<item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>';

      for (const filePath of filesToPatch) {
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf8');

          if (!content.includes(searchString)) {
            throw new Error(
              `withAndroidSplashIcon: expected string not found in ${filePath}. ` +
              `The file may have changed format (e.g. a new Expo/AGP version) and this plugin needs updating.`
            );
          }

          content = content.replace(searchString, replaceString);
          fs.writeFileSync(filePath, content);
        }
      }

      return config;
    },
  ]);
};
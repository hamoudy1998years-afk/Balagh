const { withAndroidStyles, createRunOncePlugin } = require('@expo/config-plugins');

const withForceLightStatusBar = (config) => {
  return withAndroidStyles(config, (config) => {
    const { modResults } = config;
    const { resources } = modResults;
    const appTheme = resources.style?.find(
      style => style.$.name === 'AppTheme'
    );
    if (appTheme) {
      if (!appTheme.item) appTheme.item = [];

      // Remove existing entry first to avoid duplicates
      appTheme.item = appTheme.item.filter(
        i => i.$.name !== 'android:windowLightStatusBar'
      );

      // Then add fresh - false = WHITE icons on dark background
      appTheme.item.push({
        $: { name: 'android:windowLightStatusBar' },
        _: 'false'
      });
    }
    return config;
  });
};

module.exports = createRunOncePlugin(
  withForceLightStatusBar,
  'withForceLightStatusBar'
);

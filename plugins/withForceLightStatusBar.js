const { withAndroidStyles, createRunOncePlugin } = require('@expo/config-plugins');

const withForceLightStatusBar = (config) => {
  return withAndroidStyles(config, (config) => {
    const { modResults } = config;
    const { resources } = modResults;
    const appTheme = resources.style?.find(
      style => style.$.name === 'AppTheme'
    );
    if (appTheme) {
      appTheme.item = [
        ...(appTheme.item || []),
        { $: { name: 'android:windowLightStatusBar' }, _: 'false' }
      ];
    }
    return config;
  });
};

module.exports = createRunOncePlugin(
  withForceLightStatusBar,
  'withForceLightStatusBar'
);

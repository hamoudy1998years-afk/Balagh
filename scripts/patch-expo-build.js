const fs = require('fs');
const path = require('path');

// Patch 1: Generator template - add @Suppress to class
const generatorPath = path.join(__dirname, '..', 'node_modules', 'expo-modules-autolinking', 'android', 'expo-gradle-plugin', 'expo-autolinking-plugin', 'src', 'main', 'kotlin', 'expo', 'modules', 'plugin', 'GeneratePackagesListTask.kt');
if (fs.existsSync(generatorPath)) {
  let content = fs.readFileSync(generatorPath, 'utf8');
  
  // Remove any old @file:Suppress from generator
  content = content.replace(/@file:Suppress\([^)]+\)\\n\\n/, '');
  
  // Add @Suppress to class in template
  if (!content.includes('@Suppress')) {
    content = content.replace(
      'class ExpoModulesPackageList : ModulesProvider {',
      '@Suppress("OPT_IN_USAGE")\\nclass ExpoModulesPackageList : ModulesProvider {'
    );
    fs.writeFileSync(generatorPath, content);
    console.log('Patched GeneratePackagesListTask.kt');
  } else {
    console.log('Generator already patched');
  }
}

// Patch 2: Also patch existing generated file
const generatedPath = path.join(__dirname, '..', 'node_modules', 'expo', 'android', 'build', 'generated', 'expo', 'src', 'main', 'java', 'expo', 'modules', 'ExpoModulesPackageList.kt');
if (fs.existsSync(generatedPath)) {
  let content = fs.readFileSync(generatedPath, 'utf8');
  content = content.replace(/@file:Suppress\([^)]+\)\s*\n\s*\n?/, '');
  if (!content.includes('@Suppress')) {
    content = content.replace(
      'class ExpoModulesPackageList : ModulesProvider {',
      '@Suppress("OPT_IN_USAGE")\nclass ExpoModulesPackageList : ModulesProvider {'
    );
    fs.writeFileSync(generatedPath, content);
    console.log('Patched ExpoModulesPackageList.kt');
  } else {
    console.log('Generated file already patched');
  }
}

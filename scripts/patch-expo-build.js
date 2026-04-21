const fs = require('fs');
const path = require('path');

const gradlePath = path.join(__dirname, '..', 'node_modules', 'expo', 'android', 'build.gradle');
if (!fs.existsSync(gradlePath)) {
  console.log('expo/android/build.gradle not found, skipping');
  process.exit(0);
}

let content = fs.readFileSync(gradlePath, 'utf8');

// Already patched?
if (content.includes('tasks.whenTaskAdded')) {
  console.log('expo build.gradle already patched');
  process.exit(0);
}

// Remove old afterEvaluate block if exists
content = content.replace(/afterEvaluate\s*\{[\s\S]*?\n\}\s*$/, '');

// Add the fix
content += `\n\ntasks.whenTaskAdded { task ->
    if (task.name == "compileDebugKotlin" || task.name == "compileReleaseKotlin") {
        task.doFirst {
            def generatedFile = file("build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt")
            if (generatedFile.exists()) {
                def content = generatedFile.text
                if (!content.contains("@file:Suppress")) {
                    def packageDecl = "package expo.modules"
                    def newContent = content.replace(packageDecl, "@file:Suppress(\\"OPT_IN_USAGE\\", \\"OPT_IN_USAGE_ERROR\\")\\n\\n" + packageDecl)
                    generatedFile.text = newContent
                    println "Patched ExpoModulesPackageList.kt for " + task.name
                }
            }
        }
        
        task.kotlinOptions {
            freeCompilerArgs += ["-opt-in=kotlin.RequiresOptIn"]
            allWarningsAsErrors = false
        }
    }
}
`;

fs.writeFileSync(gradlePath, content);
console.log('Patched expo/android/build.gradle successfully');

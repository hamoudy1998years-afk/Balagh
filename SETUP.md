# Balagh App Setup Guide

## Fix for Android Build Error (Kotlin 2.1.20)

Create this file on your computer:
C:\Users\<your-username>\.gradle\init.d\expo-fix.gradle

With this content:

gradle.taskGraph.whenReady { graph ->
    graph.allTasks
        .findAll { it.name == 'compileDebugKotlin' && it.project.name == 'expo' }
        .each { task ->
            task.doFirst {
                def file = new File(task.project.buildDir, 'generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt')
                if (file.exists()) {
                    def content = file.text
                    content = content.replaceAll(/@file:Suppress\([^)]*\)/, '')
                    file.text = '@file:Suppress(OPT_IN_USAGE, OPT_IN_USAGE_ERROR, EXPERIMENTAL_API_USAGE, EXPERIMENTAL_IS_NOT_ENABLED)' + content.trim()
                }
            }
        }
}

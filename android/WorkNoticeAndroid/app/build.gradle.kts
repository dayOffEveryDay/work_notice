plugins { id("com.android.application") }
val firebaseConfigured = file("google-services.json").exists()
if (firebaseConfigured) apply(plugin = "com.google.gms.google-services")
android {
    namespace = "com.worknotice.alarm"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.worknotice.alarm"
        minSdk = 26
        targetSdk = 37
        versionCode = 11
        versionName = "0.4.1.2"
        buildConfigField("boolean", "FIREBASE_CONFIGURED", firebaseConfigured.toString())
        buildConfigField("String", "API_BASE", "\"https://work-notice-api.hui760419.workers.dev\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes { release { isMinifyEnabled = false } }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime:2.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
}
// Gradle's Windows @classpath file uses the native charset. COMPAT in
// gradle.properties fixes non-ASCII paths; source files remain explicitly UTF-8.
tasks.withType<JavaCompile>().configureEach { options.encoding = "UTF-8" }

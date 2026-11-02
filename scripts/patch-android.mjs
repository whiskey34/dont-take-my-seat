// Adjusts the generated Capacitor Android project for this game:
// landscape only and full screen.
// Run after `npx cap add android` (the CI does this on every APK build).
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
const stylesPath = 'android/app/src/main/res/values/styles.xml';

function patch(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`patch-android: nothing changed in ${path}; the Capacitor template may have changed`);
  writeFileSync(path, after);
}

patch(manifestPath, (xml) => {
  if (xml.includes('android:screenOrientation')) return xml;
  return xml.replace(/<activity(\s)/, '<activity android:screenOrientation="sensorLandscape"$1');
});

patch(stylesPath, (xml) => {
  const extra = '        <item name="android:windowFullscreen">true</item>\n        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>\n';
  return xml.replace(/(<style name="AppTheme\.(?:NoActionBar|NoActionBarLaunch)"[^>]*>\n)/g, `$1${extra}`);
});

console.log('patch-android: landscape + fullscreen applied');

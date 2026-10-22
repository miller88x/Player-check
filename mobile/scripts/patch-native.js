// Adds the permission text and settings the stores require, after `cap add` creates the native projects.
const fs = require("fs");
const path = require("path");

// iOS: permission prompts (Apple rejects apps without clear reasons)
const plist = path.join(__dirname, "../ios/App/App/Info.plist");
if (fs.existsSync(plist)) {
  let s = fs.readFileSync(plist, "utf8");
  const add = {
    NSLocationWhenInUseUsageDescription: "Rova uses your location for turn-by-turn directions, nearby camera and road alerts, and parking rules where you are.",
    NSCameraUsageDescription: "Rova uses the camera so you can photograph a parking sign and have it read for you.",
    NSPhotoLibraryUsageDescription: "Rova lets you pick a photo of a parking sign or a ticket from your library.",
  };
  for (const [k, v] of Object.entries(add)) if (!s.includes(`<key>${k}</key>`)) s = s.replace("<dict>", `<dict>\n\t<key>${k}</key>\n\t<string>${v}</string>`);
  if (!s.includes("<key>ITSAppUsesNonExemptEncryption</key>")) s = s.replace("<dict>", "<dict>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>");
  fs.writeFileSync(plist, s);
  console.log("iOS Info.plist patched");
}

// Android: location + camera permissions
const manifest = path.join(__dirname, "../android/app/src/main/AndroidManifest.xml");
if (fs.existsSync(manifest)) {
  let s = fs.readFileSync(manifest, "utf8");
  for (const p of ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "CAMERA", "POST_NOTIFICATIONS"]) {
    const line = `<uses-permission android:name="android.permission.${p}" />`;
    if (!s.includes(`android.permission.${p}"`)) s = s.replace("</manifest>", `    ${line}\n</manifest>`);
  }
  fs.writeFileSync(manifest, s);
  console.log("Android manifest patched");
}

// Android: Firebase config for phone notifications (google-services.json from the Rova Firebase project)
const gs = path.join(__dirname, "../google-services.json"), gsTo = path.join(__dirname, "../android/app/google-services.json");
if (fs.existsSync(gs) && fs.existsSync(path.dirname(gsTo))) { fs.copyFileSync(gs, gsTo); console.log("Android google-services.json added"); }

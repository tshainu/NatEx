const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = path.resolve(__dirname, "package.json");
const backupPath = path.resolve(__dirname, ".eas-autolinking-package-backup");
const merchantOnlyModules = ["expo-text-extractor", "expo-file-system"];

function applyVariantAutolinking() {
  const source = fs.existsSync(backupPath)
    ? fs.readFileSync(backupPath, "utf8")
    : fs.readFileSync(packageJsonPath, "utf8");
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, source);

  const packageJson = JSON.parse(source);
  packageJson.expo ??= {};
  packageJson.expo.autolinking ??= {};

  const currentExclusions = Array.isArray(packageJson.expo.autolinking.exclude)
    ? packageJson.expo.autolinking.exclude.filter((name) => typeof name === "string")
    : [];
  const isMerchant = process.env.APP_VARIANT === "merchant";
  packageJson.expo.autolinking.exclude = isMerchant
    ? currentExclusions.filter((name) => !merchantOnlyModules.includes(name))
    : [...new Set([...currentExclusions, ...merchantOnlyModules])];

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function restorePackageJson() {
  if (!fs.existsSync(backupPath)) return;
  fs.writeFileSync(packageJsonPath, fs.readFileSync(backupPath, "utf8"));
  fs.unlinkSync(backupPath);
}

if (process.argv[2] === "restore") {
  restorePackageJson();
} else if (process.argv[2] === "apply") {
  applyVariantAutolinking();
} else {
  console.error("Usage: node configure-autolinking.js <apply|restore>");
  process.exitCode = 2;
}

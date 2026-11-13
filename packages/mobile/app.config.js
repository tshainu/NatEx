const baseConfig = require("./app.json").expo;

function withPluginOptions(plugins, pluginName, update) {
  return plugins.map((plugin) => {
    if (Array.isArray(plugin) && plugin[0] === pluginName) {
      return [pluginName, update(plugin[1] ?? {})];
    }
    return plugin;
  });
}

module.exports = ({ config = {} } = {}) => {
  const expo = { ...baseConfig, ...config };
  const isMerchant = process.env.APP_VARIANT === "merchant";

  if (!isMerchant) {
    return {
      ...expo,
      android: {
        ...expo.android,
        softwareKeyboardLayoutMode: "pan",
      },
      extra: { ...expo.extra, appVariant: "field" },
    };
  }

  let plugins = expo.plugins ?? [];
  plugins = withPluginOptions(plugins, "expo-splash-screen", (options) => ({
    ...options,
    image: "./assets/merchant/splash.png",
    backgroundColor: "#176B2C",
  }));
  plugins = withPluginOptions(plugins, "expo-camera", (options) => ({
    ...options,
    cameraPermission: "NatEx Merchant uses the camera to scan parcel tracking barcodes.",
  }));
  plugins = withPluginOptions(plugins, "expo-image-picker", (options) => ({
    ...options,
    cameraPermission: "NatEx uses the camera only for delivery-related parcel images.",
  }));

  return {
    ...expo,
    name: "NatEx Merchant",
    scheme: "natex-merchant",
    icon: "./assets/merchant/launcher-1024.png",
    android: {
      ...expo.android,
      package: "com.natex.merchant",
      icon: "./assets/merchant/launcher-1024.png",
      adaptiveIcon: {
        ...expo.android?.adaptiveIcon,
        foregroundImage: "./assets/merchant/adaptive-foreground.png",
        backgroundColor: "#176B2C",
        monochromeImage: "./assets/merchant/adaptive-monochrome.png",
      },
    },
    extra: { ...expo.extra, appVariant: "merchant" },
    plugins,
  };
};
